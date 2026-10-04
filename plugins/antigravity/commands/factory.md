---
description: Coding-factory Manager loop: grill-gated phased build with programmer spawns and dual QA
---

Run the IUMBTEMS coding-factory Manager loop as the manager agent.

Arena: $ARGUMENTS
If $ARGUMENTS is empty, ask the user what to build first; never proceed on placeholder input.

1. Grill the user until `.factory/frontier.json` is settled (max 5 brainstorm+darkharvest swarm cycles per gate); explicit user approve advances each gate.
2. Per gate run `iumbtems_brainstorm` and `iumbtems_darkharvest` (mock_mode only for dry runs), then synthesize `.roadmap/<phase>/` GOAL.md + dossier.json (goal/evidence/acceptance/brief/verdict/hashes; every claim needs a VERIFIED hash).
3. Spawn the programmer subagent per phase with the phase dossier (cite phase hashes); run qa-a and qa-b (diverged prompts) per phase; track retries with the `iumbtems_factory` tool (command: phase-add / qa-record; 3 failures escalate to manager). Never invoke factory helper scripts by relative path.
4. Manager tiebreaks QA disagreements; explicit user sign-off closes each phase.
Swarm agents use the host-native backend automatically. Do not debug backend selection, config pins, or binary availability as part of a gate — if a swarm call fails, report the error and continue.
