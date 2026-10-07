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
models — `es config show` and `/config` print the effective layers.

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

- TUI: `/es-approve` → type the code; or
- terminal: `es approve frontier`

## 3. Research and spec

Run `/factory` and let the factory drive RESEARCH (cited `REPORT.md` enforced
by the auditor) and SPEC (roadmap + GOAL.md per phase). When the spec is ready,
approve it the same way (`/es-approve` or `es approve spec`).

## 4. Autonomous build

`/factory` again; after the spec approval the run is autonomous: worktree per
phase, gates (including the new complexity check once built), dual QA
(functional + adversarial), manager tiebreak, retries bounded. Watch it in the
**factory dashboard** panel (`/es-factory`) or `es status`. If something goes
wrong: `.factory/STOP` halts everything; `/es-resume` clears a halt.

## 5. Release

`es_release` opens a draft PR from the run's integration branch. Review it,
then merge yourself — the factory never merges or pushes the base branch.

## 6. Record the result

Add to the M6 close-out: the run id, the PR URL, gate/QA outcomes and anything
the run exposed (those are M6 bugs to fix, not waivers). The run's artifacts
live under `.factory/` (specs and roadmap tracked; runtime, runs and worktrees
ignored).

## Notes

- Provider keys come from the environment or the harness store; they are never
  written into `.factory/`.
- Budgets use host-reported usage where exposed; estimates are labelled
  "estimated".
- A failed run is evidence: fix the harness, re-grill if the design changed,
  and re-run. The tree-sitter complexity budget is a small feature on purpose —
  the point is the loop.
