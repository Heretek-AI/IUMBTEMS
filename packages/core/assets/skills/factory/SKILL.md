---
name: factory
description: How the Epistemic Swarm build factory works — stages, human checkpoints, gates, seats, and the commands to drive or recover a run. Load when starting, resuming or debugging a factory run.
---
# Epistemic Swarm factory

**Stages** (enforced by code): GRILL → RESEARCH → SPEC → BUILD ⇄ QA → RELEASE → DONE, plus HALTED.

**Human checkpoints** (only through the TUI dialog or a terminal):
- `/es-approve` or `es approve frontier`: after the grill. Confirms the design tree and the spend ceiling.
- `/es-approve` or `es approve spec`: approves the roadmap plus every GOAL.md. The build is then autonomous until the PR opens.
- `/es-trust` or `es trust`: approves the project's gate commands (by hash) before they may run.
- `/es-resume` or `es resume`: clears a halt (STOP file, spend ceiling, runtime cap, control-file drift, retry exhaustion).
- `es waive <rule> <files> --reason … --expires …`: a signed, expiring exception to a gate finding.

**Gates** run after edits (touched files) and in full at phase completion and release: format, lint, typecheck, tests (related tests while editing, full suite at the end), secrets (built-in plus gitleaks), OSV on dependency changes, budgets (diff size, file length, complexity, dependency justification, a test for every behaviour change), artifact schemas, control-file drift. Findings come as `file:line rule: message` with a fix hint. Full logs are in `.factory/runs/`.

**Failure policy:** 3 attempts per phase, one manager replan, 2 more attempts, then the factory halts.

**Kill switch:** create `.factory/STOP` (any text). Every factory tool and seat stops until a human resumes.

**Files:** `.factory/frontier.json`, `roadmap.json`, `specs/<phase>/GOAL.md`, `research/`, `gates.json`, `waivers/` and `approvals/` are tracked. `runtime/` (state, journal, audit log), `runs/` and `worktrees/` are local.

**Callable brainstorm:** an open design question with several viable options is worth a brainstorm mid-run — `es_brainstorm_plan` (own `run`, lean defaults), all `es-lens-*` in one foreground message, `es_brainstorm_record` per lens, `es-brainstorm-critic` to score, `es_brainstorm_complete` for the shortlist JSON.
