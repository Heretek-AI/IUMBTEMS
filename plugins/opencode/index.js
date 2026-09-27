/**
 * IUMBTEMS: I Use My Brain To Express My Self
 * Native Plugin for OpenCode V2 (opencode.ai)
 *
 * THIN REGISTRATION (Stream A2b): this plugin no longer implements tools.
 * Every tool forwards to the canonical first-party MCP surface:
 *
 *   python3 runner/mcp_server.py call <tool> '<json>'
 *
 * The plugin exists only so OpenCode V2 hosts can discover the iumbtems_*
 * catalog. Schemas mirror runner/mcp_server.py build_tools() — keep in sync.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '../..');
const MCP_SERVER = path.join(PKG_ROOT, 'runner', 'mcp_server.py');

function resolveBinary(name) {
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir || dir === '.' || dir.startsWith('./') || dir.startsWith('../')) continue;
    const full = path.join(dir, name);
    try {
      // Match Node's own PATH search: skip non-files and non-executables so a
      // directory or a non-executable named `python3` earlier on PATH cannot
      // shadow the real binary.
      if (!statSync(full).isFile()) continue;
      accessSync(full, constants.X_OK);
      return realpathSync(full);
    } catch {
      /* not present, not a file, or not executable — keep searching */
    }
  }
  return name;
}

/** Plugin version tracks package.json so it cannot drift across releases. */
let PKG_VERSION = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8'));
  if (pkg && typeof pkg.version === 'string') PKG_VERSION = pkg.version;
} catch {
  // keep fallback; version is informational only
}

/**
 * Uniform dispatch: one-shot MCP call, return OpenCode's {content, status}.
 * Async (non-blocking spawn) so long swarms/audits never freeze the host
 * event loop; cancellation remains the host's prerogative.
 */
function callMcp(tool, args = {}, cwd = undefined) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (content, status) => {
      if (settled) return;
      settled = true;
      resolve({ content, status });
    };
    let child;
    try {
      child = spawn(
        resolveBinary('python3'),
        [MCP_SERVER, 'call', tool, JSON.stringify(args || {})],
        {
          cwd: cwd || process.cwd(),
          env: { ...process.env, PYTHONPATH: PKG_ROOT },
        }
      );
    } catch (err) {
      done(String(err?.message || err), 'error');
      return;
    }
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => done(String(err?.message || err), 'error'));
    child.on('close', (code) => done(stdout || stderr, code === 0 ? 'success' : 'error'));
  });
}

/** Catalog mirrors runner/mcp_server.py build_tools(). */
export const IUMBTEMS_TOOL_NAMES = [
  'iumbtems_config',
  'iumbtems_swarm_research',
  'iumbtems_code_audit',
  'iumbtems_oss_scout',
  'iumbtems_brainstorm',
  'iumbtems_verify_quote',
  'iumbtems_socratic_frontier',
  'iumbtems_reindex_claims',
  'iumbtems_report_retraction',
  'iumbtems_check_staleness',
  'iumbtems_set_domain_pack',
  'iumbtems_export_brief',
  'iumbtems_verify_brief',
];

// Deprecated misspelled alias (pre-A2b export). Remove in a semver-major.
export const IUMBEMS_TOOL_NAMES = IUMBTEMS_TOOL_NAMES;

const TOOL_CATALOG = [
  {
    name: 'iumbtems_config',
    description:
      'Inspect or modify the active Epistemic Swarm configuration (search engine, depth/iterations, operating mode, divergence threshold) in .research/config.json.',
    input: {
      type: 'object',
      properties: {
        search_engine: {
          type: 'string',
          enum: ['duckduckgo', 'brave', 'firecrawl', 'searxng'],
          description: 'Primary search engine (duckduckgo is the zero-key free default)',
        },
        max_iterations: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Maximum dialectic research iterations / depth (1-4)',
        },
        mode: {
          type: 'string',
          enum: ['research', 'audit', 'scout', 'hybrid', 'brainstorm'],
          description: 'Operating mode: research (literature), audit (codebase), scout (OSS), hybrid, brainstorm (lateral ideation)',
        },
        divergence_threshold: {
          type: 'number',
          minimum: 0.0,
          maximum: 1.0,
          description: 'Auditor divergence threshold (default 0.75)',
        },
        show: {
          type: 'boolean',
          description: 'Just inspect current configuration without modifying',
          default: false,
        },
      },
    },
  },
  {
    name: 'iumbtems_swarm_research',
    description:
      'Execute an autonomous dialectic research swarm on an objective using Agent Alpha (Thesis) and Agent Beta (Red Team). Long-running; blocks until the swarm completes.',
    input: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'The research question or hypothesis to investigate',
        },
        mock_mode: {
          type: 'boolean',
          description: 'Run in mock/dry-run mode without external API charges',
          default: false,
        },
      },
      required: ['objective'],
    },
  },
  {
    name: 'iumbtems_code_audit',
    description:
      'Run a dialectic codebase architectural and security audit pairing a structural architect with an adversarial red-teamer.',
    input: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Target directory, file, or architectural component to audit',
        },
        mock_mode: {
          type: 'boolean',
          description: 'Run in mock mode without invoking LLM tokens',
          default: false,
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'iumbtems_oss_scout',
    description:
      'Scout open-source software libraries, benchmark candidate implementations, red-team viral copyleft (GPL/AGPL), and produce clean-room implementation blueprints.',
    input: {
      type: 'object',
      properties: {
        feature: {
          type: 'string',
          description: 'The feature, algorithm, or capability to scout in open source',
        },
        mock_mode: {
          type: 'boolean',
          description: 'Run in mock mode without invoking LLM tokens',
          default: false,
        },
      },
      required: ['feature'],
    },
  },
  {
    name: 'iumbtems_brainstorm',
    description:
      'Run lateral brainstorming: novel feature vectors, paradigm inversions, and falsifiable spike hypotheses (never bug-fix lists).',
    input: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: "Ambiguous exploration prompt (e.g. 'Where do we go from here?')",
        },
        mock_mode: {
          type: 'boolean',
          description: 'Run in mock/dry-run mode without external API charges',
          default: false,
        },
      },
      required: ['objective'],
    },
  },
  {
    name: 'iumbtems_verify_quote',
    description:
      'Cryptographically verify whether a cited quote matches verbatim text inside the content-addressed source cache.',
    input: {
      type: 'object',
      properties: {
        hash: {
          type: 'string',
          description: 'SHA-256 hash or prefix of the cached source',
        },
        quote: {
          type: 'string',
          description: 'The verbatim excerpt to verify',
        },
      },
      required: ['hash', 'quote'],
    },
  },
  {
    name: 'iumbtems_socratic_frontier',
    description: 'Inspect or advance the Socratic grilling decision frontier for research framing.',
    input: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'Research objective to inspect',
        },
        settle_node: {
          type: 'string',
          description: 'Optional node ID to settle with an answer',
        },
        settle_answer: {
          type: 'string',
          description: 'Answer for the settled node',
        },
      },
    },
  },
  {
    name: 'iumbtems_reindex_claims',
    description:
      'Rebuild the derived claims.sqlite index from .research flat files (idempotent; flat files are source of truth).',
    input: {
      type: 'object',
      properties: {
        base_dir: {
          type: 'string',
          description: 'Path to .research workspace (default: current directory)',
        },
      },
    },
  },
  {
    name: 'iumbtems_report_retraction',
    description:
      'Record a RETRACTED/REVISED event for a cached source; dependent VERIFIED claims degrade to STALE/SUSPECT on the next audit (Living Dossiers).',
    input: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: 'Content-addressed SHA-256 of the affected source' },
        event: { type: 'string', enum: ['RETRACTED', 'REVISED'] },
        note: { type: 'string', description: 'Why the source was retracted/revised' },
        base_dir: { type: 'string', description: 'Path to .research workspace (default: current directory)' },
      },
      required: ['hash', 'event'],
    },
  },
  {
    name: 'iumbtems_check_staleness',
    description:
      'Run one claim-degradation pass: join claims against retraction events, write the status ledger, and queue re-runs for degraded scopes. Never mutates dossiers.',
    input: {
      type: 'object',
      properties: {
        base_dir: { type: 'string', description: 'Path to .research workspace (default: current directory)' },
        scope_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit the pass to specific scopes',
        },
      },
    },
  },
  {
    name: 'iumbtems_set_domain_pack',
    description:
      'Activate a Regulated Domain Pack (biopharma/quant/legal epistemic constitution) for subsequent audits.',
    input: {
      type: 'object',
      properties: {
        pack: { type: 'string', description: 'Pack id: biopharma | quant | legal (or a path)' },
        base_dir: { type: 'string', description: 'Path to .research workspace (default: current directory)' },
      },
      required: ['pack'],
    },
  },
  {
    name: 'iumbtems_export_brief',
    description:
      'Export a proof-carrying research brief (PCRB): self-contained signed bundle of synthesis, claims, quote witnesses, and full source texts.',
    input: {
      type: 'object',
      properties: {
        base_dir: { type: 'string', description: 'Path to .research workspace (default: current directory)' },
        out: { type: 'string', description: 'Output path (default <base_dir>/brief.pcrb.json)' },
        objective: { type: 'string', description: 'Research objective the brief must cover' },
        key: { type: 'string', description: 'HMAC key (prefer key_file or env IUMBTEMS_PCRB_KEY)' },
        key_file: { type: 'string', description: 'Path to file containing the HMAC key' },
      },
    },
  },
  {
    name: 'iumbtems_verify_brief',
    description:
      'Verify a proof-carrying brief against its BUNDLED sources: manifest integrity, HMAC signature, and every quote re-checked. Exit-fail semantics; no trust in the producing LLM.',
    input: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'Path to brief.pcrb.json' },
        key: { type: 'string', description: 'HMAC key (prefer key_file or env IUMBTEMS_PCRB_KEY)' },
        key_file: { type: 'string', description: 'Path to file containing the HMAC key' },
      },
      required: ['brief'],
    },
  },
];

/** Legacy arg shims -> MCP handler contract. */
function normalizeArgs(tool, args = {}) {
  const a = { ...args };
  if (a.mock_mode && a.mock_claude === undefined) {
    a.mock_claude = a.mock_mode;
    delete a.mock_mode;
  }
  if (a.show) {
    delete a.show; // read-only inspect is the no-op default of iumbtems_config
  }
  if (tool === 'iumbtems_socratic_frontier') {
    if (a.settle_node && a.settle_answer) {
      a.settle = [a.settle_node, a.settle_answer];
      delete a.settle_node;
      delete a.settle_answer;
    }
    if (!a.file) {
      a.file = '.research/frontier.json';
    }
  }
  return a;
}

/**
 * OpenCode slash-command catalog (Phase A discoverability).
 *
 * Mirrors the Pi/OMP/Gemini command surface. Each entry registers into
 * `config.command[name] = {description, template}` via the server `config`
 * hook (same pattern as @prevalentware/opencode-goal-plugin). `$ARGUMENTS`
 * is the raw text after the slash command. Templates instruct the agent to
 * call the corresponding canonical `iumbtems_*` tool — commands never
 * reimplement tool logic.
 */
export const OPENCODE_COMMANDS = [
  {
    name: 'swarm',
    description: 'Run IUMBTEMS dialectic research swarm on an objective',
    usage: '/swarm <objective>',
    template: [
      'Run an IUMBTEMS dialectic research swarm.',
      'Objective: $ARGUMENTS',
      'If $ARGUMENTS is empty, ask the user for the research objective first; never call the tool with placeholder, empty, or literal "<objective>" arguments.',
      '1. If the objective is ambiguous, frame it first via iumbtems_socratic_frontier.',
      '2. Execute iumbtems_swarm_research with {"objective": "<objective>"} (pass "mock_mode": true only for dry runs).',
      '3. Summarize .research/final_synthesis.md, preserving [VERIFIED:<hash>] pointers.',
    ].join('\n'),
  },
  {
    name: 'grill',
    description: 'Launch Socratic grilling and decision tree frontier exploration',
    usage: '/grill [--objective <text>]',
    template: [
      'Launch Socratic grilling on the decision frontier.',
      'Objective: $ARGUMENTS (may be empty to inspect the current frontier)',
      'Call iumbtems_socratic_frontier with {"objective": "<objective>", "file": ".research/frontier.json"}; omit "objective" to inspect.',
      'Challenge premises, invert assumptions, and report open frontier nodes.',
    ].join('\n'),
  },
  {
    name: 'swarm-config',
    description: 'Inspect or update Epistemic Swarm parameters (engine, depth, mode)',
    usage: '/swarm-config [--engine <e>] [--depth <d>] [--mode <m>] [--show]',
    template: [
      'Inspect or update the Epistemic Swarm configuration.',
      'Arguments: $ARGUMENTS (may be empty to inspect current settings)',
      'Call iumbtems_config; map --engine/--depth/--mode/--show style flags to search_engine/max_iterations/mode, or pass through no arguments to inspect.',
    ].join('\n'),
  },
  {
    name: 'audit',
    description: 'Run dialectic codebase architectural and security audit with line-level proof',
    usage: '/audit <target_path_or_scope>',
    template: [
      'Run an IUMBTEMS dialectic codebase audit (structural architect vs adversarial red-teamer).',
      'Target: $ARGUMENTS (path, component, or empty for full-repository architecture and vulnerability audit)',
      'If $ARGUMENTS names a path that does not exist, ask the user to clarify the target first; never audit a placeholder path.',
      '1. Execute iumbtems_code_audit with {"target": "<target>"} (pass "mock_mode": true only for dry runs).',
      '2. Summarize .research/code_audit_report.md with line-level proof pointers.',
    ].join('\n'),
  },
  {
    name: 'scout',
    description: 'Scout open-source libraries, audit copyleft licenses, generate clean-room blueprints',
    usage: '/scout <feature_or_algorithm>',
    template: [
      'Scout open-source solutions for the requested capability.',
      'Feature: $ARGUMENTS',
      'If $ARGUMENTS is empty, ask the user for the feature or algorithm first; never call the tool with placeholder, empty, or literal "<feature>" arguments.',
      '1. Execute iumbtems_oss_scout with {"feature": "<feature>"} (pass "mock_mode": true only for dry runs).',
      '2. Report mature candidates, GPL/AGPL copyleft risks, and the clean-room blueprint in .research/oss_scout_report.md.',
    ].join('\n'),
  },
  {
    name: 'brainstorming',
    description: 'Lateral brainstorming: novel feature vectors, paradigm inversions, falsifiable spikes',
    usage: '/brainstorming <ambiguous-prompt>',
    template: [
      'Run lateral brainstorming (divergent what-if ideation, never bug-fix lists).',
      'Prompt: $ARGUMENTS (defaults to "Where do we go from here?" when empty)',
      '1. Execute iumbtems_brainstorm with {"objective": "<prompt>"} (pass "mock_mode": true only for dry runs).',
      '2. Report novel feature vectors, paradigm inversions, and falsifiable spikes from .research/brainstorm_report.md.',
    ].join('\n'),
  },
  {
    name: 'brainstorm',
    description: 'Alias for /brainstorming',
    usage: '/brainstorm <ambiguous-prompt>',
    template: [
      'Alias for /brainstorming: run lateral brainstorming (divergent what-if ideation, never bug-fix lists).',
      'Prompt: $ARGUMENTS (defaults to "Where do we go from here?" when empty)',
      'Execute iumbtems_brainstorm with {"objective": "<prompt>"} and report feature vectors, paradigm inversions, and falsifiable spikes.',
    ].join('\n'),
  },
];

/**
 * Command catalog shaped for a declarative opencode config.
 *
 * V2's schema key is `commands` (plural) — `command` is the deprecated V1 key
 * and is ignored by a V2 host. Registration on a live V2 host goes through
 * `command.transform` instead of this; this exists so tests and docs can assert
 * the catalog shape and the correct key.
 */
export function commandCatalog() {
  const out = {};
  for (const cmd of OPENCODE_COMMANDS) {
    if (!cmd?.name) continue;
    out[cmd.name] = { description: cmd.description, template: cmd.template };
  }
  return out;
}

/** Tool map (object form) for the server hook; array catalog stays canonical. */
function buildToolMap() {
  return Object.fromEntries(
    TOOL_CATALOG.map((tool) => [
      tool.name,
      {
        ...tool,
        options: { codemode: false },
        execute: async (args = {}, toolContext = undefined) =>
          callMcp(tool.name, normalizeArgs(tool.name, args), toolContext?.cwd),
      },
    ])
  );
}

/**
 * Phase C retention: session lifecycle hooks.
 *
 * Reference pattern: @prevalentware/opencode-goal-plugin subscribes via
 * `context.event.subscribe({signal})`, detects idle as `session.idle` or an
 * idle `session.status`, continues via `context.session.prompt`, and preserves
 * state across compaction with `context.session.hook("compaction", ...)`.
 * Every hook here is best-effort and never throws into the host.
 */

/** Idle detection matching the reference implementation. Exported for tests. */
export function isIdleEvent(event) {
  if (!event || typeof event.type !== 'string') return false;
  if (event.type === 'session.idle') return true;
  const status = event.properties?.status;
  return (
    event.type === 'session.status' &&
    typeof status === 'object' &&
    status !== null &&
    status.type === 'idle'
  );
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

function parseLedgerEntries(ledger) {
  const stale = [];
  const suspect = [];
  const last = new Map();
  for (const e of ledger) {
    if (typeof e?.claim_id === 'string') last.set(e.claim_id, e.to_status);
  }
  for (const [id, s] of last) {
    if (s === 'STALE') stale.push(id);
    else if (s === 'SUSPECT') suspect.push(id);
  }
  const lastAt = ledger.at(-1)?.at ?? '';
  return { stale, suspect, fingerprint: `${ledger.length}:${lastAt}` };
}

/** Last-write-wins degraded claims + requeue list. Pure fs reads. */
export function readLedgerDegraded(root) {
  const out = { stale: [], suspect: [], requeued: [], fingerprint: 'empty' };
  try {
    const ledger = readJsonFile(path.join(root, '.research', 'ledger', 'claim_status.json'));
    if (Array.isArray(ledger)) {
      const parsed = parseLedgerEntries(ledger);
      out.stale = parsed.stale;
      out.suspect = parsed.suspect;
      out.fingerprint = parsed.fingerprint;
    }
    const requeue = readJsonFile(path.join(root, '.research', 'requeue.json'));
    if (Array.isArray(requeue)) {
      out.requeued = requeue.map((e) => e?.scope_id).filter((s) => typeof s === 'string');
    }
  } catch {
    /* unreadable workspace -> no degraded claims */
  }
  return out;
}

/**
 * Compaction context preserving .research state. Returns null when there is
 * no workspace (hook then pushes nothing).
 */
export function buildCompactionContext(root) {
  try {
    const cfg = readJsonFile(path.join(root, '.research', 'config.json'));
    if (!cfg || typeof cfg !== 'object') return null;
    const degraded = readLedgerDegraded(root);
    const lines = [
      'IUMBTEMS Epistemic Swarm workspace state (preserved across compaction):',
      `- mode=${cfg.mode ?? '?'} engine=${cfg.search_engine ?? '?'} depth=${cfg.max_iterations ?? '?'}`,
      `- degraded claims: ${degraded.stale.length} STALE, ${degraded.suspect.length} SUSPECT`,
    ];
    if (degraded.stale.length > 0) {
      lines.push(`- STALE claim ids: ${degraded.stale.slice(0, 10).join(', ')}`);
    }
    if (degraded.requeued.length > 0) {
      lines.push(`- scopes queued for re-run: ${degraded.requeued.slice(0, 10).join(', ')}`);
    }
    lines.push('- Continue with iumbtems_check_staleness when resuming audit work.');
    return lines.join('\n');
  } catch {
    return null;
  }
}

const NUDGE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const activeNudges = new Map();
// Cleanup functions for the setup() disposer (a setup that returns a plain
// object crashes host reload: the host calls the return value as a cleanup
// function). All setup-owned resources register here.
const setupCleanups = new Set();

/**
 * Handle one subscribed event: nudge once per ledger change when degraded
 * claims exist. Returns true when a nudge was sent. Exported for tests.
 */
export function handleIdleEvent(host, root, state, event) {
  try {
    if (!isIdleEvent(event)) return false;
    const sessionID = event?.properties?.sessionID ?? event?.sessionID;
    if (typeof sessionID !== 'string' || !sessionID) return false;
    const now = Date.now();
    if (now - (state.lastNudgeAt || 0) < NUDGE_MIN_INTERVAL_MS) return false;
    const degraded = readLedgerDegraded(root);
    const total = degraded.stale.length + degraded.suspect.length;
    if (total === 0) return false;
    if (state.lastFingerprint === degraded.fingerprint) return false;
    state.lastFingerprint = degraded.fingerprint;
    state.lastNudgeAt = now;
    const example = degraded.stale.slice(0, 5).join(', ');
    Promise.resolve(
      host.session.prompt({
        sessionID,
        text:
          `IUMBTEMS staleness nudge: ${total} degraded claim(s) ` +
          `(${degraded.stale.length} STALE, ${degraded.suspect.length} SUSPECT) in .research/ledger/claim_status.json` +
          (example ? `, e.g. ${example}` : '') +
          '. Run iumbtems_check_staleness and re-audit affected scopes, or reply that it is already handled.',
      })
    ).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Subscribe to session events for idle nudges. One subscription per root. */
export function startStalenessNudge(host, root) {
  try {
    if (!host || typeof host.event?.subscribe !== 'function') return null;
    if (typeof host.session?.prompt !== 'function') return null;
    if (activeNudges.has(root)) return activeNudges.get(root).stop;
    const abort = new AbortController();
    const state = { lastFingerprint: null, lastNudgeAt: 0 };
    const stop = () => {
      try { abort.abort(); } catch { /* noop */ }
      activeNudges.delete(root);
    };
    activeNudges.set(root, { stop });
    (async () => {
      try {
        const sub = host.event.subscribe({ signal: abort.signal });
        const it = sub[Symbol.asyncIterator]();
        while (true) {
          const { value, done } = await it.next();
          if (done) break;
          handleIdleEvent(host, root, state, value);
        }
      } catch {
        /* aborted or host closed the stream */
      }
      activeNudges.delete(root);
    })();
    return stop;
  } catch {
    return null;
  }
}

/**
 * Plugin log. Never throws.
 *
 * Before this existed every setup block swallowed errors with a bare
 * `catch {}`, so `--log-level all` showed only host-side symptoms and a
 * registration failure was indistinguishable from success.
 */
function log(host, level, message, detail) {
  let text = message;
  if (detail !== undefined) {
    try {
      text = `${message} ${JSON.stringify(detail)}`;
    } catch {
      text = `${message} [unserialisable detail]`;
    }
  }
  try {
    const sink = host?.client?.app?.log;
    if (typeof sink === 'function') {
      Promise.resolve(sink.call(host.client.app, {
        body: { service: 'iumbtems', level, message: text },
      })).catch(() => {});
      return;
    }
  } catch {
    /* fall through to console */
  }
  try {
    (console.error || console.log)(`[iumbtems] ${level}: ${text}`);
  } catch {
    /* logging must never throw into the host */
  }
}

function errDetail(err) {
  return { error: String(err?.message ?? err) };
}

async function registerHostCommands(host) {
  if (typeof host?.command?.transform !== 'function') return [];

  // Snapshot which names are already taken *at setup time*. This snapshot is
  // COPIED into the transform callback on every invocation and never grown.
  //
  // The host replays this callback on each command-registry rebuild, and the
  // rebuilt registry starts from base config — so if the callback mutates a
  // shared "already added" set, the second replay sees all six names as taken
  // and adds nothing. That is exactly why the slash commands appeared at
  // startup and vanished seconds later, and why only a full process restart
  // brought them back (fresh setup -> fresh set).
  //
  // The reference plugin (@prevalentware/opencode-goal-plugin) gets this right
  // with `const claimed = new Set(existingCommands)` inside the callback.
  let existingNames = new Set();
  try {
    const listed = await host.command.list();
    existingNames = new Set((listed?.data || []).map((c) => c?.name));
  } catch (err) {
    log(host, 'warn', 'command.list() failed; assuming an empty registry', errDetail(err));
  }

  const registration = await host.command.transform((draft) => {
    const claimed = new Set(existingNames); // fresh copy per replay
    const added = [];
    for (const cmd of OPENCODE_COMMANDS) {
      if (!cmd?.name || claimed.has(cmd.name)) continue;
      claimed.add(cmd.name);
      added.push(cmd.name);
      draft.add({
        name: cmd.name,
        description: cmd.description,
        execute: async (input) => {
          const args = input?.prompt?.text || '';
          const prompt = (typeof input?.prompt === 'object' && input?.prompt !== null) ? input.prompt : {};
          await host.session.prompt({
            ...prompt,
            sessionID: input?.sessionID,
            text: cmd.template.split('$ARGUMENTS').join(String(args).trim()),
            delivery: input?.delivery,
          });
        },
      });
    }
    log(host, 'debug', 'command.transform pass', {
      added,
      skippedAsPreexisting: [...existingNames].filter((n) => !added.includes(n)),
    });
  });

  // Force materialisation now instead of waiting for the host's own later
  // reconcile (which is the pass that used to wipe them).
  try {
    if (typeof host.command.reload === 'function') await host.command.reload();
    log(host, 'info', 'slash commands registered', { count: OPENCODE_COMMANDS.length });
  } catch (err) {
    log(host, 'warn', 'command.reload() failed', errDetail(err));
  }

  return registration ? [registration] : [];
}

async function registerHostTools(host) {
  if (typeof host?.tool?.transform !== 'function') return [];
  const registration = await host.tool.transform((draft) => {
    for (const [name, spec] of Object.entries(buildToolMap())) {
      draft.add({
        name,
        description: spec.description,
        input: spec.input,
        options: { codemode: false },
        execute: async (args = {}, toolContext = undefined) => {
          const r = await callMcp(name, normalizeArgs(name, args), toolContext?.cwd);
          return { content: r.content };
        },
      });
    }
    log(host, 'debug', 'tool.transform pass', { count: Object.keys(buildToolMap()).length });
  });
  try {
    if (typeof host.tool.reload === 'function') await host.tool.reload();
  } catch (err) {
    log(host, 'warn', 'tool.reload() failed', errDetail(err));
  }
  return registration ? [registration] : [];
}

/**
 * V2 compaction hook: keep .research state across context compaction.
 *
 * The V1 equivalent (`experimental.session.compacting`) lived in the old
 * `server()` hook and was dead code on V2 — compaction silently lost the
 * swarm state. Shape follows the reference plugin: push a text part onto
 * `event.system`.
 */
async function registerCompactionHook(host, context) {
  const hook = host?.session?.hook || context?.session?.hook;
  if (typeof hook !== 'function') return [];
  try {
    const registration = await hook.call(host.session || context.session, 'compaction', async (event) => {
      try {
        const root =
          event?.directory || host.location?.directory || context.location?.directory || event?.cwd;
        if (!root) return;
        const text = buildCompactionContext(root);
        if (!text) return;
        const system = Array.isArray(event?.system) ? event.system : null;
        if (!system) return;
        // Idempotent: the host may invoke this more than once per session.
        if (system.some((part) => part?.type === 'text' && part?.text === text)) return;
        system.push({ type: 'text', text });
      } catch (err) {
        log(host, 'warn', 'compaction hook failed', errDetail(err));
      }
    });
    return registration ? [registration] : [];
  } catch (err) {
    log(host, 'warn', 'session.hook("compaction") unavailable', errDetail(err));
    return [];
  }
}

async function applyConfigOptions(host, opts, context) {
  if (!opts || typeof opts !== 'object') return;
  const updates = {};
  if (opts.search_engine) updates.search_engine = opts.search_engine;
  if (opts.max_iterations) updates.max_iterations = opts.max_iterations;
  if (opts.mode) updates.mode = opts.mode;
  if (opts.divergence_threshold !== undefined) {
    updates.divergence_threshold = opts.divergence_threshold;
  }
  if (Object.keys(updates).length > 0) {
    await callMcp(
      'iumbtems_config',
      updates,
      host.location?.directory || context.location?.directory || host.cwd
    );
    log(host, 'debug', 'applied tuple options via iumbtems_config', updates);
  }
}

function startNudgeSubscription(host, opts, context, cleanups) {
  if (!(opts?.staleness_nudge ?? true)) return;
  const nudgeHost = {
    event: host.event || context.event,
    session: host.session || context.session,
  };
  const root = host.location?.directory || context.location?.directory;
  if (root) {
    const stop = startStalenessNudge(nudgeHost, root);
    if (typeof stop === 'function') cleanups.add(stop);
    log(host, 'debug', 'staleness nudge subscription', { root, started: typeof stop === 'function' });
  }
}

export function createOpenCodePlugin(context = {}) {
  return {
    id: 'heretek.iumbtems.epistemic-swarm',
    name: 'IUMBTEMS Epistemic Swarm',
    version: PKG_VERSION,
    description:
      'I Use My Brain To Express My Self: High-integrity dialectic research, code audits, and open-source scouting',

    // V2 only. The V1 `server()` factory and its `config` hook wrote the
    // deprecated `command` key (V2's schema is `commands`), so they registered
    // nothing on a V2 host — and carrying both shapes meant the real
    // registration path had to guess which host it was talking to.
    setup: async (appContext) => {
      const host = appContext || {};
      const opts = context.options || host.options;
      // Transform registrations must precede any slow work: the host may
      // reconcile past a slow setup and never see the commands.
      const registrations = [];
      const adopt = (list) => {
        for (const r of list || []) if (r) registrations.push(r);
      };

      log(host, 'info', 'iumbtems setup', {
        version: PKG_VERSION,
        directory: host.location?.directory || context.location?.directory || null,
      });

      try {
        adopt(await registerHostCommands(host));
      } catch (err) {
        log(host, 'error', 'registering slash commands failed', errDetail(err));
      }
      try {
        adopt(await registerHostTools(host));
      } catch (err) {
        log(host, 'error', 'registering tools failed', errDetail(err));
      }
      try {
        adopt(await registerCompactionHook(host, context));
      } catch (err) {
        log(host, 'error', 'registering compaction hook failed', errDetail(err));
      }
      // Slow work AFTER registration.
      try {
        await applyConfigOptions(host, opts, context);
      } catch (err) {
        log(host, 'warn', 'applying tuple options failed', errDetail(err));
      }
      try {
        startNudgeSubscription(host, opts, context, setupCleanups);
      } catch (err) {
        log(host, 'warn', 'starting staleness nudge failed', errDetail(err));
      }

      // The host calls this on unload/reload. It MUST be a function: returning
      // a plain object used to abort the whole plugin reload with
      // `TypeError: de is not a function`, dropping every registration.
      return async () => {
        let disposed = 0;
        for (const registration of registrations) {
          try {
            await registration.dispose();
            disposed += 1;
          } catch (err) {
            log(host, 'warn', 'registration.dispose() failed', errDetail(err));
          }
        }
        registrations.length = 0;
        let stopped = 0;
        for (const stop of setupCleanups) {
          try {
            stop();
            stopped += 1;
          } catch (err) {
            log(host, 'warn', 'cleanup failed', errDetail(err));
          }
        }
        setupCleanups.clear();
        log(host, 'info', 'iumbtems disposed', { registrations: disposed, nudges: stopped });
      };
    },
  };
}

const defaultPlugin = createOpenCodePlugin();
export default defaultPlugin;
