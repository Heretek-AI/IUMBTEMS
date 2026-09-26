/**
 * IUMBTEMS: I Use My Brain To Express My Self
 * Native Extension for Pi (pi.dev)
 * 
 * Exposes /grill and /swarm slash commands and epistemic verification tools in Pi.
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

  // 1. Register /swarm slash command
  if (typeof pi.registerCommand === 'function') {
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

    // 2. Register /grill slash command
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
  }

  // 3. Register tool for epistemic quote verification
  if (typeof pi.registerTool === 'function') {
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
  }
}
