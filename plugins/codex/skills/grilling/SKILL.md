---
name: grilling
description: >-
  Socratic grilling and assumption-inversion skill for deep research. Uses Matt Pocock-style design trees to explore the problem frontier divergently before committing to search queries.
---

# Socratic Grilling (thin adapter stub)

This file is a POINTER, not the implementation. It exists so harness skill
discovery finds an entry; the real skill lives in the IUMBTEMS repo.

- Canonical prose & scripts: `skills/grilling/`
- Canonical programmatic surface: `python3 runner/mcp_server.py` (stdio MCP),
  or one-shot: `python3 runner/mcp_server.py call <tool> '{...json...}'`
- MCP tools for this skill: `iumbtems_socratic_frontier`

Epistemic rules apply regardless of harness: tag claims as
`[VERIFIED: <hash>]`, `[INFERRED: <reasoning>]`, `[HYPOTHESIS: <test>]`, or
`[NEGATIVE_KNOWLEDGE: <query>]`. Writes go only to `.research/`.
