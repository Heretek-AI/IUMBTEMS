---
name: brainstorm
description: Divergent lens fan-out with deterministic dedupe, rubric scoring, and a diversified shortlist with a forced outlier.
---
# Brainstorm

Lateral ideation on an idea, run as a fan-out of divergent lenses and distilled mechanically. Never bug fixes, never implementation plans.

## When to use
- The human runs `/brainstorm <idea>` or asks for ideas, directions or alternatives.
- Before grilling: use the shortlist to pick a direction, then `/grill` it.

## The flow (mechanised — follow the refusals)
1. `es_brainstorm_plan` — freezes the lens set, idea caps and shortlist size; returns the lens subagents to launch.
2. Launch every lens subagent in parallel, by exact ID (`es-lens-<lens>`), each with the brief. Fast tier; one lens each: inversion, constraint-removal, scamper, cross-domain, extreme-user, scale-shift, failure-first, adjacent-possible.
3. `es_brainstorm_record` — one call per lens. Caps are enforced; near-duplicates are collapsed against earlier ideas (convergence is a signal).
4. `es-brainstorm-critic` — scores every surviving idea 1-5 on novelty, upside, feasibility and fit via `es_brainstorm_score`.
5. `es_brainstorm_complete` — re-checks coverage and scores, ranks, and writes the diversified shortlist with one forced outlier slot to `.factory/brainstorm/`.

## Output
`.factory/brainstorm/brainstorm.json` (machine-readable) and `BRAINSTORM.md` (the shortlist, the full ranked field, collapsed duplicates, coverage and gaps). Report the shortlist to the human; do not paste the whole field.

## Rules
- The mechanics are not negotiable: caps, dedupe, ranking and the outlier slot are computed, not judged by the orchestrator.
- The critic is the only seat that scores; the brainstormer orchestrates.
- A lens that produces nothing is a recorded gap, not silently dropped.
