# Fleet (Phase 3)

The fleet (`packages/fleet`, `es-fleet`) runs task DAGs concurrently on one
machine: isolated git worktrees per task (#124), one headless run per task
(#125), and a read-only localhost telemetry bus (#126). Starting the fleet
spends money, so `es-fleet` is human-only except `status` (and `--help`).

Fleet state lives in `<stateDir>/fleet/` (masked inside agent sandboxes):
`state.json` (daemon status), `tasks.json` (the DAG), `worktrees.json`
(the registry, #124), `daemon.pid`, `fleet.sock`, `token`.

## Task model (#123)

```text
{ id, title, kind: "factory-run" | "research-run",
  deps, trigger: all_success (default) | one_success,
  input: { objective, tier? }, ceilingUSD (mandatory, positive),
  policy: {strategy: "fail"} (default) | {strategy: "retry", maxAttempts}
          | {strategy: "replan"},
  status: pending | ready | running | waiting-human | done | failed
          | cancelled,
  attempts, reason?, result?: { spendUsd, summary? } }
```

## Scheduler (#123)

`schedule(dag, { concurrency, fleetCeilingUsd })` is pure: same DAG and caps
give the same `{ unblock, start, cancel }`. No clocks inside; `applyDecision`
and `reportTask` take `now` for stamps.

- A task is **ready** when all deps are `done` (`all_success`), or when any
  dep is `done` (`one_success`). Tasks without deps are immediately runnable.
- A task that can never run is **cancelled**: a failed/cancelled dep
  (`all_success`), or all deps terminal with none done (`one_success`).
- **Starts** are id-sorted and bounded by `concurrency` and the summed task
  ceilings against the fleet ceiling. `waiting-human` tasks free both.
- **Failure policy** (per task, on its own failure): `fail` goes terminal and
  the next `schedule` cancels its dependents; `retry(n)` re-queues while
  `attempts <= maxAttempts`; `replan` parks the task as `waiting-human`.
- Worker reports for terminal tasks are ignored (at-least-once delivery).

CLI: `es-fleet task add --file <task.json>` (one object or an array;
human-only), `task list [--json]`, `task cancel <id>` (human-only).

## Worktree coordinator (#124)

- One worktree per task at `<repo>/.fleet/worktrees/<taskId>/` (gitignored)
  on branch `fleet/<taskId>`, from a recorded base commit. Absolute symlinks
  pointing into the repo are rebased to the worktree on allocation.
- The registry (`<stateDir>/fleet/worktrees.json`) maps taskId → dir,
  branch, base, createdAt, status (`allocated`/`merged`/`abandoned`), under
  the shared fleet lock. Allocation is two-phase (check, git work under the
  per-repo admin lock, commit with re-check); a double allocation is refused.
- Release removes the checkout and marks the record. Abandoned branches are
  anchored at `refs/fleet-salvage/<taskId>` before deletion; merged branches
  are kept. `es-fleet gc` (human-only) salvages and removes orphaned
  worktrees and drops stale records.
- Landing (`landTask`) is transactional: gates run in the task worktree
  first (no state change on failure), then a `--no-ff` merge onto
  `fleet/integration/<dagId>` inside a throwaway worktree with the pre-merge
  tip captured — a conflict aborts, verifies the rollback, and reports
  `conflict: true` so the caller marks the task `waiting-human`.
- The base branch is never checked out, reset, or merged: the suite asserts
  its ref is stable across every operation.
- Policy: `.fleet/` is deny-write for every agent outside its own task
  worktree, and seats may not name other tasks' `.fleet/` paths in the shell.
