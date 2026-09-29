---
name: darkharvest
description: >-
  Product-level competitor teardown and clean-room harvest engine. Use when user wants to compete with or learn from existing products (e.g. Paseo, OpenChambers). Seed with inspiration URLs plus prompt, auto-expand to adjacents, clone-scan competitors, compare product plus code, and emit per-feature depend/vendor/clean-room/skip verdicts with SPDX attribution. Never copies GPL/AGPL code or UI assets.
---

# Darkharvest (thin adapter stub)

This file is a POINTER, not the implementation. It exists so harness skill
discovery finds an entry; the real skill lives in the IUMBTEMS repo.

- Canonical prose & scripts: `skills/darkharvest/`
- Canonical programmatic surface: `python3 runner/mcp_server.py` (stdio MCP),
  or one-shot: `python3 runner/mcp_server.py call <tool> '{...json...}'`
- MCP tools for this skill: `iumbtems_darkharvest`

Epistemic rules apply regardless of harness: tag claims as
`[VERIFIED: <hash>]`, `[INFERRED: <reasoning>]`, `[HYPOTHESIS: <test>]`, or
`[NEGATIVE_KNOWLEDGE: <query>]`. Writes go only to `.research/`.
