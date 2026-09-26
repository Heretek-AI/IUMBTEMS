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
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '../..');
const MCP_SERVER = path.join(PKG_ROOT, 'runner', 'mcp_server.py');

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
          description: 'Path to .research workspace',
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
        base_dir: { type: 'string' },
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
        base_dir: { type: 'string' },
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
        base_dir: { type: 'string' },
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
        base_dir: { type: 'string' },
        out: { type: 'string', description: 'Output path (default <base_dir>/brief.pcrb.json)' },
        objective: { type: 'string' },
        key: { type: 'string', description: 'HMAC key (prefer key_file or env IUMBTEMS_PCRB_KEY)' },
        key_file: { type: 'string' },
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
        key: { type: 'string' },
        key_file: { type: 'string' },
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

export function createOpenCodePlugin(context = {}) {
  return {
    id: 'heretek.iumbtems.epistemic-swarm',
    name: 'IUMBTEMS Epistemic Swarm',
    version: '0.3.0',
    description:
      'I Use My Brain To Express My Self: High-integrity dialectic research, code audits, and open-source scouting',

    server: (toolContext) =>
      TOOL_CATALOG.map((tool) => ({
        ...tool,
        options: { codemode: false },
        execute: async (args = {}) =>
          callMcp(tool.name, normalizeArgs(tool.name, args), toolContext?.cwd),
      })),

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
