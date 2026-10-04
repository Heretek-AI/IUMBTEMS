---
description: Autonomous agent-guided self-improvement loop over the codebase (count-flagged)
---

Run the IUMBTEMS domain-expansion loop as the manager agent.

Loops: $ARGUMENTS (integer count, max 10)
If $ARGUMENTS is not a positive integer, ask the user for the loop count first.

1. Bypass per-loop gates; stop on count OR .factory/STOP file OR user kill, whichever first (enforce via the `iumbtems_factory` tool, command: expansion, with loops/max_loops).
2. Each loop: agents propose direction, quick `iumbtems_brainstorm`/`iumbtems_darkharvest` check, implement via programmer spawn, dual-QA verify.
3. All expansion proposals carry the strict VERIFIED evidence bar; log every loop to `.factory/state.json`.
