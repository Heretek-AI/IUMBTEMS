# IUMBTEMS: I Use My Brain To Express My Self 🧠

[![npm version](https://img.shields.io/npm/v/@heretek-ai/epistemic-swarm.svg)](https://www.npmjs.com/package/@heretek-ai/epistemic-swarm)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI/CD](https://github.com/Heretek-AI/IUMBTEMS/actions/workflows/publish.yml/badge.svg)](https://github.com/Heretek-AI/IUMBTEMS/actions)
[![Marketplace Validated](https://github.com/Heretek-AI/IUMBTEMS/actions/workflows/validate-marketplace.yml/badge.svg)](https://github.com/Heretek-AI/IUMBTEMS/actions)

> **High-Integrity Dialectic Research Agent Harness**  
> *Universal support for Claude Code, OpenCode V2, Pi (pi.dev), OMP (oh-my-pi), Gemini CLI, Codex CLI, and AntiGravity.*  
> *Enforcing verified empirical evidence over parametric hallucination.*

---

## 💡 The Philosophy of IUMBTEMS

**IUMBTEMS** (**I Use My Brain To Express My Self**) is grounded in a singular design mandate: **Epistemic Sovereignty**.

Modern LLMs suffer from parametric hallucination, sycophancy, and premature narrative consensus. They invent citations, smooth over technical contradictions, and extrapolate beyond empirical bounds.

**IUMBTEMS** restores rigorous empirical grounding by pairing an unconstrained divergent exploration phase (Matt Pocock-style Socratic grilling and assumption inversion) with a multi-agent dialectic swarm:
1. **Agent Alpha (The Proponent / Thesis)**: Gathers corroborating primary sources, empirical proofs, and implementation benchmarks.
2. **Agent Beta (The Adversary / Antithesis / Red Team)**: Hunts for counter-arguments, retracted data, methodology flaws, and edge-case failures.
3. **Epistemic Auditor**: Verifies cited quotes verbatim against content-addressed raw markdown caches (`.research/sources/<sha256>.md`), prunes ungrounded assertions, and scores dialectic divergence.

---

## 🌐 Universal Multi-Platform Support

IUMBTEMS is packaged as a single universal npm package (`@heretek-ai/epistemic-swarm` with `iumbtems` binary) that runs across seven major autonomous agent harnesses.
Single source of truth: `skills/*` + `prompts/*`. The canonical programmatic surface is the first-party MCP server (`python3 runner/mcp_server.py`), which exposes the `iumbtems_*` tools in-process. Harness targets register that server and carry only thin skill stubs generated with `python3 scripts/build_adapters.py` (`iumbtems adapters`) into `plugins/*`, `.agents/skills` — stubs point at the canonical `skills/*` prose instead of copying code.

### 1. Claude Code (Native Marketplace & Overlay)

#### Native Marketplace (Recommended)
Add the official Heretek AI marketplace to Claude Code:
```bash
claude plugin marketplace add Heretek-AI/IUMBTEMS
```
Then install either the flagship harness or modular standalone plugins:
```bash
# Flagship dialectic research harness:
claude plugin install epistemic-swarm@heretek-official

# Or install standalone modular plugins:
claude plugin install socratic-grilling@heretek-official
claude plugin install research-cache@heretek-official
```
See [MARKETPLACE.md](MARKETPLACE.md) for full component specifications.

#### CLI Overlay Installer
Install skills and MCP servers directly into `~/.claude/` and `~/.claude.json`:
```bash
npx @heretek-ai/epistemic-swarm install
# or from local repo:
npm run install-local
```
- Run `/grilling` inside any interactive Claude Code session.
- Run headless dialectic research:
  ```bash
  iumbtems run "Evaluate FPGA Poseidon prover latency bounds"
  ```

### 2. Pi (`pi.dev`)
Install directly into Pi via its native package manager:
```bash
pi install npm:@heretek-ai/epistemic-swarm
```
- **Slash Commands**:
  - `/swarm <objective>`: Run autonomous dialectic research swarm
  - `/grill`: Launch Socratic assumption-inversion and decision trees
  - `/swarm-config`: Inspect or tune search engine, depth (1-4), and mode
  - `/audit <target>`: Run dialectic codebase architecture and security audit
  - `/scout <feature>`: Scout open-source software and clean-room blueprints
- **Agent Tools**: `iumbtems_config`, `iumbtems_verify_quote`, `iumbtems_brainstorm`.
- OMP (`omp.sh`, oh-my-pi) shares the same entry point: `omp install npm:@heretek-ai/epistemic-swarm`, project commands in `.omp/commands/` (`/swarm`, `/grill`, `/audit`, `/scout`, `/brainstorming`, `/swarm-config`), prompts in `.omp/prompts/`, hooks in `.omp/hooks/pre|post/`.
- All commands automatically respect `.research/config.json`.

### 3. OpenCode V2 (`opencode.ai`)
Enable IUMBTEMS in your `~/.config/opencode/opencode.json` or project `opencode.jsonc`. You can configure settings declaratively:
```json
{
  "plugin": [
    [
      "@heretek-ai/epistemic-swarm",
      {
        "search_engine": "duckduckgo",
        "max_iterations": 2,
        "mode": "research"
      }
    ]
  ]
}
```
OpenCode V2 automatically registers the full tool suite:
- `iumbtems_config`: Inspect or dynamically adjust active parameters in `.research/config.json`.
- `iumbtems_code_audit`: Dispatches dialectic codebase review (structural architect vs. red-team).
- `iumbtems_oss_scout`: Scouts open-source libraries, audits licenses, and builds clean-room blueprints.
- `iumbtems_swarm_research`: Dispatches dialectic researcher pairs (Thesis vs. Antithesis).
- `iumbtems_verify_quote`: Audits verbatim citations against the SHA-256 source cache.
- `iumbtems_socratic_frontier`: Advances the Socratic decision tree frontier.
- `iumbtems_brainstorm`: Lateral ideation portfolio (feature vectors + paradigm moves + falsifiable spikes).

*(See [config/opencode-snippet.json](config/opencode-snippet.json) for custom agent definitions).*

### 4. Gemini CLI
```bash
gemini extensions install https://github.com/Heretek-AI/IUMBTEMS --path plugins/gemini
# local dev: gemini extensions link ./plugins/gemini
```
Bundle: `plugins/gemini/gemini-extension.json` (MCP servers, incl. the canonical `iumbtems` server), `GEMINI.md` (context), `commands/*.toml` (`/swarm`, `/grill`, `/audit`, `/scout`, `/brainstorming`, `/swarm-config`), `hooks/hooks.json`, `skills/` thin stubs.

### 5. Codex CLI
Codex reads repo-local `.agents/skills/*` (already generated in this repo) — `$brainstorming <prompt>` or implicit activation. Distributable pack in `plugins/codex/` (`openai.yaml`, `config.toml.snippet` for `[mcp_servers.*]`, `AGENTS.md.snippet`). Legacy `~/.codex/prompts/*.md` (`/prompts:<name>`) is deprecated; use skills.

### 6. Google AntiGravity (`agy`)
```bash
agy plugin install https://github.com/Heretek-AI/IUMBTEMS --path plugins/antigravity
agy plugin validate ./plugins/antigravity
```
Bundle: `plugins/antigravity/plugin.json`, `mcp_config.json`, `hooks.json`, `skills/` thin stubs, `agents/` (alpha/beta/auditor/brainstormer), `rules/epistemic-integrity.md`.

### 7. OMP (oh-my-pi, `omp.sh`)
```bash
omp install npm:@heretek-ai/epistemic-swarm
```
Shares the pi extension entry point (`package.json: {omp, pi}` blocks). Project-local slash commands (`.omp/commands/*.md`), prompt templates (`.omp/prompts/*.md`), hooks (`.omp/hooks/pre|post/*.ts`), system override (`.omp/SYSTEM.md`).

---

## ⚡ CLI Command Reference

```bash
# Inspect or update active configuration (search engine, depth, mode)
iumbtems config
iumbtems config --engine duckduckgo --depth 3 --mode audit

# Run dialectic codebase architecture & security audit
iumbtems audit "runner/ and skills/ concurrency and injection security"

# Scout open-source software, mature libraries & clean-room blueprints
iumbtems scout "Zero-dependency Raft consensus implementations in Rust"

# Run the autonomous dialectic research swarm
iumbtems run "Sub-millisecond ZK state updates on L1 rollups"

# Run lateral brainstorming (divergent what-if ideation, never bug fixes)
iumbtems brainstorm "Where do we go from here?"

# Run Socratic grilling and decision frontier calculation
iumbtems grill --objective "L1 vs L2 state verification trade-offs"

# Environment diagnostics (Claude Code, Node, Python)
iumbtems doctor

# Run automated test suite
iumbtems test
```

### Specialized Dialectic Skills & Slash Commands
- **`/swarm-config`**: Interactive tuning of search engines (DuckDuckGo, Brave, Firecrawl, SearXNG), iteration depth, divergence thresholds, and operating modes.
- **`/code-audit`**: Dialectic codebase review pairing a Structural Architect (thesis) with a Vulnerability Red-Teamer (antithesis) enforcing line-number proofs (`file:///path#L10-25`).
- **`/oss-scout`**: Evaluates GitHub repositories, package ecosystems (npm, crates.io, PyPI), license contamination (GPL/AGPL copyleft vs MIT/Apache), and outputs clean-room re-implementation blueprints.
- **`/grilling`**: Socratic assumption-inversion and Matt Pocock-style design tree frontier discovery.
- **`epistemic_search`**: Zero-key DuckDuckGo Lite search and content-addressed fetch with automatic SHA-256 caching.


---

## 🏷️ Epistemic Tagging Taxonomy

Every factual claim in IUMBTEMS carries an explicit evidentiary tag:

| Tag | Formal Definition | Verification Standard |
| :--- | :--- | :--- |
| `[VERIFIED: <hash>]` | Direct empirical fact from primary source. | Verbatim quote must exist in `.research/sources/<hash>.md`. |
| `[INFERRED: <reasoning>]` | Deductive conclusion from verified facts. | Explicit list of parent verified premises and bridging logic. |
| `[HYPOTHESIS: <test>]` | Speculative assertion or projection. | Must define a measurable falsification criterion. |
| `[NEGATIVE_KNOWLEDGE: <query>]` | Verified absence of empirical evidence. | Records exact search query and literature gap. |

---

## 🔍 Multi-Tier OSINT & Search Pipeline

1. **Discovery Tier**: SearXNG (unbiased metasearch) and Brave Search API.
2. **Extraction Tier**: Firecrawl (headless JavaScript rendering, DOM cleaning, Markdown extraction).
3. **Academic Tier**: Semantic Scholar / arXiv MCPs for DOI citation resolution.
4. **Caching Tier**: Content-addressed SHA-256 storage (`skills/research-cache/hasher.py`).

### Local Infrastructure (Optional)
Run local SearXNG and Firecrawl instances via Docker Compose:
```bash
docker compose -f config/docker-compose.infra.yml up -d
```

---

## 📦 CI/CD & Trusted Publishing

This package is distributed on npm under `@heretek-ai` with [npm Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) and GitHub Actions.

### First-Time CLI Bootstrap
```bash
git pull origin main
npm publish --access public
```

### GitHub Actions OIDC Setup
1. In `npmjs.com/package/@heretek-ai/epistemic-swarm/access`, add **GitHub Actions** as a Trusted Publisher:
   - **Repository Owner**: `Heretek-AI`
   - **Repository Name**: `IUMBTEMS`
   - **Workflow Pattern**: `.github/workflows/publish.yml`
2. Future releases publish automatically upon pushing a GitHub Release or version tag (`v*.*.*`)!

---

## 📄 License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
