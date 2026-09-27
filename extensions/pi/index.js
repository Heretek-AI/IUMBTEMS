/**
 * IUMBTEMS: I Use My Brain To Express My Self
 * Native Extension for Pi (pi.dev) and OMP (oh-my-pi)
 *
 * THIN REGISTRATION (Stream A2b): slash commands keep their UX; every body
 * forwards to the canonical first-party MCP surface:
 *
 *   python3 runner/mcp_server.py call <tool> '<json>'
 *
 * The one exception is the brainstorming context scaffold
 * (skills/brainstorming/scripts/brainstorm.py), which is skill-local tooling,
 * not a duplicate tool implementation.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
      if (!fs.statSync(full).isFile()) continue;
      fs.accessSync(full, fs.constants.X_OK);
      return fs.realpathSync(full);
    } catch {
      /* not present, not a file, or not executable — keep searching */
    }
  }
  return name;
}

/** Uniform dispatch: one-shot MCP call. Returns {ok, text}. */
function callMcp(tool, args = {}, ctx = {}) {
  const res = spawnSync(
    resolveBinary('python3'),
    [MCP_SERVER, 'call', tool, JSON.stringify(args || {})],
    {
      encoding: 'utf-8',
      cwd: ctx.cwd || process.cwd(),
      env: { ...process.env, PYTHONPATH: PKG_ROOT },
    }
  );
  return {
    ok: res.status === 0,
    text: res.stdout || res.stderr,
  };
}

/** Parse `/swarm-config --engine X --depth N --mode M [--show]` into tool args. */
function parseConfigArgs(raw) {
  const tokens = raw.trim() ? raw.trim().split(/\s+/) : [];
  const out = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--engine' || t === '-e') out.search_engine = tokens[++i];
    else if (t === '--depth' || t === '-d' || t === '--iterations') out.max_iterations = Number(tokens[++i]);
    else if (t === '--mode' || t === '-m') out.mode = tokens[++i];
    else if (t === '--divergence') out.divergence_threshold = Number(tokens[++i]);
    // --show / bare invocation = read-only inspect (MCP tool's default)
  }
  return out;
}

export default function initPiExtension(pi) {
  // Check if Pi extension API is available
  if (!pi) return;

  // 1. Register Slash Commands
  if (typeof pi.registerCommand === 'function') {
    // /swarm: autonomous dialectic research
    pi.registerCommand('swarm', {
      description: 'Run IUMBTEMS dialectic research swarm on an objective',
      usage: '/swarm <objective>',
      handler: async (args, ctx) => {
        const objective = args.trim();
        if (!objective) {
          ctx.output?.('⚠️ Please provide a research objective. Example: /swarm "ZK prover latency bounds"');
          return;
        }

        ctx.output?.(`🌟 [IUMBTEMS] Dispatching Dialectic Swarm: "${objective}"...`);
        const r = callMcp('iumbtems_swarm_research', { objective }, ctx);
        if (r.ok) {
          ctx.output?.(r.text);
          ctx.output?.('\n✅ Research complete! Summary written to .research/final_synthesis.md');
        } else {
          ctx.output?.(`❌ Swarm failed:\n${r.text}`);
        }
      }
    });

    // /grill: Socratic assumption-inversion
    pi.registerCommand('grill', {
      description: 'Launch Socratic grilling and decision tree frontier exploration',
      usage: '/grill [--objective <text>]',
      handler: async (args, ctx) => {
        ctx.output?.('🧠 [IUMBTEMS] Launching Socratic Grilling decision tree...');
        const objective = args.trim();
        const r = callMcp(
          'iumbtems_socratic_frontier',
          objective ? { objective, file: '.research/frontier.json' } : { file: '.research/frontier.json' },
          ctx
        );
        ctx.output?.(r.text);
      }
    });

    // /swarm-config: Inspect and tune research parameters
    pi.registerCommand('swarm-config', {
      description: 'Inspect or update Epistemic Swarm parameters (engine, depth, mode)',
      usage: '/swarm-config [--engine <e>] [--depth <d>] [--mode <m>] [--show]',
      handler: async (args, ctx) => {
        const r = callMcp('iumbtems_config', parseConfigArgs(args), ctx);
        ctx.output?.(r.text);
      }
    });

    // /audit: Dialectic codebase architecture & security audit
    pi.registerCommand('audit', {
      description: 'Run dialectic codebase architectural and security audit with line-level proof',
      usage: '/audit <target_path_or_scope>',
      handler: async (args, ctx) => {
        const target = args.trim() || 'Full repository architecture and vulnerability audit';
        ctx.output?.(`🛡️ [IUMBTEMS Audit] Launching Codebase Audit for: "${target}"...`);
        const r = callMcp('iumbtems_code_audit', { target }, ctx);
        if (r.ok) {
          ctx.output?.(r.text);
          ctx.output?.('\n✅ Audit complete! Report written to .research/code_audit_report.md');
        } else {
          ctx.output?.(`❌ Audit failed:\n${r.text}`);
        }
      }
    });

    // /scout: Open-source software discovery & clean-room harvesting
    pi.registerCommand('scout', {
      description: 'Scout open-source software libraries, audit copyleft licenses & generate clean-room blueprints',
      usage: '/scout <feature_or_algorithm>',
      handler: async (args, ctx) => {
        const feature = args.trim();
        if (!feature) {
          ctx.output?.('⚠️ Please provide a feature to scout. Example: /scout "Zero-dependency Raft consensus in Rust"');
          return;
        }
        ctx.output?.(`🔭 [IUMBTEMS Scout] Scouting open-source solutions for: "${feature}"...`);
        const r = callMcp('iumbtems_oss_scout', { feature }, ctx);
        if (r.ok) {
          ctx.output?.(r.text);
          ctx.output?.('\n✅ Scout complete! Blueprint written to .research/oss_scout_report.md');
        } else {
          ctx.output?.(`❌ Scout failed:\n${r.text}`);
        }
      }
    });

    // /brainstorming: Lateral creative ideation (divergent, speculative)
    pi.registerCommand('brainstorming', {
      description: 'Lateral brainstorming: novel feature vectors, paradigm inversions, falsifiable spikes',
      usage: '/brainstorming <ambiguous-prompt>',
      handler: async (args, ctx) => {
        const objective = args.trim() || 'Where do we go from here?';
        ctx.output?.(`💡 [IUMBTEMS Brainstorm] Diverging on: "${objective}"...`);
        // Skill-local context scaffold (not a tool duplicate) -> then canonical tool.
        const scaffold = path.join(PKG_ROOT, 'skills/brainstorming/scripts/brainstorm.py');
        const pre = spawnSync(resolveBinary('python3'), [scaffold, '--objective', objective, '--show-context'], {
          encoding: 'utf-8',
          cwd: ctx.cwd || process.cwd()
        });
        ctx.output?.(pre.stdout || pre.stderr);
        const r = callMcp('iumbtems_brainstorm', { objective }, ctx);
        if (r.ok) {
          ctx.output?.(r.text);
          ctx.output?.('\n✅ Brainstorm complete! Portfolio written to .research/brainstorm_report.md');
        } else {
          ctx.output?.(`❌ Brainstorm failed:\n${r.text}`);
        }
      }
    });

    // /brainstorm alias
    try {
      pi.registerCommand('brainstorm', {
        description: 'Alias for /brainstorming',
        usage: '/brainstorm <ambiguous-prompt>',
        handler: async (args, ctx) => {
          const cmds = typeof pi.getCommands === 'function' ? pi.getCommands() : {};
          const target = cmds?.brainstorming?.handler || cmds?.['brainstorming'];
          if (typeof target === 'function') return target(args, ctx);
          ctx.output?.('Use /brainstorming <prompt> instead.');
        }
      });
    } catch { /* alias is best-effort across pi/omp versions */ }

    // /darkharvest: Product competitor teardown with harvest verdicts
    pi.registerCommand('darkharvest', {
      description: 'Product competitor teardown: seed inspirations, expand to adjacents, emit harvest verdicts',
      usage: '/darkharvest <product-arena> [--seeds <urls>]',
      handler: async (args, ctx) => {
        const objective = args.trim();
        if (!objective) {
          ctx.output?.('⚠️ Please provide a product arena. Example: /darkharvest "Paseo-class agent harness" --seeds https://github.com/a/b');
          return;
        }
        ctx.output?.(`🌑 [IUMBTEMS Darkharvest] Tearing down: "${objective}"...`);
        const r = callMcp('iumbtems_darkharvest', { objective }, ctx);
        if (r.ok) {
          ctx.output?.(r.text);
          ctx.output?.('\n✅ Darkharvest complete! Matrix written to .research/darkharvest_report.md');
        } else {
          ctx.output?.(`❌ Darkharvest failed:\n${r.text}`);
        }
      }
    });
  }

  // 2. Register Agent Tools (thin forwarders)
  if (typeof pi.registerTool === 'function') {
    // Tool: iumbtems_verify_quote
    pi.registerTool({
      name: 'iumbtems_verify_quote',
      description: 'Verify that an empirical claim quote matches verbatim text in the source cache',
      parameters: {
        type: 'object',
        properties: {
          hash: { type: 'string', description: 'SHA-256 hash of cached source' },
          quote: { type: 'string', description: 'Verbatim quote string to verify' }
        },
        required: ['hash', 'quote']
      },
      execute: async (args = {}) => {
        const r = callMcp('iumbtems_verify_quote', { hash: args.hash, quote: args.quote }, {});
        return { content: [{ type: 'text', text: r.text }] };
      }
    });

    // Tool: iumbtems_config
    pi.registerTool({
      name: 'iumbtems_config',
      description: 'Inspect or modify Epistemic Swarm configuration parameters (search engine, depth, mode) in .research/config.json',
      parameters: {
        type: 'object',
        properties: {
          search_engine: { type: 'string', enum: ['duckduckgo', 'brave', 'firecrawl', 'searxng'] },
          max_iterations: { type: 'integer', minimum: 1, maximum: 4 },
          mode: { type: 'string', enum: ['research', 'audit', 'scout', 'hybrid', 'brainstorm', 'darkharvest'] },
          divergence_threshold: { type: 'number', minimum: 0, maximum: 1 },
          show: { type: 'boolean', default: false }
        }
      },
      execute: async (args = {}) => {
        const r = callMcp('iumbtems_config', parseConfigArgsFromObject(args), {});
        return { content: [{ type: 'text', text: r.text }] };
      }
    });

    // Tool: iumbtems_brainstorm (lateral ideation)
    pi.registerTool({
      name: 'iumbtems_brainstorm',
      description: 'Run lateral brainstorming: novel feature vectors, paradigm inversions, falsifiable spikes',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Ambiguous exploration prompt' },
          mock_mode: { type: 'boolean', description: 'Mock mode without LLM tokens', default: false }
        },
        required: ['objective']
      },
      execute: async (args = {}) => {
        const r = callMcp('iumbtems_brainstorm', {
          objective: args.objective || 'Where do we go from here?',
          mock_claude: Boolean(args.mock_mode)
        }, {});
        return { content: [{ type: 'text', text: r.text }] };
      }
    });

    // Tool: iumbtems_darkharvest (competitor teardown)
    pi.registerTool({
      name: 'iumbtems_darkharvest',
      description: 'Product competitor teardown with per-feature harvest verdicts and SPDX attribution',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Product arena to tear down' },
          seeds: { type: 'array', items: { type: 'string' }, description: 'Seed inspiration repo URLs' },
          maxRepos: { type: 'integer', description: 'Cap on total competitors', default: 10 },
          mock_mode: { type: 'boolean', description: 'Mock mode without LLM tokens', default: false }
        },
        required: ['objective']
      },
      execute: async (args = {}) => {
        const r = callMcp('iumbtems_darkharvest', {
          objective: args.objective,
          seeds: args.seeds,
          maxRepos: args.maxRepos,
          mock_claude: Boolean(args.mock_mode)
        }, {});
        return { content: [{ type: 'text', text: r.text }] };
      }
    });
  }
}

/** Map a structured args object onto the iumbtems_config tool contract. */
function parseConfigArgsFromObject(args = {}) {
  const out = {};
  if (args.search_engine) out.search_engine = args.search_engine;
  if (args.max_iterations) out.max_iterations = args.max_iterations;
  if (args.mode) out.mode = args.mode;
  if (args.divergence_threshold !== undefined) out.divergence_threshold = args.divergence_threshold;
  return out;
}
