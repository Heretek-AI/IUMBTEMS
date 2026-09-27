---
name: factory
description: Coding-factory Manager loop. Use when user invokes /factory or /domainexpansion, or wants grill-gated phased builds with programmer spawns and dual QA. Manager grills until frontier settled, runs brainstorm plus darkharvest swarms per gate, synthesizes .roadmap phases, spawns programmer per phase, and enforces dual-QA retry bounds. Never writes code itself; never bypasses explicit user sign-off (except inside /domainexpansion count).
---

# Factory — Manager Loop & Domain Expansion

## 1. Roles (OpenCode profiles in `config/opencode-snippet.json`)

- **manager** (primary): owns gates, grilling, swarm dispatch, roadmap synthesis, tiebreaks.
  Task allowlist: `factory-*`, `programmer`, `qa-a`, `qa-b`, `brainstormer`, `darkharvester` deny `*` otherwise.
- **programmer** (subagent): implements exactly one phase brief. May call `iumbtems_verify_quote`; may NOT invoke swarms or other programmers.
- **qa-a / qa-b** (subagents): same model, DIVERGED prompts (functional-correctness vs adversarial edge-case). Read-only plus test execution; never edit.
- **researcher** = existing `iumbtems_brainstorm` + `iumbtems_darkharvest` swarms (no new profile).

## 1b. Driving run state (no filesystem paths)

Use the **`iumbtems_factory` MCP tool** for all run-state changes — never a
relative `skills/factory/scripts/factory.py` path (the toolchain lives in the
npm cache in consuming projects, and relative paths broke live: the manager
agent ran `find / -name factory.py`). The tool wraps the same helper and
resolves the project via `project_dir` argument, `IUMBTEMS_PROJECT_DIR`, or
the session cwd. It supports `init`, `phase-add`, `qa-record`, `expansion`,
`stop`, and returns `status: escalated` (exit 2) on the 3rd QA failure.

## 2. Gate protocol (max 5 swarm cycles per gate)

1. Grill until `.factory/frontier.json` settled (grilling skill).
2. Run brainstorm + darkharvest swarms (mock-first on fixtures).
3. Manager synthesizes `.roadmap/<phase>/` (GOAL.md + dossier.json).
4. Explicit user `approve` advances; anything else regrills (cycle counter in `.factory/state.json`).

## 3. Phase contract (`.roadmap/<phase>/`)

- `GOAL.md`: human-readable goal + acceptance criteria.
- `dossier.json`: `{phase, goal, evidence:[{hash, quote}], acceptance[], brief, verdict, hashes}`. Every harvest/claim entry needs a SHA-256 source hash or `file://` pointer or it is purged to NEGATIVE_KNOWLEDGE.
- Programmer receives the phase dossier (Manager chooses freeform vs strict brief but MUST cite phase hashes).

## 4. QA protocol (3 retries, then escalate)

- Both QA seats run per phase; disagreements go to manager tiebreak.
- `skills/factory/scripts/factory.py` tracks `qa_retries` per phase in `.factory/state.json`. On 3rd rejection: halt phase, return to manager with both QA reports (retry loop per plan; manager may regrill scope or escalate to user).
- QA verdicts: `pass | fail(reason) | conditional(note)`.

## 5. Domain expansion (`/domainexpansion <n>`)

- Bypasses per-loop gates; stops on count OR `.factory/STOP` file OR user kill, whichever first.
- Each loop: agents propose direction → quick swarm check → implement → QA → next.
- `factory.py` enforces: refuse `n < 1`, cap `n` at `--max-loops` default 10, check STOP file before every loop.

## 6. State layout (three dirs, distinct jobs)

- `.factory/`: run state (`state.json`, `frontier.json`, `STOP` kill-file). Gitignored runtime state.
- `.roadmap/`: output (phase dirs). Committed.
- `.research/`: evidence (swarm dossiers, source cache). Gitignored (existing rule).

## 7. Anti-patterns

- No code writes by manager; no swarm invocation by programmer; no edits by QA.
- No gate bypass outside `/domainexpansion`; no uncapped loops.
- No VERIFIED claims without hashes, even in expansion proposals.
