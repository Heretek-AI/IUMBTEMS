---
description: Run IUMBTEMS dialectic research swarm on an objective
---

Run an IUMBTEMS dialectic research swarm.

Objective: $ARGUMENTS
If $ARGUMENTS is empty, ask the user for the research objective first; never call with placeholder, empty, or literal "<objective>" arguments.

1. If the objective is ambiguous, frame it first via `iumbtems_socratic_frontier`.
2. Execute `iumbtems_swarm_research` with `{"objective": "<objective>"}` (or `python3 runner/research_swarm.py --objective "$ARGUMENTS"`).
3. Summarize `.research/final_synthesis.md`, preserving `[VERIFIED:<hash>]` pointers.
