---
description: Product competitor teardown with per-feature harvest verdicts
---

Run a product competitor teardown (seed inspirations plus prompt, expand to adjacents).

Objective: $ARGUMENTS (product arena; seeds may be embedded as URLs)
If $ARGUMENTS is empty, ask the user for the product arena and seed URLs first; never call with placeholder arguments.

1. Execute `iumbtems_darkharvest` with `{"objective": "<objective>", "seeds": ["<url>", "..."]}` (or `python3 runner/research_swarm.py --mode darkharvest --objective "$ARGUMENTS"`).
2. Report the competitor x capability matrix, white-space gaps both ways, and the SPDX-attributed harvest backlog in `.research/darkharvest_report.md`.
3. Legal rule: permissive-only vendor; GPL/AGPL clean-room-rebuild only; workflows clonable, assets never.
