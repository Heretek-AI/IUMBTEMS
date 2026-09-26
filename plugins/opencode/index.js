/**
 * IUMBTEMS: I Use My Brain To Express My Self
 * Native Plugin for OpenCode V2 (opencode.ai)
 * 
 * Exposes dialectic swarm research tools, Socratic decision frontier calculation,
 * and content-addressed quote verification directly into OpenCode V2 agents.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '../..');

export function createOpenCodePlugin(context = {}) {
  return {
    id: "heretek.iumbtems.epistemic-swarm",
    name: "IUMBTEMS Epistemic Swarm",
    version: "0.1.0",
    description: "I Use My Brain To Express My Self: Dialectic research swarm enforcing empirical verification",

    server: (toolContext) => [
      {
        name: "iumbtems_swarm_research",
        description: "Execute an autonomous dialectic research swarm on an objective using Agent Alpha (Thesis) and Agent Beta (Red Team).",
        input: {
          type: "object",
          properties: {
            objective: {
              type: "string",
              description: "The research question or hypothesis to investigate"
            },
            mock_mode: {
              type: "boolean",
              description: "Run in mock/dry-run mode without external API charges",
              default: false
            }
          },
          required: ["objective"]
        },
        options: { codemode: false },
        execute: async (args) => {
          const runnerPath = path.join(PKG_ROOT, "runner/research_swarm.py");
          const cmdArgs = [runnerPath, "--objective", args.objective];
          if (args.mock_mode) {
            cmdArgs.push("--mock-claude");
          }

          const res = spawnSync("python3", cmdArgs, {
            encoding: "utf-8",
            cwd: toolContext?.cwd || process.cwd(),
            env: { ...process.env, PYTHONPATH: PKG_ROOT }
          });

          return {
            content: res.stdout || res.stderr,
            status: res.status === 0 ? "success" : "error"
          };
        }
      },

      {
        name: "iumbtems_verify_quote",
        description: "Cryptographically verify whether a cited quote matches verbatim text inside the content-addressed source cache.",
        input: {
          type: "object",
          properties: {
            hash: {
              type: "string",
              description: "SHA-256 hash or prefix of the cached source"
            },
            quote: {
              type: "string",
              description: "The verbatim excerpt to verify"
            }
          },
          required: ["hash", "quote"]
        },
        options: { codemode: false },
        execute: async (args) => {
          const hasherPath = path.join(PKG_ROOT, "skills/research-cache/hasher.py");
          const res = spawnSync("python3", [hasherPath, "verify", "--hash", args.hash, "--quote", args.quote], {
            encoding: "utf-8",
            cwd: toolContext?.cwd || process.cwd()
          });

          return {
            content: res.stdout || res.stderr,
            status: res.status === 0 ? "verified" : "failed"
          };
        }
      },

      {
        name: "iumbtems_socratic_frontier",
        description: "Inspect or advance the Socratic grilling decision frontier for research framing.",
        input: {
          type: "object",
          properties: {
            objective: {
              type: "string",
              description: "Research objective to inspect"
            },
            settle_node: {
              type: "string",
              description: "Optional node ID to settle with an answer"
            },
            settle_answer: {
              type: "string",
              description: "Answer for the settled node"
            }
          }
        },
        options: { codemode: false },
        execute: async (args) => {
          const treePath = path.join(PKG_ROOT, "skills/grilling/socratic_tree.py");
          const cmdArgs = [treePath];

          if (args.settle_node && args.settle_answer) {
            cmdArgs.push("--settle", args.settle_node, args.settle_answer);
          } else if (args.objective) {
            cmdArgs.push("--objective", args.objective, "--show-frontier");
          } else {
            cmdArgs.push("--show-frontier");
          }

          const res = spawnSync("python3", cmdArgs, {
            encoding: "utf-8",
            cwd: toolContext?.cwd || process.cwd()
          });

          return {
            content: res.stdout || res.stderr
          };
        }
      }
    ],

    setup: async (appContext) => {
      // OpenCode V2 lifecycle hook
      return { initialized: true, platform: "opencode-v2" };
    }
  };
}

const defaultPlugin = createOpenCodePlugin();
export default defaultPlugin;
