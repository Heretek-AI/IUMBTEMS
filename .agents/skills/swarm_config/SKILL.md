# Swarm Config (thin adapter stub)

This file is a POINTER, not the implementation. It exists so harness skill
discovery finds an entry; the real skill lives in the IUMBTEMS repo.

- Canonical prose & scripts: `skills/swarm_config/`
- Canonical programmatic surface: `python3 runner/mcp_server.py` (stdio MCP),
  or one-shot: `python3 runner/mcp_server.py call <tool> '{...json...}'`
- MCP tools for this skill: `iumbtems_config`

Epistemic rules apply regardless of harness: tag claims as
`[VERIFIED: <hash>]`, `[INFERRED: <reasoning>]`, `[HYPOTHESIS: <test>]`, or
`[NEGATIVE_KNOWLEDGE: <query>]`. Writes go only to `.research/`.
