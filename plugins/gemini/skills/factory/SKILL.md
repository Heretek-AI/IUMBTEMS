---
name: factory
description: >-
  Coding-factory Manager loop. Use when user invokes /factory or /domainexpansion, or wants grill-gated phased builds with programmer spawns and dual QA. Manager grills until frontier settled, runs brainstorm plus darkharvest swarms per gate, synthesizes .roadmap phases, spawns programmer per phase, and enforces dual-QA retry bounds. Never writes code itself; never bypasses explicit user sign-off (except inside /domainexpansion count).
---

# Factory (thin adapter stub)

This file is a POINTER, not the implementation. It exists so harness skill
discovery finds an entry; the real skill lives in the IUMBTEMS repo.

- Canonical prose & scripts: `skills/factory/`
- Canonical programmatic surface: `python3 runner/mcp_server.py` (stdio MCP),
  or one-shot: `python3 runner/mcp_server.py call <tool> '{...json...}'`
- MCP tools for this skill: `iumbtems_factory`

Epistemic rules apply regardless of harness: tag claims as
`[VERIFIED: <hash>]`, `[INFERRED: <reasoning>]`, `[HYPOTHESIS: <test>]`, or
`[NEGATIVE_KNOWLEDGE: <query>]`. Writes go only to `.research/`.
