---
description: Autonomous agent-guided self-improvement loop (count-flagged)
---

Run the IUMBTEMS domain-expansion loop for `$1` loops (max 10):

Bypasses per-loop gates; stops on count OR `.factory/STOP` file OR user kill.
Each loop: agents propose direction, quick swarm check, implement, dual-QA verify.
Enforce via the `iumbtems_factory` tool (expansion command with loops/max_loops).
