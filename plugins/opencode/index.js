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
import {
  accessSync,
  appendFileSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  loadConfigFromRaw,
  mergeConfig,
  readConfigSnapshot,
  readRawConfig,
  resolveExpectedHash,
  validateConfig,
} from './config-io.js';
import {
  createHookBus,
  gatePreCommit,
  registerHookBus,
} from './hook-bus.js';
import {
  registerAnalysisBridge,
} from './analysis-bridge.js';
import {
  registerDepHealth,
} from './dep-health.js';
import {
  registerWeightSignals,
} from './weight-signals.js';

/**
 * Shared hook bus (Phase 01-hook-bus-spec). Six blockable events with tiered
 * fast-short/slow-long enforcement + audit log; fail-open, never throws.
 *
 * Phase evidence: transform-shaped registrations + the `tool.execute.before`
 * gap [VERIFIED: sha256:52ac5b4d26062cfc6093440faa415ab152f8acd0d18c4496eb0087ed18a27d76
 * `file:///home/john/Projects/IUMBTEMS/plugins/opencode/index.js`:1038-1126];
 * setup adopt pattern [VERIFIED: same hash, `:2714-2750`].
 *
 * Per-event enforcement points (fix-round docs; see docs/HOOK_BUS_PARITY.md):
 * - `pre-tool-use` / `post-tool-use`: ENFORCED in `registerHostTools`
 *   `execute` for this plugin's OWN tools — a fast/slow tier-table deny
 *   blocks execution (pre) or suppresses delivery (post). Host-NATIVE tools
 *   (webfetch/websearch) have no `tool.execute.before` point, so they are
 *   NOT gated — same gap class as the upstream ask, documented not implied.
 * - `pre-commit`: ENFORCED on both write legs — the settings-RPC `set`
 *   (`createSettingsHandlers().set`) and the TUI direct-fs fallback
 *   (`gateDirectFsPreCommit` in `tui.js`). Stale-write guards stay downstream.
 * - `session-start`: ADVISORY BY DESIGN — emitted in the compaction hook, a
 *   deny is audit-logged but never drops the state push. Never counted as a
 *   deny-blocks host path.
 * - `stop` / `notification`: BUS-LEVEL ONLY — no host interception point
 *   exists yet, so deny-blocks holds at `bus.emit` (direct subscribers) and
 *   no host action is gated. No claim here implies host blocking.
 *
 * Caller-latency contract (GOAL §5/§6): `emit` runs tiers concurrently with
 * each handler bounded by its tier budget, so a call resolves within
 * max(fastBudget, slowBudget) + epsilon — a hung slow handler costs the
 * caller at most the slow budget (default 5000 ms), never indefinitely.
 */
export const hookBus = createHookBus();

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
          // Host hint: the runner defaults to the host-native backend
          // (opencode run here), unless the caller passes backend explicitly.
          // Project root: evidence defaults under <project>/.research instead
          // of the server process cwd.
          env: {
            ...process.env,
            PYTHONPATH: PKG_ROOT,
            IUMBTEMS_HOST: 'opencode',
            IUMBTEMS_PROJECT_DIR: cwd || process.cwd(),
          },
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
  'iumbtems_darkharvest',
  'iumbtems_factory',
  'iumbtems_verify_quote',
  'iumbtems_socratic_frontier',
  'iumbtems_reindex_claims',
  'iumbtems_report_retraction',
  'iumbtems_check_staleness',
  'iumbtems_set_domain_pack',
  'iumbtems_export_brief',
  'iumbtems_verify_brief',
  'iumbtems_doctor',
  'iumbtems_test',
];

// Deprecated misspelled alias (pre-A2b export). Remove in a semver-major.
export const IUMBEMS_TOOL_NAMES = IUMBTEMS_TOOL_NAMES;

export const TOOL_CATALOG = [
  {
    name: 'iumbtems_config',
    description:
      'Inspect or modify the active Epistemic Swarm configuration in .research/config.json. Accepts every canonical config key (search engine, depth/iterations, operating mode, divergence threshold, backends, cache policy, SearXNG URL, license whitelist, allocation, domain pack, verification policy, agent overrides); invalid values and unknown keys are rejected before anything is written. Pass expected_hash (alias expectedHash; min 8 hex chars) to guard against stale overwrites.',
    input: {
      type: 'object',
      properties: {
        base_dir: {
          type: 'string',
          description: 'Path to .research workspace (default .research)',
        },
        show: {
          type: 'boolean',
          description:
            'Inspect only; equivalent to calling with no update keys (reads are always safe). When true, the call is read-only even if update keys are present (they are reported as ignored and nothing is written; the expected_hash guard, including the dual-spelling conflict check, is not evaluated).',
          default: false,
        },
        expected_hash: {
          type: 'string',
          description:
            'Optimistic-concurrency guard: SHA-256 (or a unique prefix of at least 8 hex chars) of the config file you read. A mismatch returns a structured stale error with a fresh snapshot and writes nothing. Empty/whitespace-only spellings count as absent. Alias: `expectedHash`; if both spellings are present they must be equal after normalization (strip + lowercase) or the call is rejected.',
        },
        expectedHash: {
          type: 'string',
          description: 'Alias of `expected_hash` (camelCase); must not conflict with it.',
        },
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
        divergence_threshold: {
          type: 'number',
          minimum: 0.0,
          maximum: 1.0,
          description: 'Auditor divergence threshold (default 0.75; advisory only)',
        },
        mode: {
          type: 'string',
          enum: ['research', 'audit', 'scout', 'hybrid', 'brainstorm', 'darkharvest'],
          description: 'Operating mode: research (literature), audit (codebase), scout (OSS), hybrid, brainstorm (lateral ideation), darkharvest (competitor teardown)',
        },
        backend: {
          type: 'string',
          enum: ['auto', 'claude', 'opencode'],
          description: 'Agent runtime backend (default auto = host-native)',
        },
        cache_raw_markdown: {
          type: 'boolean',
          description: 'When false, spawned WebFetch-cache children archive nothing; true (default) keeps raw markdown copies in .research/sources.',
        },
        cache_ttl_days: {
          type: ['integer', 'null'],
          minimum: 0,
          description: 'WebFetch cache TTL override exported as IUMBTEMS_FETCH_TTL_DAYS when set; null keeps webcache per-domain policy.',
        },
        search_timeout_s: {
          type: ['number', 'null'],
          minimum: 1,
          description: 'HTTP timeout for search fetches, exported as IUMBTEMS_SEARCH_TIMEOUT_S when set; null keeps each surface built-in default.',
        },
        searxng_url: {
          type: ['string', 'null'],
          pattern: '^https?://[^\\s/]+\\S*$',
          description: 'Base URL of a self-hosted SearXNG, exported as SEARXNG_URL when set; must include an http:// or https:// scheme and a host, with no whitespace anywhere; null leaves the environment untouched.',
        },
        license_whitelist: {
          type: 'array',
          items: { type: 'string' },
          description: 'SPDX ids darkharvest may depend on or vendor (default MIT, Apache-2.0, BSD-3-Clause, ISC).',
        },
        output_dir: {
          type: 'string',
          description: 'DEPRECATED: display-only. The workspace is selected by base_dir, never by this key.',
        },
        allocation: {
          type: 'string',
          enum: ['dag', 'auction'],
          description: 'Scope allocation policy: dag = legacy dependency order, auction = Frontier Markets.',
        },
        domain_pack: {
          type: ['string', 'null'],
          minLength: 1,
          pattern: '^\\S(.*\\S)?$',
          description: 'Regulated Domain Pack id (config/domain_packs/) or null for the legacy constitution; the empty string, whitespace-only strings, and ids with leading/trailing whitespace are rejected.',
        },
        verify: {
          type: 'object',
          description: 'Quote-verification policy (applies to the next audit run and iumbtems_verify_quote).',
          properties: {
            min_fuzzy_confidence: {
              type: 'number',
              minimum: 0.0,
              maximum: 1.0,
              description: 'Minimum word-overlap confidence for the fuzzy quote match (default 0.88).',
            },
          },
        },
        agents: {
          type: 'object',
          description: 'Per-role backend overrides; unknown roles and role keys are preserved.',
          properties: {
            alpha: {
              type: 'object',
              properties: {
                backend: {
                  type: ['array', 'null'],
                  items: { type: 'string' },
                  description: "Argv list for this role (e.g. ['claude','-p'] or ['opencode','run']); null falls through to the host-native default.",
                },
                model: {
                  type: ['string', 'null'],
                  description: 'Model id passed to the backend as --model.',
                },
                opencode_agent: {
                  type: ['string', 'null'],
                  description: 'Optional named opencode agent profile for `opencode run --agent`; null inlines the prompt instead.',
                },
              },
            },
            beta: {
              type: 'object',
              properties: {
                backend: {
                  type: ['array', 'null'],
                  items: { type: 'string' },
                  description: "Argv list for this role (e.g. ['claude','-p'] or ['opencode','run']); null falls through to the host-native default.",
                },
                model: {
                  type: ['string', 'null'],
                  description: 'Model id passed to the backend as --model.',
                },
                opencode_agent: {
                  type: ['string', 'null'],
                  description: 'Optional named opencode agent profile for `opencode run --agent`; null inlines the prompt instead.',
                },
              },
            },
          },
        },
        opencode_auto: {
          type: ['boolean', 'null'],
          description: 'Whether spawned `opencode run` children get --auto; null uses the default (enabled; env IUMBTEMS_OPENCODE_AUTO wins).',
        },
        opencode_agent: {
          type: ['string', 'null'],
          description: 'Default named opencode agent profile for all roles; per-role agents.<role>.opencode_agent wins.',
        },
        mcp_servers: {
          type: 'object',
          additionalProperties: { type: 'boolean' },
          description: 'Persisted toggle map for the plugin-controllable MCP server set (bundled `iumbtems` server plus research servers declared in the project OpenCode config). Keys are server names; values are booleans (true = enabled, false = disabled). Absent keys mean enabled. Applied via ctx.mcp.transform; the catalog file config/mcp-research-servers.json is never modified.',
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
        backend: {
          type: 'string',
          enum: ['auto', 'claude', 'opencode'],
          description: 'Agent runtime backend (default auto = host-native)',
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
        backend: {
          type: 'string',
          enum: ['auto', 'claude', 'opencode'],
          description: 'Agent runtime backend (default auto = host-native)',
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
        backend: {
          type: 'string',
          enum: ['auto', 'claude', 'opencode'],
          description: 'Agent runtime backend (default auto = host-native)',
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
        backend: {
          type: 'string',
          enum: ['auto', 'claude', 'opencode'],
          description: 'Agent runtime backend (default auto = host-native)',
        },
      },
      required: ['objective'],
    },
  },
  {
    name: 'iumbtems_darkharvest',
    description:
      'Product competitor teardown: seed inspirations plus prompt, expand to adjacents, emit per-feature depend/vendor/clean-room/skip verdicts with SPDX attribution.',
    input: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'Product arena to tear down (e.g. Paseo-class agent harness competitor)',
        },
        seeds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Seed inspiration repo URLs',
        },
        maxRepos: {
          type: 'integer',
          description: 'Cap on total competitors (default 10)',
        },
        depth: {
          type: 'integer',
          description: 'Dialectic depth 1-4',
        },
        mock_mode: {
          type: 'boolean',
          description: 'Run in mock mode without invoking LLM tokens',
          default: false,
        },
        backend: {
          type: 'string',
          enum: ['auto', 'claude', 'opencode'],
          description: 'Agent runtime backend (default auto = host-native)',
        },
      },
      required: ['objective'],
    },
  },
  {
    name: 'iumbtems_factory',
    description:
      'Drive factory run state: init / phase-add / qa-record / expansion / stop / gate. State goes to <project>/.factory and <project>/.roadmap; no helper-script path needed.',
    input: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['init', 'phase-add', 'qa-record', 'expansion', 'stop', 'gate'],
        },
        action: {
          type: 'string',
          enum: ['open', 'settle', 'approve', 'waive', 'escalate', 'count'],
          description: 'Gate action (with command: gate)',
        },
        run: { type: 'string', description: 'Factory run name' },
        phase: { type: 'string', description: 'Phase id (e.g. 01-auth)' },
        goal: { type: 'string' },
        accept: { type: 'string', description: 'Semicolon-separated acceptance criteria' },
        seat: { type: 'string', description: 'QA seat (qa-a | qa-b)' },
        verdict: { type: 'string', enum: ['pass', 'fail', 'conditional'] },
        reason: { type: 'string' },
        loops: { type: 'integer', description: 'Expansion loop count (1-10)' },
        max_loops: { type: 'integer' },
        project_dir: { type: 'string', description: 'Project root (default: IUMBTEMS_PROJECT_DIR or cwd)' },
      },
      required: ['command'],
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
  {
    name: 'iumbtems_doctor',
    description:
      'Preflight health check for the resolved workspace: plugin version, backend binary, search-engine reachability, and workspace writability. Run this first when anything looks wrong.',
    input: {
      type: 'object',
      properties: {
        base_dir: { type: 'string', description: 'Project root (default: IUMBTEMS_PROJECT_DIR or cwd)' },
        mode: { type: 'string', description: 'Operating mode to report for' },
        probe: { type: 'boolean', description: 'Run a live 1-query search probe (default true)' },
      },
    },
  },
  {
    name: 'iumbtems_test',
    description:
      'Run the packaged IUMBTEMS test suite (subprocess, timeout-bounded) and report pass/fail with the tail of the output.',
    input: { type: 'object', properties: {} },
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
  {
    name: 'darkharvest',
    description: 'Product competitor teardown with per-feature harvest verdicts',
    usage: '/darkharvest <objective> [--seeds <urls>] [--max-repos <n>]',
    template: [
      'Run a product competitor teardown (seed inspirations plus prompt, expand to adjacents).',
      'Objective: $ARGUMENTS (product arena; seeds may be embedded as URLs)',
      'If $ARGUMENTS is empty, ask the user for the product arena and seed URLs first; never call the tool with placeholder arguments.',
      '1. Execute iumbtems_darkharvest with {"objective": "<objective>", "seeds": ["<url>", "..."]} (pass "mock_mode": true only for dry runs).',
      '2. Report the competitor x capability matrix, white-space gaps both ways, and the SPDX-attributed harvest backlog in .research/darkharvest_report.md.',
      '3. Legal rule: permissive-only vendor; GPL/AGPL clean-room-rebuild only; workflows clonable, assets never.',
    ].join('\n'),
  },
  {
    name: 'factory',
    description: 'Coding-factory Manager loop: grill-gated phased build with programmer spawns and dual QA',
    usage: '/factory <product-arena>',
    agent: 'manager',
    subagent: false,
    subtask: false,
    template: [
      'Run the IUMBTEMS coding-factory Manager loop as the manager agent.',
      'Arena: $ARGUMENTS',
      'If $ARGUMENTS is empty, ask the user what to build first; never proceed on placeholder input.',
      '1. Grill the user until .factory/frontier.json is settled (max 5 brainstorm+darkharvest swarm cycles per gate); explicit user approve advances each gate.',
      '2. Per gate run iumbtems_brainstorm and iumbtems_darkharvest (mock_mode only for dry runs), then synthesize .roadmap/<phase>/ GOAL.md + dossier.json (goal/evidence/acceptance/brief/verdict/hashes; every claim needs a VERIFIED hash).',
      '3. Spawn the programmer subagent per phase with the phase dossier (cite phase hashes); run qa-a and qa-b (diverged prompts) per phase; track retries with the iumbtems_factory tool (command: phase-add / qa-record; 3 failures escalate to manager). Never invoke factory helper scripts by relative path.',
      '4. Manager tiebreaks QA disagreements; explicit user sign-off closes each phase.',
      'Swarm agents use the host-native backend automatically (claude -p on Claude Code, opencode run on OpenCode). Do not debug backend selection, config pins, or binary availability as part of a gate — if a swarm call fails, report the error and continue.',
    ].join('\n'),
  },
  {
    name: 'domainexpansion',
    description: 'Autonomous agent-guided self-improvement loop over the codebase (count-flagged)',
    usage: '/domainexpansion <n>',
    agent: 'manager',
    subagent: false,
    subtask: false,
    template: [
      'Run the IUMBTEMS domain-expansion loop as the manager agent.',
      'Loops: $ARGUMENTS (integer count, max 10)',
      'If $ARGUMENTS is not a positive integer, ask the user for the loop count first.',
      '1. Bypass per-loop gates; stop on count OR .factory/STOP file OR user kill, whichever first (enforce via the iumbtems_factory tool, command: expansion, with loops/max_loops).',
      '2. Each loop: agents propose direction, quick iumbtems_brainstorm/iumbtems_darkharvest check, implement via programmer spawn, dual-QA verify.',
      '3. All expansion proposals carry the strict VERIFIED evidence bar; log every loop to .factory/state.json.',
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
    if (cmd.agent) out[cmd.name].agent = cmd.agent;
    if (cmd.subagent !== undefined) out[cmd.name].subagent = cmd.subagent;
    if (cmd.subtask !== undefined) out[cmd.name].subtask = cmd.subtask;
    if (out[cmd.name].subagent === undefined && out[cmd.name].subtask !== undefined) {
      out[cmd.name].subagent = out[cmd.name].subtask;
    }
    if (out[cmd.name].subtask === undefined && out[cmd.name].subagent !== undefined) {
      out[cmd.name].subtask = out[cmd.name].subagent;
    }
  }
  return out;
}

/** Tool map (object form) for the server hook; array catalog stays canonical.
 *
 * `hostRoot` is the host-reported project directory (host.location.directory).
 * The tool context's own cwd is absent on some host builds — observed live:
 * every dispatch fell back to process.cwd() (/home/john) and evidence escaped
 * the project tree. Prefer toolContext.cwd, then hostRoot, then process.cwd().
 */
function buildToolMap(hostRoot = undefined) {
  return Object.fromEntries(
    TOOL_CATALOG.map((tool) => [
      tool.name,
      {
        ...tool,
        options: { codemode: false },
        execute: async (args = {}, toolContext = undefined) =>
          callMcp(
            tool.name,
            normalizeArgs(tool.name, args),
            toolContext?.cwd || hostRoot
          ),
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
        ...(cmd.agent ? { agent: cmd.agent } : {}),
        ...(cmd.subagent !== undefined || cmd.subtask !== undefined
          ? {
              subagent: cmd.subagent !== undefined ? cmd.subagent : cmd.subtask,
              subtask: cmd.subtask !== undefined ? cmd.subtask : cmd.subagent,
            }
          : {}),
        execute: async (input) => {
          const args = input?.prompt?.text || '';
          const prompt = (typeof input?.prompt === 'object' && input?.prompt !== null) ? input.prompt : {};
          // Pin the declared agent for this run: the template says "as the
          // manager agent", so make that true rather than aspirational.
          let switched = false;
          if (cmd.agent) {
            switched = await switchSessionAgent(host, input?.sessionID, cmd.agent);
            log(host, 'debug', 'command agent switch', {
              command: cmd.name, agent: cmd.agent, switched,
            });
          }
          await host.session.prompt({
            ...prompt,
            sessionID: input?.sessionID,
            // No `agent` field here: V2's SessionPromptInput has none (agent
            // mentions only). Pinning happens via switchAgent above.
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
  // Accepted asymmetry (parity spec section 5): this plugin shape
  // (command/tool transform + session hooks + event subscriptions) has no
  // tool.execute.before registration point, so host webfetch/websearch calls
  // cannot be intercepted the way Claude Code's hooks/hooks.json does.
  // Steering lives in command templates (epistemic search first); a host API
  // for pre-execution guards would close this for real.
  //
  // hostRoot: the host's project directory. toolContext.cwd is absent on
  // some host builds (observed live: dispatches fell back to process.cwd()
  // = /home/john and evidence escaped the project tree), so capture the
  // host-reported directory here as the fallback.
  const hostRoot = host?.location?.directory || undefined;
  const registration = await host.tool.transform((draft) => {
    for (const [name, spec] of Object.entries(buildToolMap(hostRoot))) {
      draft.add({
        name,
        description: spec.description,
        input: spec.input,
        options: { codemode: false },
        execute: async (args = {}, toolContext = undefined) => {
          const normArgs = normalizeArgs(name, args);
          const cwd = toolContext?.cwd || hostRoot;
          // Phase 01-hook-bus-spec (fix round): `pre-tool-use` gates this
          // plugin's OWN tool executions. A tier-table deny BLOCKS the
          // `callMcp` dispatch (structured `{content}` denial, same shape as
          // a result, so the host contract is unchanged); bus faults fail
          // open. Host-NATIVE tools are NOT gated here — there is no
          // `tool.execute.before` point (see the accepted-asymmetry note
          // above); that gap is documented in docs/HOOK_BUS_PARITY.md, never
          // implied away.
          let pre = { allowed: true };
          try {
            const gated = await hookBus.emit('pre-tool-use', {
              tool: name,
              args: normArgs,
              sessionID: toolContext?.sessionID ?? null,
              eventId: toolContext?.eventId ?? null,
            });
            if (gated && gated.allowed === false) pre = { allowed: false };
          } catch {
            pre = { allowed: true };
          }
          if (pre.allowed === false) {
            return { content: `Tool execution denied by pre-tool-use hook (tool: ${name}).` };
          }
          const r = await callMcp(
            name,
            normArgs,
            cwd
          );
          // `post-tool-use`: the call already ran, so a tier-table deny
          // blocks DELIVERY — the real result is suppressed and a structured
          // `{content}` notice is returned instead (audit-logged either way).
          let post = { allowed: true };
          try {
            const gated = await hookBus.emit('post-tool-use', {
              tool: name,
              args: normArgs,
              result: (r && r.content) ?? null,
              sessionID: toolContext?.sessionID ?? null,
              eventId: toolContext?.eventId ?? null,
            });
            if (gated && gated.allowed === false) post = { allowed: false };
          } catch {
            post = { allowed: true };
          }
          if (post.allowed === false) {
            return { content: `Tool result suppressed by post-tool-use hook (tool: ${name}).` };
          }
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

// ---------------------------------------------------------------------------
// Cached search provider (Phase 03-search-anomaly, deliverables 2-4)
// ---------------------------------------------------------------------------
//
// OpenCode V2 ships four provider-backed websearch engines, each keyed by an
// env var: exa/FIRECRAWL/parallel/tavily
// [VERIFIED: 7414d12951b5bf3ca0f26853f562e6450dc1f4734e5330763b420fe173e20003].
// Console hosted websearch bills $0.01 per successful search
// [VERIFIED: 6301b3c686f9e404b0e2147ec42255c1ab923e030e1f656c90478b54481ebab6].
// A plugin registers a provider and selects it via `ctx.websearch.transform`
// with `editor.add(...)` / `editor.default.set(...)`
// [VERIFIED: dc72ef876fa6d90d288597b81806ef5129bc87deec7562081881901764bed2bd].
//
// We register ONE provider that routes through the free-first ladder:
//
//   0. host-connected provider (`/connect` integration store) -> metered
//   1. BYO provider key (exa/firecrawl/parallel/tavily/tinyfish) -> metered
//   2. self-hosted SearXNG (SEARXNG_URL)                  -> free
//   3. DuckDuckGo Lite (zero-key)                         -> free, via our Python path
//   4. Console (hosted)                                   -> metered, never implicit
//
// NAMING HONESTY: the provider id/name say "cached", but `execute` performs no
// in-memory memoisation — caching happens in the SURROUNDING evidence pipeline
// (`hasher.py cache` content-addresses the full page after an explicit host
// `webfetch`). What this provider guarantees is telemetry: every rung it runs
// appends a `query` event (with provider + status) to
// `.research/retrieval.jsonl`, so the preflight cost line is truthful for
// metered rungs and not just the DDG path.
//
// Whatever the rung, `execute` returns *hits* (title/url/content) only. Full
// page content MUST be fetched explicitly by the agent via host `webfetch` and
// cached through `python3 skills/research_cache/hasher.py cache ...`; a snippet
// alone can never witness a [VERIFIED: <hash>] claim.
//
// We never override a user's deliberate `websearch.provider` OR a provider they
// connected with `/connect`: `default.set` is called ONLY when the editor
// reports no default at all AND we know of no explicit/connected choice.

export const WEBSEARCH_PROVIDER_ID = 'iumbtems-cached';
export const WEBSEARCH_PROVIDER_NAME = 'IUMBTEMS search (cached evidence pipeline)';

const BYO_PROVIDER_KEYS = {
  exa: 'EXA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  parallel: 'PARALLEL_API_KEY',
  tavily: 'TAVILY_API_KEY',
  tinyfish: 'TINYFISH_API_KEY',
};
const FREE_WEBSEARCH_PROVIDERS = new Set(['duckduckgo', 'ddg', 'searxng']);
const METERED_WEBSEARCH_PROVIDERS = new Set([
  'brave',
  'console',
  ...Object.keys(BYO_PROVIDER_KEYS),
]);
const CONSOLE_WEBSEARCH_PROVIDER = 'console';
const RETRIEVAL_LOG_NAME = 'retrieval.jsonl';
const CONNECTED_STATE_NAME = 'websearch-state.json';
// Bound an execute() that never settles so a hung upstream cannot leave the
// host waiting forever (the host may not supply its own abort signal).
export const DEFAULT_EXECUTE_TIMEOUT_MS = 20000;

/** "free" | "metered" | "unknown" — mirrors runner/preflight.py. */
export function providerClassification(provider) {
  const key = String(provider || '').trim().toLowerCase();
  if (FREE_WEBSEARCH_PROVIDERS.has(key)) return 'free';
  if (METERED_WEBSEARCH_PROVIDERS.has(key)) return 'metered';
  return 'unknown';
}

/** First BYO provider whose API key is present, in ladder order. */
export function detectByoProvider(env = process.env) {
  for (const [provider, key] of Object.entries(BYO_PROVIDER_KEYS)) {
    if (String(env?.[key] || '').trim()) return provider;
  }
  return null;
}

/**
 * Free-first ladder. Mirrors `runner/preflight.py:resolve_search_provider` so
 * the plugin's choice and the preflight cost line agree. Console is never
 * chosen implicitly — it only surfaces when `explicit` names it. A provider the
 * user connected via `/connect` (`connected`) beats an env key because its
 * credential lives in the host's integration store, not our env.
 */
export function resolveWebsearchUpstream(env = process.env, explicit = undefined, connected = undefined) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  const explicitId = norm(explicit);
  if (explicitId) return { provider: explicitId, explicit: true, source: 'configured' };
  const connectedList = (Array.isArray(connected) ? connected : [connected])
    .map(norm)
    .filter(Boolean);
  for (const id of connectedList) {
    if (id && id !== 'duckduckgo' && id !== 'ddg' && id !== 'searxng' && id !== CONSOLE_WEBSEARCH_PROVIDER) {
      return { provider: id, explicit: false, source: 'host-connected' };
    }
  }
  const byo = detectByoProvider(env);
  if (byo) return { provider: byo, explicit: false, source: 'byo-env-key' };
  if (norm(env?.SEARXNG_URL)) {
    return { provider: 'searxng', explicit: false, source: 'searxng-url' };
  }
  return { provider: 'duckduckgo', explicit: false, source: 'zero-key-default' };
}

const KNOWN_WEBSEARCH_PROVIDER_IDS = [
  ...Object.keys(BYO_PROVIDER_KEYS),
  'searxng',
  CONSOLE_WEBSEARCH_PROVIDER,
];

/**
 * Ask the host's integration/connection store which websearch provider(s) the
 * user connected with `/connect`. Credentials live in that store, so env-var
 * only detection would miss them and could halt a run whose provider is usable.
 * Best-effort + shape-tolerant: a host without the API (or an error) yields [].
 */
export async function readConnectedWebsearchProviders(host, context = {}) {
  const connection =
    host?.integration?.connection || context?.integration?.connection;
  if (!connection || typeof connection.active !== 'function') return [];
  const found = [];
  for (const id of KNOWN_WEBSEARCH_PROVIDER_IDS) {
    try {
      const active = await connection.active(id);
      if (active) found.push(id);
    } catch {
      /* provider not connected, or the host lacks the store */
    }
  }
  return found;
}

/** Single-provider convenience for the ladder. */
export async function readConnectedWebsearchProvider(host, context = {}) {
  const found = await readConnectedWebsearchProviders(host, context);
  return found[0];
}

/** Append one retrieval event to `<cwd>/.research/retrieval.jsonl`. No throw. */
export function appendRetrievalEvent(cwd, event) {
  if (!cwd) return;
  try {
    const dir = path.join(cwd, '.research');
    mkdirSync(dir, { recursive: true });
    const record = { kind: 'query', ts: new Date().toISOString(), ...(event || {}) };
    appendFileSync(path.join(dir, RETRIEVAL_LOG_NAME), `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    /* telemetry must never break a search */
  }
}

/**
 * Resolve to the promise's value, or `undefined` after `ms` (never rejects).
 * `onTimeout` runs when the bound elapses (e.g. to abort the upstream).
 */
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    let done = false;
    // NOTE: intentionally NOT unref'd — an unref'd timer lets the event loop
    // drain while a hung upstream settles, so the timeout would never fire.
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          if (typeof onTimeout === 'function') onTimeout();
        } catch {
          /* abort is best-effort */
        }
        resolve(undefined);
      }
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(undefined);
        }
      }
    );
  });
}

/** Normalise an upstream hit into OpenCode's WebSearch.Result shape. */
function normalizeHit(hit) {
  return {
    url: String(hit?.url || hit?.link || ''),
    title: String(hit?.title || hit?.name || ''),
    content: String(
      hit?.content ?? hit?.snippet ?? hit?.description ?? hit?.text ?? ''
    ),
    time: hit?.time && typeof hit.time === 'object' ? hit.time : {},
  };
}

function firstArray(...candidates) {
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

async function postJson(fetchImpl, url, body, headers, signal) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res || !res.ok) return null;
  return res.json();
}

/** One upstream rung. Errors are swallowed into an empty hit list.
 *
 * ``ctx.statusRef`` (optional) records why a rung produced nothing so the
 * caller can log an honest `provider`/`status` event; errors land as
 * ``error`` rather than masquerading as a legitimate empty result set.
 */
async function runUpstream(upstream, query, ctx = {}) {
  const { fetchImpl, hostQuery, runPythonSearch, signal } = ctx;
  const provider = upstream?.provider;
  const env = ctx.env || process.env;
  const fail = (reason) => {
    if (ctx.statusRef) {
      ctx.statusRef.status = 'error';
      ctx.statusRef.error = reason;
    }
    return [];
  };
  try {
    if (provider === 'duckduckgo' || provider === 'ddg') {
      // Reuse our own path: anomaly detection, telemetry, domain filtering.
      if (typeof runPythonSearch !== 'function') return fail('no-python-search');
      const raw = await runPythonSearch(query, { signal });
      return firstArray(raw).map(normalizeHit);
    }
    if (provider === 'searxng') {
      if (typeof fetchImpl !== 'function') return fail('no-fetch');
      // Strip trailing slashes without a regex: /\/+$/ on uncontrolled input
      // trips CodeQL js/polynomial-redos; this loop is linear by construction.
      let base = String(env?.SEARXNG_URL || 'http://localhost:8080');
      while (base.length > 1 && base.endsWith('/')) base = base.slice(0, -1);
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
      const res = await fetchImpl(url, { signal });
      if (!res || !res.ok) return fail('searxng-http');
      const data = await res.json();
      return firstArray(data?.results).map(normalizeHit);
    }
    if (provider === 'exa') {
      if (typeof fetchImpl !== 'function') return fail('no-fetch');
      const data = await postJson(
        fetchImpl,
        'https://api.exa.ai/search',
        { query, numResults: 8 },
        { 'x-api-key': String(env?.EXA_API_KEY || '') },
        signal
      );
      return firstArray(data?.results).map(normalizeHit);
    }
    if (provider === 'tavily') {
      if (typeof fetchImpl !== 'function') return fail('no-fetch');
      const data = await postJson(
        fetchImpl,
        'https://api.tavily.com/search',
        { api_key: String(env?.TAVILY_API_KEY || ''), query, max_results: 8 },
        {},
        signal
      );
      return firstArray(data?.results).map(normalizeHit);
    }
    if (provider === 'firecrawl') {
      if (typeof fetchImpl !== 'function') return fail('no-fetch');
      const data = await postJson(
        fetchImpl,
        'https://api.firecrawl.dev/v1/search',
        { query, limit: 8 },
        { authorization: `Bearer ${String(env?.FIRECRAWL_API_KEY || '')}` },
        signal
      );
      return firstArray(data?.data).map(normalizeHit);
    }
    if (provider === 'parallel') {
      if (typeof fetchImpl !== 'function') return fail('no-fetch');
      const data = await postJson(
        fetchImpl,
        'https://api.parallel.ai/v1beta/search',
        { search_queries: [query], max_results: 8 },
        { 'x-api-key': String(env?.PARALLEL_API_KEY || '') },
        signal
      );
      return firstArray(data?.results).map((r) =>
        normalizeHit({
          url: r?.url,
          title: r?.title,
          content: firstArray(r?.excerpts).join(' ') || r?.snippet,
        })
      );
    }
    if (provider === 'tinyfish') {
      if (typeof fetchImpl !== 'function') return fail('no-fetch');
      const data = await postJson(
        fetchImpl,
        'https://api.tinyfish.ai/v1/search',
        { query, max_results: 8 },
        { 'x-api-key': String(env?.TINYFISH_API_KEY || '') },
        signal
      );
      return firstArray(data?.results, data?.data).map(normalizeHit);
    }
    if (provider === CONSOLE_WEBSEARCH_PROVIDER) {
      // Console is the host's own metered provider; delegate rather than
      // re-implement it, and only when explicitly selected.
      if (typeof hostQuery !== 'function') return fail('no-host-query');
      const out = await hostQuery({ query, providerID: CONSOLE_WEBSEARCH_PROVIDER });
      const results = firstArray(out?.results, out?.data, out);
      return results.map(normalizeHit);
    }
    return fail('unknown-provider');
  } catch (err) {
    return fail(String(err?.message || 'upstream-error'));
  }
}

/** Spawn our Python DDG path so its telemetry + anomaly detection apply. */
function spawnPythonWebsearch(query, { cwd, signal } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn(
        resolveBinary('python3'),
        [
          path.join(PKG_ROOT, 'skills', 'epistemic_search', 'scripts', 'search.py'),
          '--json',
          String(query),
        ],
        {
          cwd: cwd || process.cwd(),
          env: {
            ...process.env,
            PYTHONPATH: PKG_ROOT,
            IUMBTEMS_PROJECT_DIR: cwd || process.cwd(),
            IUMBTEMS_RESEARCH_DIR: path.join(cwd || process.cwd(), '.research'),
          },
        }
      );
    } catch {
      resolve([]);
      return;
    }
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.on('error', () => resolve([]));
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { try { child.kill(); } catch { /* noop */ } }, { once: true });
    }
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed.map(normalizeHit) : []);
      } catch {
        resolve([]);
      }
    });
  });
}

/** Build the provider definition. Everything network-touching is injectable. */
export function websearchProviderDefinition(options = {}) {
  const {
    env = process.env,
    explicit = undefined,
    connected = [],
    cwd = undefined,
    fetchImpl = typeof fetch === 'function' ? fetch : undefined,
    hostQuery = undefined,
    runPythonSearch = undefined,
    logEvent = appendRetrievalEvent,
    timeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS,
  } = options;
  return {
    id: WEBSEARCH_PROVIDER_ID,
    name: WEBSEARCH_PROVIDER_NAME,
    execute: async ({ query } = {}, opts = {}) => {
      const signal = opts?.signal;
      // A pre-aborted request must not touch the network at all.
      if (signal && signal.aborted) return [];
      const text = String(query || '');
      if (!text) return [];
      const upstream = resolveWebsearchUpstream(env, explicit, connected);
      const statusRef = { status: 'ok' };
      // Link the host signal to an internal controller so the timeout can abort
      // a hung upstream / child process, not merely stop waiting on it.
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      if (controller && signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      // Bounded: a never-settling upstream resolves to [] rather than hanging
      // the host forever.
      const timed = await withTimeout(
        runUpstream(upstream, text, {
          env,
          fetchImpl,
          hostQuery,
          runPythonSearch,
          signal: controller ? controller.signal : signal,
          statusRef,
        }),
        timeoutMs,
        () => controller?.abort()
      );
      const hits = Array.isArray(timed) ? timed : [];
      if (timed === undefined) statusRef.status = 'timeout';
      else if (statusRef.status === 'ok') statusRef.status = hits.length ? 'ok' : 'empty';
      // Every rung on OUR path is recorded with its provider + status, so a
      // metered-only run cannot read as `0 searches (~$0.00 est)`. The DDG rung
      // is exempt: it routes through `search.py`, which already logs a richer
      // event (blocked/empty/error), and logging here too would double-count.
      if (upstream.provider !== 'duckduckgo' && upstream.provider !== 'ddg') {
        try {
          logEvent(cwd, {
            query: text,
            results: hits.length,
            status: statusRef.status,
            provider: upstream.provider,
            ...(statusRef.error ? { error: statusRef.error } : {}),
          });
        } catch {
          /* telemetry must never break a search */
        }
      }
      return hits;
    },
  };
}

/** Read the user's explicit selection from the host config shapes, if any. */
function readExplicitWebsearchProvider(host, context) {
  const candidates = [
    host?.config?.websearch?.provider,
    host?.websearch?.provider,
    context?.config?.websearch?.provider,
    context?.options?.websearch?.provider,
    host?.options?.websearch?.provider,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}

/**
 * Read the editor's current default. Distinguishes "no default configured"
 * (safe to set ours) from "cannot tell" (never override — do not set).
 */
function readWebsearchDefault(editor) {
  try {
    const d = editor?.default;
    if (d && typeof d.get === 'function') return { known: true, value: d.get() };
  } catch {
    /* fall through to unknown */
  }
  return { known: false, value: undefined };
}

/**
 * Register the cached provider via the V2 `websearch.transform` domain.
 *
 * Shape-tolerant: a host build without `websearch` yields `[]` and the plugin
 * carries on. The transform callback is wrapped so a registration fault can
 * never disable the whole plugin the way the AgentEditor `add` bug did.
 */
export async function registerHostWebsearch(host, context = {}) {
  if (typeof host?.websearch?.transform !== 'function') return [];
  const cwd = host?.location?.directory || context?.location?.directory || undefined;
  const explicit = readExplicitWebsearchProvider(host, context);
  // Consult the host's integration store: a `/connect`ed provider is usable
  // even without a `websearch.provider` or an env key. Best-effort.
  let connected = [];
  try {
    connected = await readConnectedWebsearchProviders(host, context);
  } catch (err) {
    log(host, 'warn', 'integration store probe failed', errDetail(err));
  }
  // Record the choice for the runner's preflight (the integration store is only
  // reachable from inside the host process). Two best-effort channels:
  //   1. `<cwd>/.research/websearch-state.json` for a run pointed at this tree,
  //   2. the spawn env, since the plugin starts the MCP runner with
  //      `...process.env` — so the banner names the active provider and never
  //      halts a run whose `/connect`ed provider is usable.
  persistConnectedState(cwd, connected);
  try {
    if (explicit) process.env.IUMBTEMS_WEBSEARCH_PROVIDER = explicit;
    else delete process.env.IUMBTEMS_WEBSEARCH_PROVIDER;
    if (connected.length) {
      process.env.IUMBTEMS_CONNECTED_WEBSEARCH_PROVIDER = connected[0];
    } else {
      delete process.env.IUMBTEMS_CONNECTED_WEBSEARCH_PROVIDER;
    }
  } catch {
    /* some sandboxes expose a read-only process.env */
  }

  const definition = websearchProviderDefinition({
    env: process.env,
    explicit,
    connected,
    cwd,
    hostQuery:
      typeof host?.websearch?.query === 'function'
        ? (input) => host.websearch.query(input)
        : undefined,
    runPythonSearch: (query, opts) => spawnPythonWebsearch(query, { ...(opts || {}), cwd }),
  });

  const registration = await host.websearch.transform((editor) => {
    try {
      editor.add(definition);
      const current = readWebsearchDefault(editor);
      // ONLY choose our default when we can prove the user made no explicit
      // `websearch.provider` choice (and did not `/connect` one) AND the editor
      // reports no default at all.
      if (
        !explicit &&
        !connected.length &&
        current.known &&
        current.value === undefined &&
        typeof editor?.default?.set === 'function'
      ) {
        editor.default.set(WEBSEARCH_PROVIDER_ID);
      }
    } catch (err) {
      log(host, 'warn', 'websearch provider registration failed', errDetail(err));
    }
  });
  log(host, 'info', 'cached search provider registered', {
    id: WEBSEARCH_PROVIDER_ID,
    explicitProvider: explicit || null,
    connectedProviders: connected,
  });
  return registration ? [registration] : [];
}

/** Write the host-reported connections where the runner's preflight can read them. */
function persistConnectedState(cwd, connected) {
  if (!cwd) return;
  const dir = path.join(cwd, '.research');
  const file = path.join(dir, CONNECTED_STATE_NAME);
  const list = Array.isArray(connected) ? connected.filter(Boolean) : [];
  try {
    if (list.length === 0) {
      // The host reports NO `/connect`ed provider: remove any stale record so a
      // previous connection (or a forged file) cannot keep advertising a
      // provider that is gone. The runner treats the file as advisory, but it
      // must not outlive the connection either.
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          connected_provider: list[0],
          connected_providers: list,
          updated: new Date().toISOString(),
        },
        null,
        2
      )}\n`,
      'utf-8'
    );
  } catch {
    /* best-effort channel; never break registration */
  }
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
        // Phase 01-hook-bus-spec: `session-start(compaction)` restores
        // `.research` state path. The bus verdict is advisory here — a deny
        // must not drop the compaction context push (fail-open); the emit is
        // still audit-logged on the shared bus.
        // [VERIFIED: sha256:52ac5b4d26062cfc6093440faa415ab152f8acd0d18c4496eb0087ed18a27d76 `:1750-1775`]
        try {
          await hookBus.emit('session-start', { root, eventId: 'compaction' });
        } catch {
          /* bus faults fail open; the state push below still runs */
        }
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

async function registerHostAgents(host) {
  // V2 Context exposes `agent.transform` (AgentDomain). Registering the IUMBTEMS
  // role profiles here removes the config-snippet install dependency: without
  // them the `/factory` command ran as the generic `build` agent (observed live:
  // every step of a factory session executed as `build`, not `manager`).
  if (typeof host?.agent?.transform !== 'function') return [];
  const snippet = readPkgJson(path.join(PKG_ROOT, 'config', 'opencode-snippet.json'));
  // V2 config key is `agents` (plural); accept the legacy `agent` key for one
  // release so older snippet copies keep working.
  const agentDefs = (snippet && (snippet.agents || snippet.agent)) || {};
  if (Object.keys(agentDefs).length === 0) return [];

  let existing = new Set();
  try {
    const listed = await host.agent.list();
    existing = new Set((listed?.data || listed || []).map((a) => a?.id || a?.name));
  } catch (err) {
    log(host, 'warn', 'agent.list() failed; assuming an empty registry', errDetail(err));
  }

  const registration = await host.agent.transform((draft) => {
    const claimed = new Set(existing);
    const added = [];
    for (const [name, def] of Object.entries(agentDefs)) {
      if (claimed.has(name)) continue;
      claimed.add(name);
      added.push(name);
      registerAgent(draft, name, def);
    }
    log(host, 'debug', 'agent.transform pass', { added });
  });
  try {
    if (typeof host.agent.reload === 'function') await host.agent.reload();
    log(host, 'info', 'agent profiles registered', { count: Object.keys(agentDefs).length });
  } catch (err) {
    log(host, 'warn', 'agent.reload() failed', errDetail(err));
  }
  return registration ? [registration] : [];
}

/** Short role system prompts for the factory seats (skills carry the long form). */
const FACTORY_SYSTEM = {
  manager:
    'You are the IUMBTEMS Factory Manager. Own gate discipline: grill until the frontier is settled, run the brainstorm and darkharvest swarms, synthesize .roadmap phase dossiers, spawn the programmer per phase, run qa-a and qa-b, and tiebreak their disagreements. Never write implementation code. Use the iumbtems_factory tool for run state. Explicit user approval advances each gate.',
  programmer:
    'You are the IUMBTEMS Factory Programmer. Implement exactly one phase brief per spawn. Cite phase evidence hashes. Never invoke swarms or other programmers. If the brief is ambiguous or untestable, stop and ask the manager.',
  'qa-a':
    'You are the IUMBTEMS Factory functional QA. Verify each phase acceptance criterion on the real surface with tests and inspection. Read-only plus test execution; never edit code. Return pass|fail(reason)|conditional(note).',
  'qa-b':
    'You are the IUMBTEMS Factory adversarial QA. Attack the phase: edge cases, regressions, vacuous acceptance criteria, error paths, resource limits. Read-only plus test execution; never edit code. Return pass|fail(reason)|conditional(note) with reproductions.',
};

/** V1 permission/tool action names -> V2 permission action names. */
const ACTION_ALIASES = { bash: 'shell', task: 'subagent', patch: 'edit', write: 'edit' };

function normalizeAction(action) {
  const key = String(action || '').trim();
  return ACTION_ALIASES[key] || key;
}

function normalizeEffect(effect) {
  return effect === 'deny' || effect === 'ask' ? effect : 'allow';
}

/**
 * Map one snippet agent definition to an Agent.Info shape.
 *
 * Accepts the V2 config form (`permissions: [{action,resource,effect}]`) and
 * still understands the legacy V1 form (`tools` map + `permission` map) so an
 * older snippet copy is not silently dropped.
 */
function toAgentInfo(name, def) {
  const permissions = [];
  for (const rule of def?.permissions || []) {
    if (rule && typeof rule === 'object' && typeof rule.action === 'string') {
      permissions.push({
        action: normalizeAction(rule.action),
        resource: typeof rule.resource === 'string' ? rule.resource : '*',
        effect: normalizeEffect(rule.effect),
      });
    }
  }
  for (const [tool, enabled] of Object.entries(def?.tools || {})) {
    permissions.push({
      action: normalizeAction(tool),
      resource: '*',
      effect: enabled ? 'allow' : 'deny',
    });
  }
  for (const [key, value] of Object.entries(def?.permission || {})) {
    if (typeof value === 'string') {
      permissions.push({ action: normalizeAction(key), resource: '*', effect: normalizeEffect(value) });
    } else if (value && typeof value === 'object') {
      for (const [resource, effect] of Object.entries(value)) {
        permissions.push({ action: normalizeAction(key), resource, effect: normalizeEffect(effect) });
      }
    }
  }
  const info = {
    id: name,
    name,
    description: def?.description || `IUMBTEMS ${name}`,
    mode: def?.mode || 'all',
    hidden: Boolean(def?.hidden),
    request: { settings: {}, headers: {}, body: {} },
    permissions,
  };
  if (def?.steps) info.steps = def.steps;
  if (def?.color) info.color = def.color;
  // The canonical short role prompt wins; fall back to a snippet-provided one.
  const system = FACTORY_SYSTEM[name] || def?.system;
  if (system) info.system = system;
  return info;
}

/**
 * Register one agent profile through a V2 `AgentEditor`.
 *
 * V2's AgentEditor has NO `add()` — only `list/get/default/update/remove`
 * (verified against @opencode/plugin@2.0.18 dist/promise/agent.d.ts). Calling
 * `draft.add(...)` threw `draft.add is not a function` and the host disabled
 * the whole plugin ("disabled plugin after transform failure", state=agent).
 *
 * `update(id, mutate)` upserts: when the id is new the host seeds the draft
 * from `Agent.Info.default(id)` plus global permission rules, then hands it to
 * the callback (opencode v2.0.18 agent registry:
 * `c = agents.get(d) ?? {...default(d), permissions:[...default.permissions, ...I]}`).
 * The first-party `opencode.config.agent` plugin registers config agents the
 * same way, so this is the supported path for creating profile agents.
 *
 * Seeded permissions are kept and ours appended: rule matching is
 * last-match-wins, so an explicit `edit: deny` still beats the default allow.
 */
function registerAgent(editor, name, def) {
  const info = toAgentInfo(name, def);
  const rules = info.permissions || [];
  const profile = { ...info };
  delete profile.permissions;
  editor.update(name, (agent) => {
    Object.assign(agent, profile);
    agent.permissions = [...(agent.permissions || []), ...rules];
  });
}

/** Canonical skills the plugin registers so agents never hunt the filesystem. */
const BUNDLED_SKILLS = [
  'factory',
  'darkharvest',
  'brainstorming',
  'grilling',
  'swarm_config',
  'code_audit',
  'oss_scout',
  'research_cache',
  'epistemic_search',
];

function parseSkillFrontmatter(text) {
  const out = {};
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return out;
  for (const line of text.slice(3, end).split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

async function registerHostSkills(host) {
  // V2 Context exposes `skill.transform` (SkillDomain). Live evidence: with no
  // skills registered, a factory agent ran `find / -name factory.py` and read
  // the skill prose out of the CLAUDE plugin cache to learn its own mechanics.
  if (typeof host?.skill?.transform !== 'function') return [];
  const skills = [];
  for (const name of BUNDLED_SKILLS) {
    const skillPath = path.join(PKG_ROOT, 'skills', name, 'SKILL.md');
    let content;
    try {
      content = readFileSync(skillPath, 'utf-8');
    } catch {
      continue;
    }
    const fm = parseSkillFrontmatter(content);
    skills.push({
      id: name,
      name,
      description: fm.description || `IUMBTEMS ${name} skill`,
      path: skillPath,
      content,
      autoinvoke: true,
    });
  }
  if (skills.length === 0) return [];

  let existing = new Set();
  try {
    const listed = await host.skill.list();
    existing = new Set((listed?.data || listed || []).map((s) => s?.id || s?.name));
  } catch (err) {
    log(host, 'warn', 'skill.list() failed; assuming an empty registry', errDetail(err));
  }

  const registration = await host.skill.transform((draft) => {
    const claimed = new Set(existing);
    const added = [];
    for (const skill of skills) {
      if (claimed.has(skill.id)) continue;
      claimed.add(skill.id);
      added.push(skill.id);
      draft.add(skill);
    }
    log(host, 'debug', 'skill.transform pass', { added });
  });
  try {
    if (typeof host.skill.reload === 'function') await host.skill.reload();
    log(host, 'info', 'skills registered', { count: skills.length });
  } catch (err) {
    log(host, 'warn', 'skill.reload() failed', errDetail(err));
  }
  return registration ? [registration] : [];
}

function readPkgJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
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

/**
 * Best-effort session agent switch for commands that pin an agent.
 *
 * Live gap: `/factory` declared `agent: 'manager'` but the session kept running
 * as `build`, so the manager playbook was never loaded. The V2 SessionDomain
 * exposes `switchAgent`; its exact call shape is not pinned in the public types,
 * so try the plausible shapes and never throw into the host.
 */
async function switchSessionAgent(host, sessionID, agentId) {
  if (!agentId || !sessionID) return false;
  const fn = host?.session?.switchAgent;
  if (typeof fn !== 'function') return false;
  const attempts = [
    () => fn.call(host.session, { sessionID, agent: agentId }),
    () => fn.call(host.session, { sessionID, agentID: agentId }),
    () => fn.call(host.session, sessionID, agentId),
    () => fn.call(host.session, agentId),
  ];
  for (const attempt of attempts) {
    try {
      const res = attempt();
      if (res && typeof res.then === 'function') await res;
      return true;
    } catch {
      /* try the next call shape */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 03 (opencode-settings-menu): `iumbtems.settings` RPC domain, storage
// mirror, MCP toggles, temperature hook.
//
// v2 RPC pattern (https://opencode.ai/v2/docs/build/plugins/rpc): the domain
// is a portable `Rpc.define`-shaped definition (plain JSON-Schema I/O, no
// dependency so the TUI entry can import it too), registered with
// `ctx.rpc.register(Def, handlers)`; the TUI calls it via
// `context.client.rpc(Def)`; implementations emit with
// `registration.events.emit(name, data)`. Every registration below is
// best-effort + feature-detected: a host without the domain yields null and
// setup still succeeds (pinned by the graceful-degradation suites).
// ---------------------------------------------------------------------------

/** RPC domain id for the settings control plane. */
export const SETTINGS_RPC_ID = 'iumbtems.settings';

/** `ctx.storage` key mirroring the last effective config + hash. */
export const SETTINGS_STORAGE_KEY = 'iumbtems.settings.snapshot';

/**
 * Portable `iumbtems.settings` RPC definition (`get`/`set`/`validate` plus
 * the `changed` event). Shaped for `Rpc.define` (JSON-Schema I/O; event data
 * is an object as the RPC contract requires) so it can be passed straight to
 * a real `ctx.rpc.register` and to `context.client.rpc(...)` on the TUI side.
 */
export const SettingsRpc = {
  id: SETTINGS_RPC_ID,
  methods: {
    get: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: {
          config: { type: 'object' },
          raw: { type: ['object', 'null'] },
          hash: { type: ['string', 'null'] },
          migrated: { type: 'boolean' },
        },
        required: ['config'],
        additionalProperties: false,
      },
    },
    set: {
      input: {
        type: 'object',
        properties: {
          updates: { type: 'object' },
          expected_hash: { type: 'string' },
          expectedHash: { type: 'string' },
        },
        required: ['updates'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          config: { type: 'object' },
          hash: { type: 'string' },
        },
        required: ['config', 'hash'],
        additionalProperties: false,
      },
      errors: {
        stale: {
          type: 'object',
          properties: {
            expected_hash: { type: 'string' },
            current_hash: { type: ['string', 'null'] },
            written: { type: 'boolean' },
          },
          required: ['written'],
          additionalProperties: false,
        },
        invalid: {
          type: 'object',
          properties: {
            errors: { type: 'array', items: { type: 'string' } },
            written: { type: 'boolean' },
          },
          required: ['written'],
          additionalProperties: false,
        },
        conflict: {
          type: 'object',
          properties: {
            expected_hash: { type: 'string' },
            expectedHash: { type: 'string' },
            written: { type: 'boolean' },
          },
          required: ['written'],
          additionalProperties: false,
        },
      },
    },
    validate: {
      input: {
        type: 'object',
        properties: { updates: { type: 'object' } },
        required: ['updates'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          valid: { type: 'boolean' },
          problems: { type: 'array', items: { type: 'string' } },
        },
        required: ['valid', 'problems'],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: 'object',
        properties: {
          hash: { type: 'string' },
          keys: { type: 'array', items: { type: 'string' } },
        },
        required: ['hash'],
        additionalProperties: false,
      },
    },
  },
};

function settingsResearchDir(root) {
  try {
    return path.join(root || process.cwd(), '.research');
  } catch {
    return path.join(process.cwd(), '.research');
  }
}

function parseMcpContent(result) {
  try {
    return JSON.parse(String(result?.content ?? ''));
  } catch {
    return null;
  }
}

/**
 * Declared-error return for an RPC method handler: uses the real
 * `context.error(type, message, data)` when the host provides it, otherwise
 * throws a structured error carrying the same type/data (the mock-host path
 * in the suites). Never returns normally — always throws or returns the
 * host's error value.
 */
function rpcFail(context, type, message, data) {
  if (context && typeof context.error === 'function') {
    return context.error(type, message, data);
  }
  const err = new Error(message);
  err.rpcType = type;
  err.rpcData = data || {};
  throw err;
}

/** `iumbtems_config` control args are never config keys; strip them defensively. */
const SETTINGS_CONTROL_ARGS = new Set(['base_dir', 'dir', 'show', 'expected_hash', 'expectedHash']);

/**
 * Leak signatures that must never reach the RPC transport (phase-03 R7/R9,
 * phase-08 R1): tracebacks, `File "…", line N` frames, interpreter failure
 * lines, `file://` URIs, and absolute filesystem paths of ANY root — POSIX
 * multi-segment (e.g. `/workspace/…`, `/srv/…`, `/Users/…`, `/app/…`),
 * single-segment system roots (`/etc`, `/tmp`, `/lib`, `/lib64`, `/boot`,
 * `/snap`, macOS `/System`, `/Library`, `/Volumes`, `/Applications`, …),
 * Windows drive
 * (`C:\Users\…`), and UNC (`\\server\share`). Structured validation problems
 * (e.g. `mode: value … not in enum …`, type/range violations carrying
 * ordinary values) match none of these and pass through intact.
 */
const SETTINGS_ERROR_LEAK_PATTERNS = [
  // Tracebacks and Python/Node interpreter failure lines.
  /Traceback(?: \(most recent call last\))?/i,
  /File\s+["'][^"']+["']\s*,\s*line\s+\d+/i,
  /\b(?:ModuleNotFoundError|ImportError|SyntaxError|NameError|OSError|Errno \d+)\b/,
  // Absolute POSIX path of any root: a bounded leading slash + >=2 segments.
  // Phase-08 R1 (W9) REWORK-2 L2: prefix class gains `[`, `{`, `-` so
  // bracket/brace/dash-delimited absolutes (`[/etc]`, `{/etc}`, `-/etc`,
  // `x-/lib64,y`) redact. Canonical values contain no `/`-root tokens
  // (proven by the canonical-value corpus passing verbatim), so `-`-prefixed
  // path tokens are disclosures, not user echoes.
  /(?:^|[\s"'(=:,\[{-])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/,
  // Phase-08 R1 (W9) REWORK-1: single-segment system-root absolutes
  // (`/etc`, `/tmp`, plus `/lib`, `/lib64`, `/boot`, `/snap`, macOS `/System`,
  // `/Library`, `/Volumes`, `/Applications`).
  // The >=2-segment arm above lets these through, but a bare system root in
  // a failure item is a local-filesystem disclosure (interpreter stderr
  // echoes absolute paths of any depth). The root allowlist keeps ordinary
  // user echoes intact: single-segment non-system values (`/v1`, `/nope`)
  // still pass through, and sanitization stays per-item (R9).
  // RESIDUAL (documented): truly exotic single-segment roots outside the
  // mainstream Linux + macOS set (e.g. `/net`, `/nfs`, future mount points)
  // still pass through by design to avoid over-redacting user echoes.
  // TRIGGER (consumed for this class): qa-b repro `["error at /lib nope"]`
  // passthrough + inspection-named `/lib64`, `/boot`, `/snap`, `/System`,
  // `/Library`, `/Volumes`, `/Applications` are now covered. Revisit only
  // with a NEW real leak repro naming the still-uncovered root.
  // Phase-08 R1 (W9) REWORK-2 L1: suffix lookahead gains `.!?]}` so
  // bare-root + sentence punctuation (`/lib.`, `/etc.`, `/lib!`, `/tmp?`,
  // `/lib]`, `/lib}`) redacts. The >=2-segment arm is untouched (its trailing
  // `[A-Za-z0-9._-]+` already consumes `/etc/foo.`). L2: prefix class gains
  // `[`, `{`, `-` (same `-` safety proof as above) so `[/etc]`, `[/lib]`,
  // `[/lib64]`, `{/etc}`, `-/etc`, `x-/lib64,y` redact.
  /(?:^|[\s"'(=:,\[{-])\/(?:etc|var|tmp|srv|app|home|root|usr|opt|bin|sbin|proc|sys|dev|run|mnt|media|private|Users|workspace|lib64|lib|boot|snap|System|Library|Volumes|Applications)(?=\/|$|[\s"'<>|,;:().!?\]}])/,
  // Phase-08 R1 (W9): `file://` URIs always disclose local filesystem
  // layout, and no canonical config value is a file:// URI (`searxng_url`
  // requires an http(s) scheme) — so a file:// URI in a failure item is
  // never a legitimate user echo. Fail closed.
  /file:\/\/[^\s"'<>|]+/i,
  // Windows drive-letter absolute path (`C:\Users\…`) or UNC share (`\\srv\share`).
  /\b[A-Za-z]:[\\/](?:[^\\/\s"'<>|]+[\\/])*[^\\/\s"'<>|]+/,
  /\\\\[^\\/\s"'<>|]+[\\/][^\\/\s"'<>|]+/,
];

/** Fixed reason when an individual failure item is unreadable/leaky (mirrors `get`). */
const SETTINGS_WRITE_UNREADABLE = 'Config write rejected: canonical config surface returned an unreadable failure.';

/**
 * Sanitize a `set`-leg failure list PER ITEM (phase-03 R9): each structured
 * problem passes through untouched; any single item carrying a leak signature
 * is replaced by the fixed reason — one leaky entry never discards the rest of
 * the list. Never throws; never returns an empty list.
 */
function sanitizeRpcErrors(errors) {
  try {
    const list = Array.isArray(errors) ? errors.map((e) => String(e)) : [];
    if (list.length > 0) {
      return list.map((item) =>
        SETTINGS_ERROR_LEAK_PATTERNS.some((re) => re.test(item))
          ? SETTINGS_WRITE_UNREADABLE
          : item
      );
    }
  } catch {
    /* fall through to the fixed reason */
  }
  return [SETTINGS_WRITE_UNREADABLE];
}

/**
 * Method handlers for the `iumbtems.settings` domain. `set` validates, applies
 * the expected-hash guard (8-hex minimum, both `expected_hash`/`expectedHash`
 * spellings, conflict -> error — the phase-01/02 semantics shared with
 * `config-io.js`), and writes through the canonical Python surface
 * (`callMcp('iumbtems_config')`) so the single-writer discipline holds. A stale
 * guard returns the structured `stale` error with a fresh snapshot and writes
 * nothing. `emitChanged` fires exactly once per successful write; the
 * `ctx.storage` mirror and `mcp.reload()` are best-effort.
 */
export function createSettingsHandlers(opts = {}) {
  const root = opts.root;
  const researchDir = settingsResearchDir(root);
  const callMcpImpl = opts.callMcpImpl || callMcp;
  const storage = opts.storage || null;
  const emitChanged = opts.emitChanged || null;
  const reloadMcp = opts.reloadMcp || null;
  // Phase 01-hook-bus-spec: `pre-commit` gates config writes via this
  // settings-RPC path. Defaults to the shared bus; stale-write guards below
  // are preserved (a bus allow still runs the expected-hash MCP write, which
  // enforces staleness).
  const settingsBus = opts.hookBus || hookBus;

  return {
    get: async () => {
      let res;
      try {
        res = await callMcpImpl('iumbtems_config', { show: true, base_dir: researchDir }, root);
      } catch (err) {
        // Fail closed: a spawn failure (e.g. ENOENT) must never leak raw
        // internals to the TUI — fixed message, stable code, nothing written.
        const sanitized = new Error('iumbtems.settings.get failed: canonical config surface unavailable');
        sanitized.code = 'SETTINGS_RPC_UNAVAILABLE';
        throw sanitized;
      }
      const payload = parseMcpContent(res);
      if (!payload || typeof payload.config !== 'object' || payload.config === null) {
        const sanitized = new Error('iumbtems.settings.get failed: canonical config surface unavailable');
        sanitized.code = 'SETTINGS_RPC_UNAVAILABLE';
        throw sanitized;
      }
      // Single-read (phase-03 R5): the raw bytes are read EXACTLY ONCE below;
      // the returned effective `config` is merged from those bytes, the `raw`
      // on-disk subset is parsed from those bytes, and the hash is computed
      // over those bytes — so an era-A config with an era-B hash (or raw) is
      // impossible. The Python surface still supplies the `migrated` flag
      // (computed in memory; the show leg never writes); the returned payload
      // is one snapshot regardless of what either side read on its own clock.
      const snap = readConfigSnapshot(researchDir);
      const config = loadConfigFromRaw(snap.raw);
      // Refresh-on-read (phase-03 R1): a direct-fs fallback-leg write bypasses
      // the mirror, so every server-mediated read re-converges it to disk
      // truth. The mirror can lag between writes, but it can no longer lie
      // permanently after a fallback-leg success.
      try {
        if (storage && typeof storage.set === 'function') {
          await storage.set(SETTINGS_STORAGE_KEY, {
            config,
            hash: snap.hash,
            updated: new Date().toISOString(),
          });
        }
      } catch {
        /* the storage mirror is best-effort */
      }
      // `raw` (phase-04 R1) is the parsed ON-DISK file config (null when
      // absent/malformed) so the TUI can compute provenance: a key present in
      // `raw` is `file`, otherwise `default` (env-override still wins).
      return { config, raw: snap.raw, hash: snap.hash, migrated: Boolean(payload.migrated) };
    },
    validate: async (input = {}) => {
      const updates = input?.updates;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return { valid: false, problems: ['updates: expected an object'] };
      }
      let merged;
      try {
        merged = mergeConfig(loadConfig(researchDir), updates);
      } catch {
        return { valid: false, problems: ['updates: could not be merged over the current config'] };
      }
      const problems = validateConfig(merged);
      return { valid: problems.length === 0, problems };
    },
    set: async (input = {}, context = {}) => {
      const updates = input?.updates;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return rpcFail(context, 'invalid', 'updates must be an object', {
          written: false,
          errors: ['updates: expected an object'],
        });
      }
      let expected = null;
      try {
        expected = resolveExpectedHash({
          expected_hash: input?.expected_hash,
          expectedHash: input?.expectedHash,
        });
      } catch (err) {
        if (err && err.code === 'CONFLICTING_EXPECTED_HASH') {
          return rpcFail(context, 'conflict', String(err.message), { written: false });
        }
        return rpcFail(context, 'invalid', String((err && err.message) || err), { written: false });
      }
      const sanitized = {};
      for (const [key, value] of Object.entries(updates)) {
        if (!SETTINGS_CONTROL_ARGS.has(key)) sanitized[key] = value;
      }
      const args = { ...sanitized, base_dir: researchDir };
      if (expected !== null) args.expected_hash = expected;
      // Phase 01-hook-bus-spec `pre-commit` gate: a tier-table deny blocks the
      // write (structured `invalid`, nothing written); bus faults fail open.
      // The expected-hash stale guard below still runs on every allow, so
      // stale-write preservation is unchanged. NOTE: the deny-block `rpcFail`
      // stays OUTSIDE the fail-open try — `rpcFail` throws when the host
      // supplies no `context.error`, and catching our own block would
      // silently fail open past a deny.
      let gate = null;
      try {
        gate = await gatePreCommit(settingsBus, {
          updates: sanitized,
          root,
          ...(expected !== null ? { expected_hash: expected } : {}),
        });
      } catch {
        gate = { allowed: true };
      }
      if (gate && gate.allowed === false) {
        return rpcFail(context, 'invalid', 'Config write denied by pre-commit hook.', {
          written: false,
          errors: ['pre-commit hook denied the write'],
        });
      }
      const res = await callMcpImpl('iumbtems_config', args, root);
      const payload = parseMcpContent(res);
      if (payload && payload.status === 'stale') {
        return rpcFail(context, 'stale', 'Config changed on disk since it was read; refusing the stale write.', {
          expected_hash: payload.expected_hash,
          current_hash: payload.current_hash ?? null,
          config: payload.config,
          written: false,
        });
      }
      if (!payload || payload.status !== 'updated' || typeof payload.config !== 'object') {
        // Sanitize (phase-03 R7): raw transport text (tracebacks, absolute
        // paths) must never reach the RPC transport — structured problems
        // pass through, everything else becomes the fixed reason.
        const errors = sanitizeRpcErrors(
          (payload && payload.errors) || (res && res.content ? [String(res.content).slice(0, 300)] : [])
        );
        return rpcFail(context, 'invalid', 'Config write rejected.', { written: false, errors });
      }
      const hash = payload.hash || null;
      try {
        if (storage && typeof storage.set === 'function') {
          await storage.set(SETTINGS_STORAGE_KEY, {
            config: payload.config,
            hash,
            updated: new Date().toISOString(),
          });
        }
      } catch {
        /* the storage mirror is best-effort */
      }
      try {
        if (typeof reloadMcp === 'function') await reloadMcp();
      } catch {
        /* mcp reload after a toggle change is best-effort */
      }
      try {
        if (typeof emitChanged === 'function') {
          await emitChanged({ hash, keys: Object.keys(sanitized) });
        }
      } catch {
        /* event delivery is best-effort */
      }
      return { config: payload.config, hash };
    },
  };
}

/**
 * Register the `iumbtems.settings` domain on a v2 host (`ctx.rpc.register`).
 * Returns the registration, or null when the host has no RPC domain (the TUI
 * then uses the direct-fs degraded path). Never throws.
 */
export async function registerSettingsRpc(host, opts = {}) {
  try {
    const register = host?.rpc?.register;
    if (typeof register !== 'function') return null;
    const root = opts.root || host?.location?.directory || undefined;
    const storage = opts.storage || host?.storage || null;
    let registration = null;
    const emitChanged = async (data) => {
      try {
        if (registration && registration.events && typeof registration.events.emit === 'function') {
          await registration.events.emit('changed', data);
        }
      } catch (err) {
        log(host, 'warn', 'settings changed emit failed', errDetail(err));
      }
    };
    const reloadMcp = async () => {
      try {
        if (host && host.mcp && typeof host.mcp.reload === 'function') {
          await host.mcp.reload();
        }
      } catch (err) {
        log(host, 'warn', 'mcp.reload() after settings write failed', errDetail(err));
      }
    };
    const handlers = createSettingsHandlers({
      root,
      callMcpImpl: opts.callMcpImpl,
      storage,
      emitChanged,
      reloadMcp,
      hookBus: opts.hookBus || hookBus,
    });
    registration = await register.call(host.rpc, SettingsRpc, handlers);
    if (!registration) return null;
    log(host, 'info', 'iumbtems.settings RPC registered', { id: SettingsRpc.id });
    return registration;
  } catch (err) {
    log(host, 'warn', 'registering iumbtems.settings RPC failed', errDetail(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// MCP toggles (M1): `disabled` reconcile for the plugin-controllable set.
// ---------------------------------------------------------------------------
//
// The persisted `mcp_servers` map (canonical config key) holds one boolean per
// server (true = enabled). The transform applies `disabled` for names that are
// (a) in the map, (b) in the plugin-controllable set (bundled `iumbtems` plus
// research servers from `config/mcp-research-servers.json`), and (c) already
// present in the host registry. It never `set`s new servers and never
// `remove`s any — the catalog file stays byte-identical.

/** Plugin-controllable MCP server names (the research-server catalog). */
export function loadControllableMcpServers() {
  try {
    const catalog = JSON.parse(
      readFileSync(path.join(PKG_ROOT, 'config', 'mcp-research-servers.json'), 'utf-8')
    );
    const names = Object.keys(catalog?.mcpServers || {});
    if (names.length > 0) return names;
  } catch {
    /* fall through to the bundled default */
  }
  return ['iumbtems'];
}

/** Raw persisted toggle map (never throws; malformed workspace -> {}). */
export function readPersistedMcpToggles(root) {
  try {
    const raw = readRawConfig(settingsResearchDir(root));
    const map = raw?.mcp_servers;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    return map;
  } catch {
    return {};
  }
}

/**
 * Pure reconcile: persisted map x registry presence x controllable set ->
 * `[{name, disabled}]`. Non-boolean values are ignored (never throw). Exported
 * for tests.
 */
export function resolveMcpToggles(persistedMap, existingNames, controllable) {
  const out = [];
  try {
    if (!persistedMap || typeof persistedMap !== 'object' || Array.isArray(persistedMap)) {
      return out;
    }
    const existing = new Set(existingNames || []);
    const allowed = new Set(controllable || []);
    for (const [name, enabled] of Object.entries(persistedMap)) {
      if (typeof enabled !== 'boolean') continue;
      if (!allowed.has(name)) continue;
      if (!existing.has(name)) continue;
      out.push({ name, disabled: !enabled });
    }
  } catch {
    /* reconcile never throws */
  }
  return out;
}

/**
 * Apply the persisted toggle map through `ctx.mcp.transform`. Returns the
 * registration, or null when the host has no MCP domain. Never throws.
 */
export async function registerMcpToggles(host, opts = {}) {
  try {
    const transform = host?.mcp?.transform;
    if (typeof transform !== 'function') return null;
    const root = opts.root || host?.location?.directory || undefined;
    const controllable = opts.controllable || loadControllableMcpServers();
    const registration = await transform.call(host.mcp, (editor) => {
      let existing = [];
      try {
        existing = (editor.list() || []).map(([name]) => name);
      } catch {
        existing = [];
      }
      const toggles = resolveMcpToggles(readPersistedMcpToggles(root), existing, controllable);
      for (const t of toggles) {
        try {
          editor.update(t.name, (cfg) => {
            cfg.disabled = t.disabled;
          });
        } catch {
          /* one bad entry never breaks the pass */
        }
      }
      log(host, 'debug', 'mcp.transform pass', { toggles: toggles.map((t) => t.name) });
    });
    return registration || null;
  } catch (err) {
    log(host, 'warn', 'registering MCP toggles failed', errDetail(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Temperature (S4): per-role `session.hook("context")`.
// ---------------------------------------------------------------------------
//
// Configured via `IUMBTEMS_TEMPERATURE_<ROLE>` (e.g. IUMBTEMS_TEMPERATURE_ALPHA;
// `IUMBTEMS_TEMPERATURE` is the fallback for every role) so no schema change
// is needed. The hook keys off `event.agent` — type-guaranteed on the context
// hook event (`SessionContext extends SessionRequest { readonly agent }` in
// @opencode/plugin@2.0.18 dist/promise/session.d.ts) — never off the
// `IUMBTEMS_AGENT_ROLE` env var, which only tells a spawned child its own role
// (see the S3 spike record in the phase receipt).

/** Configured temperature for a role, or undefined when unset/unparseable. */
export function temperatureForRole(role, env = process.env) {
  try {
    const name = String(role || '').trim().toUpperCase();
    if (!name) return undefined;
    // Inheritance (phase-03 R4a): an agent id with no role-specific variable
    // inherits the global IUMBTEMS_TEMPERATURE — unknown and future agent ids
    // are deliberately NOT allowlisted (maintaining an id allowlist is riskier
    // than the silent fallback: an unlisted id would silently keep host
    // defaults either way, while a stale allowlist would misroute known
    // roles). Behavior unchanged by this comment.
    const raw = env?.[`IUMBTEMS_TEMPERATURE_${name}`] ?? env?.IUMBTEMS_TEMPERATURE;
    if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
    const num = Number(String(raw).trim());
    if (!Number.isFinite(num) || num < 0 || num > 2) return undefined;
    return num;
  } catch {
    return undefined;
  }
}

/**
 * Apply the configured per-role temperature to one context-hook event.
 * Returns true when `event.options.temperature` was set. Never throws.
 */
export function applyTemperatureToContext(event, env = process.env) {
  try {
    const role = event?.agent;
    if (typeof role !== 'string' || !role) return false;
    const temp = temperatureForRole(role, env);
    if (temp === undefined) return false;
    if (!event.options || typeof event.options !== 'object') event.options = {};
    event.options.temperature = temp;
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the temperature context hook (`session.hook("context")`). Returns
 * the registration, or null when the host has no session-hook domain. Never
 * throws.
 */
export async function registerTemperatureHook(host, opts = {}) {
  try {
    const hook = host?.session?.hook;
    if (typeof hook !== 'function') return null;
    const env = opts.env || process.env;
    const registration = await hook.call(host.session, 'context', (event) => {
      applyTemperatureToContext(event, env);
    });
    log(host, 'info', 'temperature context hook registered', {});
    return registration || null;
  } catch (err) {
    log(host, 'warn', 'registering temperature hook failed', errDetail(err));
    return null;
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
        adopt(await registerHostAgents(host));
      } catch (err) {
        log(host, 'error', 'registering agent profiles failed', errDetail(err));
      }
      try {
        adopt(await registerHostSkills(host));
      } catch (err) {
        log(host, 'error', 'registering skills failed', errDetail(err));
      }
      try {
        adopt(await registerHostTools(host));
      } catch (err) {
        log(host, 'error', 'registering tools failed', errDetail(err));
      }
      try {
        adopt(await registerHostWebsearch(host, context));
      } catch (err) {
        log(host, 'error', 'registering cached search provider failed', errDetail(err));
      }
      try {
        adopt(await registerCompactionHook(host, context));
      } catch (err) {
        log(host, 'error', 'registering compaction hook failed', errDetail(err));
      }
      const settingsRoot =
        host.location?.directory || context.location?.directory || undefined;
      try {
        adopt(await registerSettingsRpc(host, { root: settingsRoot }));
      } catch (err) {
        log(host, 'error', 'registering settings RPC failed', errDetail(err));
      }
      try {
        adopt(await registerMcpToggles(host, { root: settingsRoot }));
      } catch (err) {
        log(host, 'error', 'registering MCP toggles failed', errDetail(err));
      }
      try {
        adopt(await registerTemperatureHook(host, {}));
      } catch (err) {
        log(host, 'error', 'registering temperature hook failed', errDetail(err));
      }
      // Phase 01-hook-bus-spec: adopt the six-event hook bus alongside the
      // existing registrations (same adopt/best-effort pattern). The bus
      // registrar returns a single registration (or null), so wrap it for
      // `adopt`, which takes a list. Never throws.
      try {
        adopt([await registerHookBus(host, { bus: hookBus })]);
      } catch (err) {
        log(host, 'error', 'registering hook bus failed', errDetail(err));
      }
      // Phase 02-lsp-bridge: adopt the first bus consumer (CLI-based JS/TS
      // analysis, all-advisory) alongside the existing registrations (same
      // adopt/best-effort pattern). Analyzer-missing degrades to a silent
      // skip inside the bridge; this adoption never throws.
      try {
        adopt([await registerAnalysisBridge(host, { bus: hookBus })]);
      } catch (err) {
        log(host, 'error', 'registering analysis bridge failed', errDetail(err));
      }
      // Phase 03-dep-health-gate: adopt the second bus consumer
      // (outdated/vulnerable-dependency warnings, all-advisory + mechanical
      // QA coverage gate) alongside the existing registrations (same
      // adopt/best-effort pattern). Feed outages degrade to recorded
      // `unavailable` entries inside the module; this adoption never throws.
      try {
        adopt([await registerDepHealth(host, {
          bus: hookBus,
          // Host-reported project directory; the module falls back to the
          // process cwd when the host reports none (see checkDeps).
          root: host.location?.directory || undefined,
        })]);
      } catch (err) {
        log(host, 'error', 'registering dep-health failed', errDetail(err));
      }
      // Phase 04-coverage-treeshake-signals: adopt the third bus consumer
      // (coverage deltas + esbuild-measured bundle weight, all-advisory,
      // never-blocking) alongside the existing registrations (same
      // adopt/best-effort pattern). esbuild missing/failing degrades to a
      // recorded `unavailable` entry inside the module; this adoption never
      // throws.
      try {
        adopt([await registerWeightSignals(host, {
          bus: hookBus,
        })]);
      } catch (err) {
        log(host, 'error', 'registering weight-signals failed', errDetail(err));
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
        const pending = [];
        for (const registration of registrations) {
          try {
            const done = registration.dispose();
            if (done && typeof done.then === 'function') {
              // Async teardown settles alongside the rest; a rejection logs
              // exactly like a synchronous throw below.
              pending.push(
                done.then(
                  () => { disposed += 1; },
                  (err) => log(host, 'warn', 'registration.dispose() failed', errDetail(err)),
                ),
              );
            } else {
              disposed += 1;
            }
          } catch (err) {
            log(host, 'warn', 'registration.dispose() failed', errDetail(err));
          }
        }
        // Await only when at least one disposal is asynchronous: awaiting an
        // already-settled promise still yields, which would defer the
        // synchronous nudge-stop loop below past a non-awaited cleanup() call
        // (pinned by test_setup_cleanup_aborts_nudge_streams).
        if (pending.length > 0) await Promise.all(pending);
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
