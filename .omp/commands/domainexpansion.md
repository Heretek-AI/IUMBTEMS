---
description: Autonomous agent-guided self-improvement loop (count-flagged)
---

Run the IUMBTEMS domain-expansion loop for `$1` loops (max 10):

Bypasses per-loop gates; stops on count OR `.factory/STOP` file OR user kill.
Each loop: agents propose direction, quick swarm check, implement, dual-QA verify.
Enforce via `python3 skills/factory/scripts/factory.py expansion --run <run> --loops $1`.
