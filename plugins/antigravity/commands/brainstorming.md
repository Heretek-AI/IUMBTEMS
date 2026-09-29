---
description: Lateral brainstorming — novel feature vectors and speculative spikes
---

Run IUMBTEMS lateral brainstorming on `$1` (see `skills/brainstorming/SKILL.md`
and `prompts/agent_brainstormer.md`):

1. Ingest workspace context read-only (`python3 skills/brainstorming/scripts/brainstorm.py --objective "$1" --show-context`).
2. Thesis / Radical Antithesis / Synthesis — never bug-fix lists.
3. Output Novel Feature Vectors (3-5), Lateral Architectural Moves (2-3),
   Experimental Hypotheses (2-3 with `[HYPOTHESIS:<falsification test>]`).
4. Write `.research/brainstorm_report.md` (or run `python3 runner/research_swarm.py --mode brainstorm --objective "$1"`).
