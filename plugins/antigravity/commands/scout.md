---
description: Scout open-source libraries, audit copyleft licenses, generate clean-room blueprints
---

Scout open-source solutions for the requested capability.

Feature: $ARGUMENTS
If $ARGUMENTS is empty, ask the user for the feature or algorithm first; never call with placeholder arguments.

1. Execute `iumbtems_oss_scout` with `{"feature": "<feature>"}` (or `python3 runner/research_swarm.py --mode scout --objective "$ARGUMENTS"`).
2. Report mature candidates, GPL/AGPL copyleft risks, and the clean-room blueprint in `.research/oss_scout_report.md`.
