/**
 * IUMBTEMS: I Use My Brain To Express My Self
 * Native Extension for Pi (pi.dev)
 * 
 * Exposes /swarm, /grill, /swarm-config, /audit, /scout, and /brainstorming
 * slash commands along with epistemic verification and configuration
 * tools in Pi (and OMP via the shared pi/omp extension entry point).
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '../..');

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
        const runnerPath = path.join(PKG_ROOT, 'runner/research_swarm.py');
        const res = spawnSync('python3', [runnerPath, '--objective', objective], {
          encoding: 'utf-8',
          cwd: ctx.cwd || process.cwd(),
          env: { ...process.env, PYTHONPATH: PKG_ROOT }
        });

        if (res.status === 0) {
          ctx.output?.(res.stdout);
          ctx.output?.('\n✅ Research complete! Summary written to .research/final_synthesis.md');
        } else {
          ctx.output?.(`❌ Swarm failed:\n${res.stderr || res.stdout}`);
        }
      }
    });

    // /grill: Socratic assumption-inversion
    pi.registerCommand('grill', {
      description: 'Launch Socratic grilling and decision tree frontier exploration',
      usage: '/grill [--objective <text>]',
      handler: async (args, ctx) => {
        ctx.output?.('🧠 [IUMBTEMS] Launching Socratic Grilling decision tree...');
        const treePath = path.join(PKG_ROOT, 'skills/grilling/socratic_tree.py');
        const forwardArgs = args.trim() ? ['--objective', args.trim()] : ['--show-frontier'];
        const res = spawnSync('python3', [treePath, ...forwardArgs], {
          encoding: 'utf-8',
          cwd: ctx.cwd || process.cwd()
        });
        ctx.output?.(res.stdout || res.stderr);
      }
    });

    // /swarm-config: Inspect and tune research parameters
    pi.registerCommand('swarm-config', {
      description: 'Inspect or update Epistemic Swarm parameters (engine, depth, mode)',
      usage: '/swarm-config [--engine <e>] [--depth <d>] [--mode <m>] [--show]',
      handler: async (args, ctx) => {
        const configScript = path.join(PKG_ROOT, 'skills/swarm_config/configure.py');
        const rawArgs = args.trim() ? args.trim().split(/\s+/) : ['--show'];
        const res = spawnSync('python3', [configScript, ...rawArgs], {
          encoding: 'utf-8',
          cwd: ctx.cwd || process.cwd(),
          env: { ...process.env, PYTHONPATH: PKG_ROOT }
        });
        ctx.output?.(res.stdout || res.stderr);
      }
    });

    // /audit: Dialectic codebase architecture & security audit
    pi.registerCommand('audit', {
      description: 'Run dialectic codebase architectural and security audit with line-level proof',
      usage: '/audit <target_path_or_scope>',
      handler: async (args, ctx) => {
        const target = args.trim() || 'Full repository architecture and vulnerability audit';
        ctx.output?.(`🛡️ [IUMBTEMS Audit] Launching Codebase Audit for: "${target}"...`);
        const runnerPath = path.join(PKG_ROOT, 'runner/research_swarm.py');
        const res = spawnSync('python3', [runnerPath, '--mode', 'audit', '--objective', target], {
          encoding: 'utf-8',
          cwd: ctx.cwd || process.cwd(),
          env: { ...process.env, PYTHONPATH: PKG_ROOT }
        });
        if (res.status === 0) {
          ctx.output?.(res.stdout);
          ctx.output?.('\n✅ Audit complete! Report written to .research/code_audit_report.md');
        } else {
          ctx.output?.(`❌ Audit failed:\n${res.stderr || res.stdout}`);
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
        const runnerPath = path.join(PKG_ROOT, 'runner/research_swarm.py');
        const res = spawnSync('python3', [runnerPath, '--mode', 'scout', '--objective', feature], {
          encoding: 'utf-8',
          cwd: ctx.cwd || process.cwd(),
          env: { ...process.env, PYTHONPATH: PKG_ROOT }
        });
        if (res.status === 0) {
          ctx.output?.(res.stdout);
          ctx.output?.('\n✅ Scout complete! Blueprint written to .research/oss_scout_report.md');
        } else {
          ctx.output?.(`❌ Scout failed:\n${res.stderr || res.stdout}`);
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
        const scaffold = path.join(PKG_ROOT, 'skills/brainstorming/scripts/brainstorm.py');
        const pre = spawnSync('python3', [scaffold, '--objective', objective, '--show-context'], {
          encoding: 'utf-8',
          cwd: ctx.cwd || process.cwd()
        });
        ctx.output?.(pre.stdout || pre.stderr);
        const runnerPath = path.join(PKG_ROOT, 'runner/research_swarm.py');
        const res = spawnSync('python3', [runnerPath, '--mode', 'brainstorm', '--objective', objective], {
          encoding: 'utf-8',
          cwd: ctx.cwd || process.cwd(),
          env: { ...process.env, PYTHONPATH: PKG_ROOT }
        });
        if (res.status === 0) {
          ctx.output?.(res.stdout);
          ctx.output?.('\n✅ Brainstorm complete! Portfolio written to .research/brainstorm_report.md');
        } else {
          ctx.output?.(`❌ Brainstorm failed:\n${res.stderr || res.stdout}`);
        }
      }
    });

    // /brainstorm alias
    if (typeof pi.registerCommand === 'function') {
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
    }
  }

  // 2. Register Agent Tools
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
      execute: async ({ hash, quote }) => {
        const hasherPath = path.join(PKG_ROOT, 'skills/research-cache/hasher.py');
        const res = spawnSync('python3', [hasherPath, 'verify', '--hash', hash, '--quote', quote], {
          encoding: 'utf-8'
        });
        return {
          content: [{ type: 'text', text: res.stdout || res.stderr }]
        };
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
          mode: { type: 'string', enum: ['research', 'audit', 'scout', 'hybrid', 'brainstorm'] },
          divergence_threshold: { type: 'number', minimum: 0, maximum: 1 },
          show: { type: 'boolean', default: false }
        }
      },
      execute: async (args = {}) => {
        const configScript = path.join(PKG_ROOT, 'skills/swarm_config/configure.py');
        const cmdArgs = [configScript];
        if (args.show || (!args.search_engine && !args.max_iterations && !args.mode && args.divergence_threshold === undefined)) {
          cmdArgs.push('--show');
        } else {
          if (args.search_engine) cmdArgs.push('--engine', args.search_engine);
          if (args.max_iterations) cmdArgs.push('--depth', String(args.max_iterations));
          if (args.mode) cmdArgs.push('--mode', args.mode);
          if (args.divergence_threshold !== undefined) cmdArgs.push('--divergence', String(args.divergence_threshold));
        }

        const res = spawnSync('python3', cmdArgs, {
          encoding: 'utf-8',
          env: { ...process.env, PYTHONPATH: PKG_ROOT }
        });
        return {
          content: [{ type: 'text', text: res.stdout || res.stderr }]
        };
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
        const runnerPath = path.join(PKG_ROOT, 'runner/research_swarm.py');
        const cmdArgs = [runnerPath, '--mode', 'brainstorm', '--objective', args.objective || 'Where do we go from here?'];
        if (args.mock_mode) cmdArgs.push('--mock-claude');
        const res = spawnSync('python3', cmdArgs, {
          encoding: 'utf-8',
          env: { ...process.env, PYTHONPATH: PKG_ROOT }
        });
        return {
          content: [{ type: 'text', text: res.stdout || res.stderr }]
        };
      }
    });
  }
}
