---
description: Run IUMBTEMS dialectic research swarm on an objective
---

Run the IUMBTEMS dialectic research swarm on `$1`.

1. If the objective is ambiguous, follow `skills/grilling/SKILL.md` first.
2. Execute `python3 runner/research_swarm.py --objective "$1" $@[2:]`.
3. Summarize `.research/final_synthesis.md`, preserving `[VERIFIED:<hash>]` pointers.
