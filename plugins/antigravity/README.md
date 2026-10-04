# IUMBTEMS for AntiGravity

First-class native AntiGravity plugin (`agy`) delivering dialectic research, architecture auditing, competitor teardowns, lateral brainstorming, Socratic planning, and automated quality gates.

## Installation

Install directly using the Antigravity CLI:

```bash
# Install from local clone:
agy plugin install /path/to/IUMBTEMS/plugins/antigravity

# Or install from GitHub repository:
agy plugin install https://github.com/Heretek-AI/IUMBTEMS --path plugins/antigravity

# Inspect installed plugin status:
agy plugin list
agy plugin validate /path/to/IUMBTEMS/plugins/antigravity
```

## Plugin Architecture

```text
plugins/antigravity/
├── plugin.json          # Manifest conforming to https://antigravity.google/schemas/v1/plugin.json
├── hooks.json           # PreToolUse, PreInvocation, PostToolUse, and Stop lifecycle hooks
├── antigravity_hooks.py # Python lifecycle dispatcher with zero-overhead fast-paths
├── hook_bus_bridge.js   # 6-event Hook Bus & Quality Gates bridge (Analysis, Dep Health, Weight)
├── mcp_config.json      # First-party stdio MCP server (17 iumbtems_* tools) + search fallbacks
├── mcp_launcher.py      # MCP runtime launcher and environment resolver
├── commands/            # Interactive slash commands (/audit, /swarm, /grill, /factory, etc.)
├── agents/              # Specialized subagents (alpha-thesis, beta-antithesis, auditor, etc.)
├── rules/               # Workspace rules (AGENTS.md and epistemic-integrity.md)
└── skills/              # Generated skill stubs for progressive disclosure
```

## Slash Commands
In the `agy` TUI prompt box, type `/` to access commands:
- `/audit <target>`: Dialectic codebase architecture and security audit with line-level proof.
- `/swarm <objective>`: Dialectic multi-agent research swarm (Alpha thesis vs. Beta red-team).
- `/grill <objective>`: Socratic assumption-inversion and decision tree frontier exploration.
- `/darkharvest <arena>`: Competitor teardown and clean-room blueprint extraction.
- `/factory <action>`: Phased engineering factory with dual QA gating.
- `/scout <feature>`: Open-source package discovery and copyleft license auditing.
- `/brainstorming <prompt>`: Divergent lateral ideation and falsifiable spikes.
- `/brainstorm <prompt>`: Alias for `/brainstorming`.
- `/domainexpansion <query>`: Domain pack discovery and frontier synthesis.
- `/swarm-config`: Interactive inspection and configuration of research parameters.

## Subagents
Manage and delegate to specialized subagents using the `/agents` panel or `Alt+J` navigation:
- `alpha-thesis`: Proponent agent gathering primary sources and benchmark proofs.
- `beta-antithesis`: Adversarial falsification, counter-benchmarks, and edge cases.
- `epistemic-auditor`: Verbatim citation verification and evidence scoring.
- `code-auditor`: Static analysis and vulnerability red-teaming.
- `oss-scout`: Library discovery and clean-room blueprints.
- `brainstormer`: Divergent lateral ideation (never bug fixes).
- `darkharvester`: Competitor teardown matrix and harvest verdicts.
- `manager`: Factory loop orchestrator (gate control, no code writing).
- `programmer`: Single phase implementation citing phase evidence.
- `qa-a`: Functional QA (verifies acceptance criteria).
- `qa-b`: Adversarial QA (hunts edge cases and loopholes).

## Lifecycle Interception & Quality Gates
- **Search Interception**: Web searches and fetches are intercepted to ensure citations are content-addressed and stored in `.research/sources/<sha256>.md`.
- **PreCommit Gating**: File writes to `.research/config.json` are gated by schema validation and `expected_hash` optimistic concurrency.
- **Analysis Bridge**: Advisory Biome static analysis checks modified JS/TS files in fast tier.
- **Dependency Health**: Advisory OSV.dev vulnerability auditing scans npm, pip, Dockerfile, and GitHub Actions dependencies.
- **Weight Signals**: Advisory esbuild bundling tracks package weight and coverage deltas against checked-in baselines.
- **Compaction Preservation**: Preserves `.research` state (mode, engine, depth, degraded claims, requeued scopes) across context compaction turns.
- **Termination Gating**: The agent loop is gated from stopping prematurely if unresolved claims (`STALE`/`SUSPECT`) or failing gates remain in `.research/`.
- **MCP Tools**: All 17 canonical `iumbtems_*` tools are exposed via `runner/mcp_server.py`.
