# Dogfood run: the factory builds the tree-sitter complexity budget

M6's capstone is a real factory run on itself: grill → research → spec → build →
QA → release, ending in a draft PR a human merges. The feature is the deferred
M5 item — structural per-function complexity in the budgets gate, replacing the
text heuristic when the tree-sitter index is available.

This run needs a human (the frontier and spec approvals, the spend ceiling and
the merge) and a real model provider. Nothing here is automated.

## 1. Load the plugin

In the repository's `opencode.json` (or your global config), add the local
package with your provider/model ids per tier:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./packages/opencode",
      "options": {
        "models": {
          "deep": "<provider>/<model>",
          "balanced": "<provider>/<model>",
          "fast": "<provider>/<model>"
        }
      }
    }
  ]
}
```

Optionally commit a project config (`.factory/config.json`) with the same
models — `es config show` and `/config` print the effective layers. It is a
pinned control file: commit it before `es approve frontier` (approvals record
the baseline), or accept a later edit with `es rebaseline`. `embeddings` and
`estimate` belong in the global config or plugin options; a project file may
not set them.

## 2. Grill (you + `/grill`)

Start OpenCode in this repository and run:

```
/grill Build the tree-sitter complexity budget: the budgets gate should count
decision points per function from the structural index (falling back to the
text heuristic when grammars are unavailable), replacing the "heuristic until
the tree-sitter index lands" comment in packages/core/src/gates/budgets.ts.
Acceptance: complexity findings name real functions with line numbers, the
existing budget tests still pass, and new tests cover the tree-sitter path and
the fallback.
```

Answer the interview (one question at a time). Set the **spend ceiling**
explicitly — the run cannot start without it. When the design tree is settled,
approve it:

- TUI: `/es-approve` previews what you are approving, then points at the terminal; or
- terminal: `es approve frontier` (asks for your passphrase)

## 3. Research and spec

Run `/factory` in the TUI, or `es factory run --headless` in a terminal for an
unattended run. Either way the factory drives RESEARCH and then SPEC:

- **RESEARCH** produces a cited `REPORT.md`, which the auditor enforces.
  Research alpha writes `alpha.md` and then beta attacks it in `beta.md`;
  only the factory merges them into `REPORT.md`.
- **SPEC** produces the roadmap plus a GOAL.md per phase.

Seats run in the foreground, so a research turn can take minutes. That is
work, not a stall: see "Watching a run" below. When the spec is ready,
approve it the same way (`/es-approve` previews it; `es approve spec` records
it).

## 4. Autonomous build

`/factory` again; after the spec approval the run is autonomous: worktree per
phase, gates (including the new complexity check once built), dual QA
(functional + adversarial), manager tiebreak, retries bounded. Watch it as
below. If something goes wrong: `.factory/STOP` halts everything;
`es factory resume` clears a halt (`/es-resume` previews it).

## Watching a run

Every view leads with one plain sentence: is the run working, waiting on
you, possibly stuck, halted or done? It names the seat, its last tool and how
long ago it acted.

- **`es status`** (in the project): the headline; then which run, in which
  project, and how fresh it is; then each seat's state and last activity,
  research progress (cached sources, `alpha.md`, `beta.md`, `REPORT.md`,
  coverage), recent events, and anything waiting on you. `--json` gives the
  same to scripts. If another project's run is more recently active, it says
  so: `es status --run <id>` targets it.
- **`es watch`**: `es status`, redrawn every 2 s (`--interval S`); `q` quits.
- **`es runs`**: recent runs across your projects; `*` marks the one here.
- **TUI**:
  - `/es-factory` opens the factory dashboard beside the session. `Esc` or
    `q` closes it, `f` toggles fullscreen and `r` refreshes; `/es-close`
    also closes it.
  - The prompt footer shows `ES · <stage> · <seat> running · <age>`, or what
    waits on you.
  - A toast announces stage changes, and also a paused factory after three
    turns without progress (run `/factory` to continue).
- **Headless**: `es factory run --headless` prints JSON lines.
  - It emits a `progress` event every 30 s while a turn runs.
  - `stalled` carries its evidence (the headline, last activity, running
    seats); `turn-cap` means the turn limit was reached.
  - `--log-level quiet|info|debug` (default `info`) sets the detail:
    - `quiet`: lifecycle and progress only;
    - `info`: one line per tool call;
    - `debug`: raw harness events with long strings clipped.

`es status` from an agent's shell cannot verify the run (the private state
dir is masked there); agents call the `es_status` tool, which shows the same
liveness.

## 5. Release

`es_release` opens a draft PR from the run's integration branch. Review it,
then merge yourself — the factory never merges or pushes the base branch.

## 6. Record the result

Add to the M6 close-out: the run id, the PR URL, gate/QA outcomes and anything
the run exposed (those are M6 bugs to fix, not waivers). The run's artifacts
live under `.factory/` (specs and roadmap tracked; runtime, runs and worktrees
ignored).

## 7. Deep research (no build)

For a question with no code to build, skip the factory: `es research deep
"<question>" --output <dir> --max-usd N` (or `/research deep <question>
--max-usd N` in the TUI) starts a research-only run and drives the
deep-researcher headlessly. Watch it with `es status` in the output dir:
thesis (`alpha.md`), antithesis (`beta.md`), then the synthesizer's
`REPORT.md`, completing at DONE. Same ceiling/STOP/halt discipline, same
sealed evidence.

## Notes

- Provider keys come from the environment or the harness store; they are never
  written into `.factory/`.
- Upgrading from 0.7: the plugin options `search_engine`, `max_iterations`
  and `mode` were removed in 1.0 — a config that still carries them warns
  once (`Ignored unknown plugin options: …`) and otherwise loads. Delete
  those keys; only `models` per tier is needed (see §1).
- Budgets use host-reported usage where exposed; estimates are labelled
  "estimated".
- A failed run is evidence: fix the harness, re-grill if the design changed,
  and re-run. The tree-sitter complexity budget is a small feature on purpose —
  the point is the loop.
