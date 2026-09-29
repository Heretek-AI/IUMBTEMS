---
name: brainstorming
description: >-
  Lateral creative brainstorming and divergent ideation skill. Use when exploring what-if features, lateral architectures, speculative product directions, or when user invokes /brainstorming. Generates novel feature vectors, paradigm inversions, and falsifiable spike hypotheses instead of bug fixes.
---

# Brainstorming (thin adapter stub)

This file is a POINTER, not the implementation. It exists so harness skill
discovery finds an entry; the real skill lives in the IUMBTEMS repo.

- Canonical prose & scripts: `skills/brainstorming/`
- Canonical programmatic surface: `python3 runner/mcp_server.py` (stdio MCP),
  or one-shot: `python3 runner/mcp_server.py call <tool> '{...json...}'`
- MCP tools for this skill: `iumbtems_brainstorm`

Epistemic rules apply regardless of harness: tag claims as
`[VERIFIED: <hash>]`, `[INFERRED: <reasoning>]`, `[HYPOTHESIS: <test>]`, or
`[NEGATIVE_KNOWLEDGE: <query>]`. Writes go only to `.research/`.
