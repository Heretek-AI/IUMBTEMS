---
name: swarm-config
description: Dynamic configuration and settings skill for the Epistemic Swarm research harness. Manage search engines, research depth, dialectic iterations, operating modes (research, audit, scout, hybrid, brainstorm), and license filters.
---

# Epistemic Swarm Configuration & Parameter Tuning

Use this skill to inspect, tune, and persist research parameters into `.research/config.json`.
Settings are automatically loaded by the Swarm Runner, Epistemic Auditor, and CLI.

## 1. Interactive Configuration

To launch the interactive configuration prompt:
```bash
python3 skills/swarm_config/configure.py --interactive
```

This guides you through selecting:
1. **Primary Search Engine**:
   - `duckduckgo` (Default, zero API key required, completely private)
   - `brave` (Brave Search API for high-precision SERP results)
   - `firecrawl` (Deep web scraping & JavaScript rendering)
   - `searxng` (Self-hosted privacy metasearch aggregator)
2. **Research Depth & Dialectic Iterations**:
   - `1` (Rapid brief, minimal token usage)
   - `2` (Standard thesis vs. antithesis dialectic - recommended)
   - `3` (Deep multi-pass verification)
   - `4` (Exhaustive multi-scope investigation)
3. **Operating Mode**:
   - `research` (Empirical literature & web synthesis)
   - `audit` (Deep codebase architecture, security, and vulnerability red-teaming)
   - `scout` (Open-source software discovery & clean-room harvesting)
   - `hybrid` (Combined codebase audit + web research)

## 2. Direct CLI Configuration

Inspect the current active configuration:
```bash
python3 skills/swarm_config/configure.py --show
```
or via CLI:
```bash
iumbtems config
```

Update parameters directly via flags:
```bash
# Set search engine to duckduckgo and depth to 3
python3 skills/swarm_config/configure.py --engine duckduckgo --depth 3

# Set operating mode to codebase audit
python3 skills/swarm_config/configure.py --mode audit

# Set divergence threshold
python3 skills/swarm_config/configure.py --divergence 0.8
```

## 3. Configuration Schema (`.research/config.json`)

The active project configuration is persisted at `.research/config.json`:
```json
{
  "search_engine": "duckduckgo",
  "max_iterations": 2,
  "divergence_threshold": 0.75,
  "mode": "research",
  "cache_raw_markdown": true,
  "license_whitelist": ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"],
  "output_dir": ".research"
}
```
All swarm agents read this file at initialization time.
