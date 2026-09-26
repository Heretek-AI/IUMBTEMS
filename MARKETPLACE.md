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

---

## 🛠️ Plugin Details & Component Breakdown

### 1. `epistemic-swarm` (Flagship Harness)
- **Manifest**: [`.claude-plugin/plugin.json`](file:///.claude-plugin/plugin.json)
- **Components**:
  - **Skills**: `skills/grilling`, `skills/research-cache`
  - **MCP Servers**:
    - `brave-search`: Real-time web discovery SERP.
    - `firecrawl`: Deep JS-rendered markdown extraction.
    - `searxng`: Unbiased metasearch aggregator.
  - **System Prompts**: Base Epistemic System Override, Agent Alpha, Agent Beta, Epistemic Auditor, Orchestrator.
- **Install**:
  ```bash
  claude plugin install epistemic-swarm@heretek-official
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
  - **Skill & Engine**: `skills/research-cache` (Content-addressed SHA256 raw source storage and quote validation).
- **Install**:
  ```bash
  claude plugin install research-cache@heretek-official
  ```

---

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
