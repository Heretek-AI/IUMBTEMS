/**
 * IUMBTEMS: I Use My Brain To Express My Self
 * Native Extension for Pi (pi.dev)
 * 
 * Exposes /swarm, /grill, /swarm-config, /audit, and /scout slash commands
 * along with epistemic verification and configuration tools in Pi.
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
          mode: { type: 'string', enum: ['research', 'audit', 'scout', 'hybrid'] },
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
  }
}
