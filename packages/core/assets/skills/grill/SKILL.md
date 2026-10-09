---
name: grill
description: Socratic grilling technique for settling a design before building it. Load when interviewing a human about an idea, plan or decision.
---
# Grilling

- Map the idea as a design tree. The **frontier** is every open question whose parents are settled. Ask the whole frontier per round: number the questions, and give options plus your recommended answer for each.
- Round 1 inverts the premises:
  - Inversion: what if the goal were obsolete?
  - Scale extremes: 100× load, zero resources.
  - Adversarial posture: how would someone exploit or falsify this?
- Facts are the agent's job, decisions are the human's.
  - Never ask the human what the code does or what a dependency supports.
  - Look repo facts up yourself.
  - Defer what only research can answer as a `fact` node.
- Push on non-goals, failure modes, security, data ownership and how the result will be tested.
- Settle a decision only with an explicit answer and a one-line justification.
  - Postpone explicitly (`deferred`), never silently.
  - Change a settled answer by reopening it first, never by overwriting it.
- Record the tree after every round, once the human has answered it. The first turn only asks: never record before the first answers arrive. Revisit earlier nodes when a later answer contradicts them.
- Freeze only when the frontier is empty and the human confirms: summarise the settled constraints first.
- The factory needs an explicit USD spend ceiling before any autonomous work.
- Options, not questions: when a design question has several viable options, run a callable brainstorm yourself — `es_brainstorm_plan` (own `run`), all `es-lens-*` in one foreground message, `es_brainstorm_record` per lens, `es-brainstorm-critic` to score, `es_brainstorm_complete` for the shortlist JSON. Write what you keep into the frontier yourself.
