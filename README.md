# IUMBTEMS: I Use My Brain To Express My Self 🧠

[![npm version](https://img.shields.io/npm/v/@heretek-ai/epistemic-swarm.svg)](https://www.npmjs.com/package/@heretek-ai/epistemic-swarm)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI/CD](https://github.com/Heretek-AI/IUMBTEMS/actions/workflows/publish.yml/badge.svg)](https://github.com/Heretek-AI/IUMBTEMS/actions)

> **High-Integrity Dialectic Research Agent Harness**  
> *Universal support for Claude Code, Pi (pi.dev), and OpenCode V2.*  
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

IUMBTEMS is packaged as a single universal npm package (`@heretek-ai/epistemic-swarm` with `iumbtems` binary) that runs across the three major autonomous agent platforms:

### 1. Claude Code
Install skills and MCP servers into `~/.claude/` and `~/.claude.json`:
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
- Exposes native `/swarm <objective>` and `/grill` slash commands in the Pi interactive terminal.
- Discovers skills (`skills/grilling`, `skills/research-cache`) and prompts automatically via the `pi` manifest block.

### 3. OpenCode V2 (`opencode.ai`)
Enable IUMBTEMS in your `~/.config/opencode/opencode.json` or project `opencode.jsonc`:
```json
{
  "plugin": [
    "@heretek-ai/epistemic-swarm"
  ]
}
```
OpenCode V2 automatically registers:
- `iumbtems_swarm_research`: Dispatches dialectic researcher pairs.
- `iumbtems_verify_quote`: Audits verbatim citations against the SHA-256 source cache.
- `iumbtems_socratic_frontier`: Advances the Socratic decision tree frontier.

*(See [config/opencode-snippet.json](config/opencode-snippet.json) for custom agent definitions).*

---

## ⚡ CLI Command Reference

```bash
# Run the autonomous dialectic research swarm
iumbtems run "Sub-millisecond ZK state updates on L1 rollups"

# Run Socratic grilling and decision frontier calculation
iumbtems grill --objective "L1 vs L2 state verification trade-offs"

# Environment diagnostics (Claude Code, Node, Python)
iumbtems doctor

# Run automated test suite
iumbtems test
```

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
