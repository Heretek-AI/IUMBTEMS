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

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '../..');
const MCP_SERVER = path.join(PKG_ROOT, 'runner', 'mcp_server.py');

/** Plugin version tracks package.json so it cannot drift across releases. */
let PKG_VERSION = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8'));
  if (pkg && typeof pkg.version === 'string') PKG_VERSION = pkg.version;
} catch {
  // keep fallback; version is informational only
}

/** Uniform dispatch: one-shot MCP call, return OpenCode's {content, status}. */
function callMcp(tool, args = {}, cwd) {
  const res = spawnSync(
    'python3',
    [MCP_SERVER, 'call', tool, JSON.stringify(args || {})],
    {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
      env: { ...process.env, PYTHONPATH: PKG_ROOT },
    }
  );
  return {
    content: res.stdout || res.stderr,
    status: res.status === 0 ? 'success' : 'error',
  };
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
    template: [
      'Run an IUMBTEMS dialectic research swarm.',
      'Objective: $ARGUMENTS',
      '1. If the objective is ambiguous, frame it first via iumbtems_socratic_frontier.',
      '2. Execute iumbtems_swarm_research with {"objective": "<objective>"} (pass "mock_mode": true only for dry runs).',
      '3. Summarize .research/final_synthesis.md, preserving [VERIFIED:<hash>] pointers.',
    ].join('\n'),
  },
  {
    name: 'grill',
    description: 'Launch Socratic grilling and decision tree frontier exploration',
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
    template: [
      'Inspect or update the Epistemic Swarm configuration.',
      'Arguments: $ARGUMENTS (may be empty to inspect current settings)',
      'Call iumbtems_config; map --engine/--depth/--mode/--show style flags to search_engine/max_iterations/mode, or pass through no arguments to inspect.',
    ].join('\n'),
  },
  {
    name: 'audit',
    description: 'Run dialectic codebase architectural and security audit with line-level proof',
    template: [
      'Run an IUMBTEMS dialectic codebase audit (structural architect vs adversarial red-teamer).',
      'Target: $ARGUMENTS (path, component, or empty for full-repository architecture and vulnerability audit)',
      '1. Execute iumbtems_code_audit with {"target": "<target>"} (pass "mock_mode": true only for dry runs).',
      '2. Summarize .research/code_audit_report.md with line-level proof pointers.',
    ].join('\n'),
  },
  {
    name: 'scout',
    description: 'Scout open-source libraries, audit copyleft licenses, generate clean-room blueprints',
    template: [
      'Scout open-source solutions for the requested capability.',
      'Feature: $ARGUMENTS',
      '1. Execute iumbtems_oss_scout with {"feature": "<feature>"} (pass "mock_mode": true only for dry runs).',
      '2. Report mature candidates, GPL/AGPL copyleft risks, and the clean-room blueprint in .research/oss_scout_report.md.',
    ].join('\n'),
  },
  {
    name: 'brainstorming',
    description: 'Lateral brainstorming: novel feature vectors, paradigm inversions, falsifiable spikes',
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
    template: [
      'Alias for /brainstorming: run lateral brainstorming (divergent what-if ideation, never bug-fix lists).',
      'Prompt: $ARGUMENTS (defaults to "Where do we go from here?" when empty)',
      'Execute iumbtems_brainstorm with {"objective": "<prompt>"} and report feature vectors, paradigm inversions, and falsifiable spikes.',
    ].join('\n'),
  },
];

/**
 * Register the command catalog into an OpenCode config object without
 * overwriting user-defined commands of the same name. Exported for tests.
 */
export function registerOpenCodeCommands(cfg = {}) {
  cfg.command ??= {};
  for (const cmd of OPENCODE_COMMANDS) {
    if (cfg.command[cmd.name]) continue;
    cfg.command[cmd.name] = { description: cmd.description, template: cmd.template };
  }
  return cfg;
}

/** Tool map (object form) for the server hook; array catalog stays canonical. */
function buildToolMap() {
  return Object.fromEntries(
    TOOL_CATALOG.map((tool) => [
      tool.name,
      {
        ...tool,
        options: { codemode: false },
        execute: async (args = {}, toolContext) =>
          callMcp(tool.name, normalizeArgs(tool.name, args), toolContext?.cwd),
      },
    ])
  );
}

export function createOpenCodePlugin(context = {}) {
  return {
    id: 'heretek.iumbtems.epistemic-swarm',
    name: 'IUMBTEMS Epistemic Swarm',
    version: PKG_VERSION,
    description:
      'I Use My Brain To Express My Self: High-integrity dialectic research, code audits, and open-source scouting',

    server: async () => ({
      // Config hook: slash-command catalog (mirrors the goal plugin's
      // registerDesktopCommands pattern; never overwrites user commands).
      config: (cfg) => registerOpenCodeCommands(cfg),
      // Tool map (object form, as in the reference implementation).
      tool: buildToolMap(),
    }),

    setup: async (appContext) => {
      const opts = context.options || appContext?.options;
      if (opts && typeof opts === 'object') {
        const updates = {};
        if (opts.search_engine) updates.search_engine = opts.search_engine;
        if (opts.max_iterations) updates.max_iterations = opts.max_iterations;
        if (opts.mode) updates.mode = opts.mode;
        if (opts.divergence_threshold !== undefined) {
          updates.divergence_threshold = opts.divergence_threshold;
        }
        if (Object.keys(updates).length > 0) {
          callMcp('iumbtems_config', updates, appContext?.cwd);
        }
      }
      return { initialized: true, platform: 'opencode-v2' };
    },
  };
}

const defaultPlugin = createOpenCodePlugin();
export default defaultPlugin;
