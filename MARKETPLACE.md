# Heretek AI Claude Code Marketplace 🏪

Official marketplace catalog for Claude Code plugins, skills, and autonomous agent harnesses developed by [Heretek AI](https://github.com/Heretek-AI).

[![Claude Code Compatible](https://img.shields.io/badge/Claude_Code-2.1+-blue.svg)](https://claude.com)
[![Marketplace Validated](https://img.shields.io/badge/Marketplace-Validated_Strict-success.svg)](https://github.com/Heretek-AI/IUMBTEMS/actions/workflows/validate-marketplace.yml)
[![npm version](https://img.shields.io/npm/v/@heretek-ai/epistemic-swarm.svg)](https://www.npmjs.com/package/@heretek-ai/epistemic-swarm)

---

## 🚀 Quick Start: Adding the Marketplace

To register the **`heretek-official`** marketplace in Claude Code, run:

```bash
claude plugin marketplace add Heretek-AI/IUMBTEMS
```

Verify that the marketplace is configured:
```bash
claude plugin marketplace list
```

---

## 📦 Available Plugins

| Plugin Name | Category | Description | Install Command |
|---|---|---|---|
| **`epistemic-swarm`** | `research` | **Flagship Swarm Harness**: Multi-agent dialectic research harness pairing Agent Alpha (Thesis) against Agent Beta (Red Team), audited by an Epistemic Auditor with verbatim empirical quote validation. | `claude plugin install epistemic-swarm@heretek-official` |
| **`socratic-grilling`** | `agents` | **Socratic Ideation**: Matt Pocock-style Socratic interrogation, premise inversion, and lateral exploration skill. | `claude plugin install socratic-grilling@heretek-official` |
| **`research-cache`** | `research` | **Source Hasher**: Content-addressed SHA256 Markdown source hashing and verbatim quote verification engine. | `claude plugin install research-cache@heretek-official` |
| **`darkharvest`** | `research` | **Competitor Teardown**: Product-level teardown with per-feature `depend\|vendor\|clean-room\|skip` verdicts and SPDX attribution. | `claude plugin install darkharvest@heretek-official` |
| **`factory`** | `agents` | **Coding Factory**: Manager loop with grill-gated phases, programmer spawns, and dual QA. | `claude plugin install factory@heretek-official` |

---

## 🛠️ Plugin Details & Component Breakdown

### 1. `epistemic-swarm` (Flagship Harness)
- **Manifest**: [`.claude-plugin/plugin.json`](file:///.claude-plugin/plugin.json)
- **Components**:
  - **Skills** (9): `skills/grilling`, `skills/research_cache`, `skills/epistemic_search`, `skills/swarm_config`, `skills/code_audit`, `skills/oss_scout`, `skills/brainstorming`, `skills/darkharvest`, `skills/factory`
  - **Agent Tools** (MCP): `iumbtems_swarm_research`, `iumbtems_code_audit`, `iumbtems_oss_scout`, `iumbtems_brainstorm`, `iumbtems_darkharvest`, `iumbtems_factory`, `iumbtems_config`, `iumbtems_verify_quote`, `iumbtems_socratic_frontier`, plus the brief/ledger/domain-pack tools (`export_brief`, `verify_brief`, `reindex_claims`, `report_retraction`, `check_staleness`, `set_domain_pack`)
  - **Hooks**: `hooks/hooks.json` (`PreToolUse` hook intercepting ungrounded `WebSearch` and `WebFetch` to enforce verifiable SHA-256 caching)
  - **Zero-Key Search**: DuckDuckGo Lite search and automated content-addressed document caching out of the box (zero API key required).
  - **Safe MCP Servers & Accelerators**:
    - `brave-search`: Optional Brave SERP discovery (falls back smoothly to DuckDuckGo when unconfigured).
    - `firecrawl`: Optional Firecrawl JS extraction (falls back smoothly to clean readability reader when unconfigured).
    - `searxng`: Optional self-hosted metasearch instance proxy.
  - **System Prompts**: Base Epistemic System Override, Agent Alpha, Agent Beta, Epistemic Auditor, Orchestrator.
- **Install & Configuration**:
  ```bash
  claude plugin install epistemic-swarm@heretek-official
  # Configure optional API keys and endpoints interactively:
  claude plugin configure epistemic-swarm
  # Or inside Claude Code interactive session: /plugin configure
  ```

### 2. `socratic-grilling` (Modular Skill)
- **Manifest**: [`plugins/socratic-grilling/.claude-plugin/plugin.json`](file:///plugins/socratic-grilling/.claude-plugin/plugin.json)
- **Components**:
  - **Skill**: `skills/grilling` (`/grilling` slash command and interactive decision tree).
- **Install**:
  ```bash
  claude plugin install socratic-grilling@heretek-official
  ```

### 3. `research-cache` (Modular Tool)
- **Manifest**: [`plugins/research-cache/.claude-plugin/plugin.json`](file:///plugins/research-cache/.claude-plugin/plugin.json)
- **Components**:
  - **Skill & Engine**: `skills/research_cache` (published under the plugin id `research-cache`) — content-addressed SHA-256 raw source storage and verbatim quote validation.
- **Install**:
  ```bash
  claude plugin install research-cache@heretek-official
  ```

### 4. `darkharvest` (Modular Tool)
- **Manifest**: [`plugins/darkharvest/.claude-plugin/plugin.json`](file:///plugins/darkharvest/.claude-plugin/plugin.json)
- **Components**:
  - **Skill**: `skills/darkharvest` (competitor × capability teardown).
  - **Agents**: `harvest-proponent` (per-feature verdicts), `harvest-redteam` (license/Bloat/CVE vetting).
  - **Evals**: `plugins/darkharvest/evals/teardown-verdict` (skill fires + license-line rubric).
- **Install**:
  ```bash
  claude plugin install darkharvest@heretek-official
  ```

### 5. `factory` (Modular Agent Pack)
- **Manifest**: [`plugins/factory/.claude-plugin/plugin.json`](file:///plugins/factory/.claude-plugin/plugin.json)
- **Components**:
  - **Skill**: `skills/factory` (Manager loop, gates, QA bounds).
  - **Agents**: `factory-manager`, `programmer`, `qa-functional`, `qa-adversarial`.
  - **Evals**: `plugins/factory/evals/gate-halt` (skill fires + gates-first rubric).
- **Install**:
  ```bash
  claude plugin install factory@heretek-official
  ```

### Flagship agents & evals
- **Agents** (repo-root `agents/`): `alpha-thesis`, `beta-antithesis`, `epistemic-auditor` — condensed from `prompts/agent_alpha_thesis.md`, `prompts/agent_beta_antithesis.md`, `prompts/epistemic_auditor.md`.
- **Evals** (repo-root `evals/`): `grill-fires`, `darkharvest-fires`, `factory-gate` — each `prompt.md` plus `tool_used: Skill` and `llm` graders. Run `claude plugin eval .` (billable model calls); CI gates via `.github/workflows/plugin-evals.yml` on release/dispatch.

---

## 💡 Lateral Brainstorming (`/brainstorming`)

Divergent ideation subagent (Thesis / Radical Antithesis / Synthesis) producing
Novel Feature Vectors, Lateral Architectural Moves, and falsifiable spike hypotheses.
Skill: `skills/brainstorming/SKILL.md` (`/brainstorming <prompt>`), system prompt:
`prompts/agent_brainstormer.md`, runner: `python3 runner/research_swarm.py --mode brainstorm --objective "<prompt>" --mock-claude`.
Available on all seven harnesses (Claude Code, OpenCode `iumbtems_brainstorm`, Pi/OMP `/brainstorming`, Gemini `/brainstorming`, Codex `$brainstorming`, AntiGravity skill).

## 🔍 Inspecting Installed Plugins

To view installed plugins and their active components:
```bash
claude plugin list
claude plugin details epistemic-swarm@heretek-official
```

To update all installed plugins to their latest versions:
```bash
claude plugin update epistemic-swarm
```

To uninstall:
```bash
claude plugin uninstall epistemic-swarm
```
