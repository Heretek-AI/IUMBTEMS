/**
 * Antigravity Hook Bus & Quality Gates Bridge.
 *
 * Connects Antigravity's lifecycle events (PreToolUse, PostToolUse, PreInvocation, Stop)
 * to IUMBTEMS's 6-event Hook Bus and the three automated Quality Gates:
 * 1. Analysis Bridge (Biome CLI static analysis for JS/TS)
 * 2. Dependency Health Gate (OSV.dev vulnerability & freshness scanner)
 * 3. Weight Signals (esbuild bundle weight & coverage deltas vs baseline)
 *
 * Also provides:
 * - Pre-commit gating on .research/config.json with optimistic concurrency (expected_hash)
 * - Session context & compaction preservation (buildCompactionContext)
 * - Living dossier claim degradation stop-gating
 *
 * Contract:
 * - Zero runtime dependencies; node builtins only.
 * - Fail-open: internal errors log and allow, never throwing into host.
 */

import {
  createHookBus,
  gatePreCommit,
  FAST_TIMEOUT_MS,
  SLOW_TIMEOUT_MS,
  normalizeVerdictEx,
} from '../opencode/hook-bus.js';
import { registerAnalysisBridge } from '../opencode/analysis-bridge.js';
import { registerDepHealth } from '../opencode/dep-health.js';
import { registerWeightSignals } from '../opencode/weight-signals.js';
import { buildCompactionContext, readLedgerDegraded } from '../opencode/index.js';
import { loadConfig, validateConfig } from '../opencode/config-io.js';
import { existsSync, readFileSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export function resolveWorkspaceRoot(payload = {}) {
  const ws = payload.workspacePaths || [];
  if (Array.isArray(ws) && ws.length > 0 && ws[0]) {
    return path.resolve(ws[0]);
  }
  if (payload.workspaceRoot) {
    return path.resolve(payload.workspaceRoot);
  }
  if (process.env.IUMBTEMS_WORKSPACE) {
    return path.resolve(process.env.IUMBTEMS_WORKSPACE);
  }
  if (process.env.IUMBTEMS_ROOT) {
    return path.resolve(process.env.IUMBTEMS_ROOT);
  }
  let curr = path.resolve(process.cwd());
  while (curr !== path.dirname(curr)) {
    if (existsSync(path.join(curr, '.research')) || existsSync(path.join(curr, '.git'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return path.resolve(process.cwd());
}

/**
 * Instantiate a hook bus populated with all quality gate subscribers.
 */
export async function createConfiguredBus(root) {
  const bus = createHookBus();
  const mockHost = {
    location: { directory: root },
    session: {
      hook: () => ({ dispose: () => {} }),
      prompt: () => Promise.resolve(),
    },
  };

  try {
    await registerAnalysisBridge(mockHost, { bus, root });
  } catch {
    /* fail open */
  }

  try {
    await registerDepHealth(mockHost, { bus, root });
  } catch {
    /* fail open */
  }

  try {
    await registerWeightSignals(mockHost, { bus });
  } catch {
    /* fail open */
  }

  return bus;
}

/**
 * Handle pre-tool-use:
 * - Check pre-commit gating on .research/config.json
 * - Emit pre-tool-use on the bus (Analysis Bridge)
 */
export async function handlePreTool(payload = {}) {
  const root = resolveWorkspaceRoot(payload);
  const toolCall = payload.toolCall || {};
  const toolName = String(toolCall.name || '').toLowerCase();
  const args = toolCall.args || {};

  // Check if tool is attempting to edit .research/config.json
  const targetFile = String(args.TargetFile || args.file || args.path || '');
  const isConfigTarget =
    targetFile.endsWith('.research/config.json') ||
    targetFile === '.research/config.json' ||
    (targetFile.includes('.research') && targetFile.includes('config.json'));

  if (isConfigTarget && (toolName === 'write_to_file' || toolName === 'replace_file_content')) {
    const bus = createHookBus();
    const content = args.CodeContent || args.ReplacementContent || '';
    let parsedUpdates = null;
    try {
      parsedUpdates = JSON.parse(content);
    } catch {
      // If content is not full JSON (e.g. replace_file_content chunk), attempt validation if possible
    }

    if (parsedUpdates && typeof parsedUpdates === 'object') {
      const problems = validateConfig(parsedUpdates);
      if (problems && problems.length > 0) {
        return {
          decision: 'deny',
          allowed: false,
          reason: `Pre-commit validation rejected .research/config.json update: ${problems.join('; ')}`,
        };
      }

      const preCommitResult = await gatePreCommit(bus, {
        updates: parsedUpdates,
        root,
        expected_hash: args.expected_hash || args.expectedHash || parsedUpdates.expected_hash || parsedUpdates.expectedHash,
      });

      if (!preCommitResult.allowed) {
        return {
          decision: 'deny',
          allowed: false,
          reason: `Pre-commit gate denied config write: ${preCommitResult.reason || 'optimistic concurrency or validation failure'}`,
        };
      }
    }
  }

  const bus = await createConfiguredBus(root);
  const busResult = await bus.emit('pre-tool-use', {
    tool: toolName,
    args,
    sessionID: payload.conversationId,
    targetFile,
  });

  if (!busResult.allowed) {
    return {
      decision: 'deny',
      allowed: false,
      reason: busResult.reason || 'Blocked by Hook Bus pre-tool-use policy',
      annotations: busResult.annotations || [],
    };
  }

  return {
    decision: 'allow',
    allowed: true,
    annotations: busResult.annotations || [],
  };
}

/**
 * Handle post-tool-use:
 * - Emit post-tool-use on the bus (triggers Analysis Bridge, Dep Health, Weight Signals)
 * - Persist annotations to .research/quality_gates.jsonl
 */
export async function handlePostTool(payload = {}) {
  const root = resolveWorkspaceRoot(payload);
  const toolCall = payload.toolCall || {};
  const toolName = String(toolCall.name || '').toLowerCase();
  const args = toolCall.args || {};
  const targetFile = String(args.TargetFile || args.file || args.path || '');

  const bus = await createConfiguredBus(root);
  const busResult = await bus.emit('post-tool-use', {
    tool: toolName,
    args,
    result: payload.result,
    error: payload.error,
    sessionID: payload.conversationId,
    targetFile,
  });

  const annotations = busResult.annotations || [];
  if (annotations.length > 0) {
    try {
      const qgLog = path.join(root, '.research', 'quality_gates.jsonl');
      const lines = annotations.map((a) =>
        JSON.stringify({
          at: new Date().toISOString(),
          stepIdx: payload.stepIdx,
          tool: toolName,
          annotation: a,
        })
      );
      appendFileSync(qgLog, lines.join('\n') + '\n', 'utf-8');
    } catch {
      /* ignore file log error */
    }
  }

  return {
    allowed: busResult.allowed !== false,
    annotations,
  };
}

/**
 * Handle pre-invocation:
 * - Return compaction context from buildCompactionContext
 * - Collect and clear any pending quality gate annotations
 */
export async function handlePreInvocation(payload = {}) {
  const root = resolveWorkspaceRoot(payload);
  const compaction = buildCompactionContext(root);

  let pendingAnnotations = [];
  const qgLog = path.join(root, '.research', 'quality_gates.jsonl');
  if (existsSync(qgLog)) {
    try {
      const content = readFileSync(qgLog, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.annotation) {
            pendingAnnotations.push(entry.annotation);
          }
        } catch {
          /* ignore bad json line */
        }
      }
      // Truncate the file so annotations are reported once
      writeFileSync(qgLog, '', 'utf-8');
    } catch {
      /* fail open */
    }
  }

  return {
    compactionContext: compaction,
    annotations: pendingAnnotations,
  };
}

/**
 * Handle stop:
 * - Emit stop on the bus
 * - Check degraded claims in .research/ledger/claim_status.json
 */
export async function handleStop(payload = {}) {
  const root = resolveWorkspaceRoot(payload);

  // If a STOP file was placed, allow immediately
  if (existsSync(path.join(root, '.factory', 'STOP'))) {
    return { decision: 'allow', allowed: true };
  }

  const bus = await createConfiguredBus(root);
  const busResult = await bus.emit('stop', {
    sessionID: payload.conversationId,
    terminationReason: payload.terminationReason,
  });

  if (!busResult.allowed) {
    return {
      decision: 'continue',
      allowed: false,
      reason: busResult.reason || 'Blocked by Hook Bus stop policy',
    };
  }

  const degraded = readLedgerDegraded(root);
  const total = (degraded.stale || []).length + (degraded.suspect || []).length;
  if (total > 0) {
    return {
      decision: 'continue',
      allowed: false,
      reason: `Epistemic audit warning: ${total} claims are degraded (${degraded.stale.length} STALE, ${degraded.suspect.length} SUSPECT) due to source retractions. Review before finishing.`,
    };
  }

  return { decision: 'allow', allowed: true };
}

/**
 * CLI dispatcher for subprocess calls.
 */
async function main() {
  const action = process.argv[2] || 'pre_tool';
  let inputData = '';

  if (process.argv[3]) {
    inputData = process.argv[3];
  } else {
    try {
      inputData = readFileSync(0, 'utf-8');
    } catch {
      inputData = '{}';
    }
  }

  let payload = {};
  try {
    payload = JSON.parse(inputData.trim() || '{}');
  } catch {
    payload = {};
  }

  let result = {};
  try {
    if (action === 'pre_tool' || action === 'pre-tool-use') {
      result = await handlePreTool(payload);
    } else if (action === 'post_tool' || action === 'post-tool-use') {
      result = await handlePostTool(payload);
    } else if (action === 'pre_invocation' || action === 'session-start') {
      result = await handlePreInvocation(payload);
    } else if (action === 'stop') {
      result = await handleStop(payload);
    } else {
      result = { decision: 'allow', allowed: true };
    }
  } catch (err) {
    result = {
      decision: 'allow',
      allowed: true,
      error: String(err?.message || err),
    };
  }

  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && process.argv[1].endsWith('hook_bus_bridge.js')) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ decision: 'allow', allowed: true }));
  });
}
