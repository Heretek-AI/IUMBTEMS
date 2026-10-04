---
description: Lateral brainstorming: novel feature vectors, paradigm inversions, falsifiable spikes
---

Run lateral brainstorming (divergent what-if ideation, never bug-fix lists).

Prompt: $ARGUMENTS (defaults to "Where do we go from here?" when empty)

1. Execute `iumbtems_brainstorm` with `{"objective": "<prompt>"}` (or `python3 runner/research_swarm.py --mode brainstorm --objective "$ARGUMENTS"`).
2. Report novel feature vectors, paradigm inversions, and falsifiable spikes (`[HYPOTHESIS:<test>]`) from `.research/brainstorm_report.md`.
