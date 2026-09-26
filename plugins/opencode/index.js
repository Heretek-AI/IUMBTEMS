/**
 * IUMBTEMS: I Use My Brain To Express My Self
 * Native Plugin for OpenCode V2 (opencode.ai)
 * 
 * Exposes dialectic swarm research tools, codebase auditing, open-source scouting,
 * configuration management, and content-addressed quote verification directly into OpenCode V2 agents.
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
    version: "0.2.3",
    description: "I Use My Brain To Express My Self: High-integrity dialectic research, code audits, and open-source scouting",

    server: (toolContext) => [
      {
        name: "iumbtems_config",
        description: "Inspect or modify the active Epistemic Swarm configuration (search engine, depth/iterations, operating mode, divergence threshold) in .research/config.json.",
        input: {
          type: "object",
          properties: {
            search_engine: {
              type: "string",
              enum: ["duckduckgo", "brave", "firecrawl", "searxng"],
              description: "Primary search engine (duckduckgo is the zero-key free default)"
            },
            max_iterations: {
              type: "integer",
              minimum: 1,
              maximum: 4,
              description: "Maximum dialectic research iterations / depth (1-4)"
            },
            mode: {
              type: "string",
              enum: ["research", "audit", "scout", "hybrid"],
              description: "Operating mode: research (literature), audit (codebase), scout (OSS), hybrid"
            },
            divergence_threshold: {
              type: "number",
              minimum: 0.0,
              maximum: 1.0,
              description: "Auditor divergence threshold (default 0.75)"
            },
            show: {
              type: "boolean",
              description: "Just inspect current configuration without modifying",
              default: false
            }
          }
        },
        options: { codemode: false },
        execute: async (args = {}) => {
          const configScript = path.join(PKG_ROOT, "skills/swarm_config/configure.py");
          const cmdArgs = [configScript];

          if (args.show || (!args.search_engine && !args.max_iterations && !args.mode && args.divergence_threshold === undefined)) {
            cmdArgs.push("--show");
          } else {
            if (args.search_engine) cmdArgs.push("--engine", args.search_engine);
            if (args.max_iterations) cmdArgs.push("--depth", String(args.max_iterations));
            if (args.mode) cmdArgs.push("--mode", args.mode);
            if (args.divergence_threshold !== undefined) cmdArgs.push("--divergence", String(args.divergence_threshold));
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
        name: "iumbtems_code_audit",
        description: "Run a dialectic codebase architectural and security audit pairing a structural architect with an adversarial red-teamer.",
        input: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Target directory, file, or architectural component to audit"
            },
            mock_mode: {
              type: "boolean",
              description: "Run in mock mode without invoking LLM tokens",
              default: false
            }
          },
          required: ["target"]
        },
        options: { codemode: false },
        execute: async (args) => {
          const runnerPath = path.join(PKG_ROOT, "runner/research_swarm.py");
          const cmdArgs = [runnerPath, "--mode", "audit", "--objective", args.target];
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
        name: "iumbtems_oss_scout",
        description: "Scout open-source software libraries, benchmark candidate implementations, red-team viral copyleft (GPL/AGPL), and produce clean-room implementation blueprints.",
        input: {
          type: "object",
          properties: {
            feature: {
              type: "string",
              description: "The feature, algorithm, or capability to scout in open source"
            },
            mock_mode: {
              type: "boolean",
              description: "Run in mock mode without invoking LLM tokens",
              default: false
            }
          },
          required: ["feature"]
        },
        options: { codemode: false },
        execute: async (args) => {
          const runnerPath = path.join(PKG_ROOT, "runner/research_swarm.py");
          const cmdArgs = [runnerPath, "--mode", "scout", "--objective", args.feature];
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
      const opts = context.options || appContext?.options;
      if (opts && typeof opts === "object") {
        const configScript = path.join(PKG_ROOT, "skills/swarm_config/configure.py");
        const cmdArgs = [configScript];
        if (opts.search_engine) cmdArgs.push("--engine", opts.search_engine);
        if (opts.max_iterations) cmdArgs.push("--depth", String(opts.max_iterations));
        if (opts.mode) cmdArgs.push("--mode", opts.mode);
        if (opts.divergence_threshold !== undefined) cmdArgs.push("--divergence", String(opts.divergence_threshold));
        if (cmdArgs.length > 1) {
          spawnSync("python3", cmdArgs, {
            cwd: appContext?.cwd || toolContext?.cwd || process.cwd(),
            env: { ...process.env, PYTHONPATH: PKG_ROOT }
          });
        }
      }
      return { initialized: true, platform: "opencode-v2" };
    }
  };
}

const defaultPlugin = createOpenCodePlugin();
export default defaultPlugin;
