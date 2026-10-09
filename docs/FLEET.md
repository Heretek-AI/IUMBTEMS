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
  branch, base, createdAt, status
  (`allocating`/`allocated`/`merged`/`abandoned`), under
  the shared fleet lock. Allocation pre-registers `allocating` before the
  git work and flips to `allocated` after (never holding both locks); `gc`
  holds the fleet lock for its whole read → decide → persist inside the
  repo lock (one lock order, repo → fleet), treats `allocating` as live,
  and drops only stale `allocating` records whose dir and branch are gone.
  A double allocation is refused.
- Release removes the checkout and marks the record. Abandoned branches are
  anchored at `refs/fleet-salvage/<taskId>` before deletion; merged branches
  are kept. `es-fleet gc` (human-only) salvages and removes orphaned
  worktrees and drops stale records.
- Landing (`landTask`) is transactional: gates run in the task worktree
  first — a gate failure marks the task `failed` with the gate reason and
  merges nothing — then a `--no-ff` merge onto
  `fleet/integration/<dagId>` inside a throwaway worktree with the pre-merge
  tip captured. A merge failure aborts only with `MERGE_HEAD` present and
  reports `conflict: true` only with unmerged paths; any other failure
  returns its original reason with `conflict: false`. A conflict aborts,
  verifies the rollback, and reports `conflict: true` so the caller marks
  the task `waiting-human`.
- The base branch is never checked out, reset, or merged: the suite asserts
  its ref is stable across every operation.
- Policy: `.fleet/` is deny-write for every agent outside its own task
  worktree, and seats may not name other tasks' `.fleet/` paths in the shell.

## Workers (#125)

- One headless run per task: `es factory run --headless --events jsonl
  --cwd <worktree>`, spawned with argv only (never a shell). There is
  deliberately no `--max-usd` on that argv — `factory run` has no such flag —
  so the daemon provisions each task's ceiling into its run state beforehand
  (`prepareTaskRun`, via core's `Factory.provisionRun` /
  `beginResearchRun`), where the factory guard enforces it. `research-run`
  tasks are refused until a headless research driver exists.
- Headless events fold into task reports (`foldWorkerEvent`, pure):
  `waiting` → `waiting-human`, `done` → `done`, `halted`/`stalled`/
  `turn-cap`/`error` → `failed`, `cancelled` → `cancelled`; `turn-metrics`
  accumulate spend and tokens without a report. A run that exits without a
  final event reports `cancelled` on exit 130, else `failed`.
- `WorkerSupervisor` never double-starts a tracked task; a daemon restart
  reattaches to live pids (persisted in `workers.json`) and reports the dead
  ones as failed for the failure policy. `es-fleet stop` SIGTERMs every
  worker and records resumable cancellations.
- The StillDown circuit breaker refuses restarts for tasks that keep
  crashing, and pauses all launches on mass worker death; both recover after
  the cooldown.
- `FleetDaemon.tick` (idempotent) wires it together: schedule → allocate →
  prepare → launch → fold reports → land done tasks → release; `stop` is the
  kill switch. `es-fleet start --foreground` runs the loop (`--repo`,
  `--es-bin`, `--interval-ms`). Starting always asks for confirmation;
  a background start spawns a detached child over an IPC channel with a
  one-time start grant, waits for its pidfile-written report, and prints
  the child's error otherwise — a TTY-less child without the grant exits
  non-zero. `es-fleet status --token` (human-only, needs a TTY) prints the
  bus bearer token.

## Telemetry bus and watch (#126)

- The daemon serves a read-only bus on `127.0.0.1:<port>` (random free port
  recorded in `telemetry.json`; bearer token in `token`, 0600, readable only
  by the human outside any sandbox):
  - `POST /fleet/rpc`: strict-schema JSON-RPC — `fleet.status`,
    `fleet.task {id}`, `fleet.task.liveness {id}` (per-task run liveness:
    headline, stage, seats, research progress), `fleet.pending`,
    `fleet.events {since}` (monotonic
    backlog replay over the persisted `events.jsonl`).
  - `GET /fleet/ws`: WebSocket stream of `changed` and `liveness` events,
    coalesced to at most one emit per channel per second (notifySoon),
    dropping to the latest per taskId on bursts.
- Fail-closed binding: localhost only, `Authorization: Bearer` (401),
  `Host: 127.0.0.1|localhost:<port>` (403, DNS-rebinding defense), `Origin`
  checked on WS upgrades (403). Every method is read-only (the suite hashes
  state files around calls). Payloads are scrubbed (secret-named keys and
  known secret values become `[redacted]`; credentials never enter payloads).
- `es-fleet watch` polls the bus and redraws a terminal dashboard (headline
  spend, task table, pending approvals, recent events); `q` quits, needs a TTY.

## Web control plane (#129)

- `packages/web` (SolidJS + Vite, private, never published; ADR 0003) builds
  to `packages/web/dist/`, which the daemon serves from the bus port at `/`.
- `es-fleet web` (human-only, refused under `ES_SANDBOX`) mints a single-use
  ticket (32 random bytes, TTL 120 s, kept as a file under the masked state
  dir) and prints a one-time URL `http://127.0.0.1:<port>/?t=<ticket>`. The
  first load redeems it for an `HttpOnly; SameSite=Strict` session cookie
  (12 h); the ticket never redeems twice — the claim is an atomic rename, so
  even concurrent loads grant exactly one session — and expires after 120 s,
  so browser-history or proxy retention of the URL is harmless.
- Fail-closed: anonymous loads are 401, bad tickets 403, wrong Host 403, a
  non-loopback Origin 403, traversal outside the web root 404. The session
  cookie also authorizes read-only RPC and WS, but only with a loopback
  Origin present (bearer calls are unaffected). Every web response carries a
  strict CSP (`default-src 'self'`, no inline scripts, `frame-ancestors
  'none'`), `X-Content-Type-Options: nosniff` and `Referrer-Policy:
  no-referrer`.

## Fleet dashboard (#130)

- Hash-routed (`#/` overview, `#/task/:id`), built from the read-only bus
  only: `fleet.status`, `fleet.task`, and the WS `changed`/`liveness`
  stream. There are no mutation paths in the dashboard code (audited per
  ticket: the only requests are those two RPC methods plus WS subscribe).
- The overview draws the task DAG (columns by depth, edges from each task's
  `deps`, served by the bus since #130), a task table, fleet spend against
  the ceiling, and the pending-approvals list linking to each task page.
  Status is always words beside colour (1.3 vocabulary: running→working,
  waiting-human→waiting on you, etc.), and every task is a link, so the UI
  stays navigable by keyboard and readable without colour.
- Liveness is per task: `fleet.task.liveness {id}` serves the run's
  headline, stage, seat lines and research progress (`TaskLiveness`, a
  `import type`-only payload for the web dashboard), computed in fleet from
  the task worktree's factory state with core's `factory/liveness.ts`.
  Unknown tasks error; every call leaves all files untouched.
- Live updates: WS events refetch the snapshot; a reconnect refetches too.
  No data for 5 s shows a stale banner (`role="status"`).
- Tests run with `bun --conditions=browser test packages/web`: the web
  suite renders with the client Solid build, against fixture
  data plus a real TelemetryServer for the WS integration test.

## Browser approvals (#131, ADR 0002 option b)

- Hash-routed (`#/approvals` list, `#/approve/<task>/<stage>` page).
  `POST /fleet/approve/preview {runId, stage}` (bearer or session) returns
  the subject summary, files and hashes plus a single-use ticket (TTL
  120 s) bound to `hashJson(subject)` and a session CSRF token;
  `POST /fleet/approve {ticket, passphrase}` requires the session cookie,
  a loopback Origin and the CSRF header, then re-derives the subject,
  refuses a mismatch, unlocks the sealed key in-process, calls
  `approveStage` with `channel: "web"` and destroys the signer.
- Fail-closed: bearer-only, missing CSRF/Origin and foreign origins are
  refused; tickets redeem once; changed artifacts refuse with 409; five
  wrong passphrases lock the surface (core limiter, web-scoped state) with
  an audited `approval.lockout`. The passphrase travels only over
  loopback, lives in one page-local variable, and never reaches logs,
  events, responses or state files (probed in tests).
- The page holds the passphrase in a masked, non-reactive input cleared
  on submit. Trust, waive, resume, key seal, config set and export stay
  terminal-only (ADR 0002 I7) — this ticket adds no path for them.

## Config editor, preview-only (#132)
- Hash-routed (`#/config`), two tabs: project config
  (`.factory/config.json`) and gates (`.factory/gates.json`). The page
  shows the current layers with their file hashes and the drift state, an
  editor, and — after Preview — strict-schema errors inline or the exact
  diff (old hash → new hash, changed keys) plus the exact terminal commands
  (`es config set <key> <json>` per changed config key; save +
  `es rebaseline` for gates).
- Two read-only bus methods back it: `fleet.config.get {}` (current
  layers, hashes, drift, forbidden keys) and `fleet.config.plan {file,
  content}` (validates with the same `EsConfigSchema`/`GatesConfigSchema`
  the terminal path uses; the previewed hash is the sha256 of the exact
  bytes `writeJson` would emit). Both leave every file untouched (hashed
  around the calls in tests).
- Preview-only is enforced, not promised: the bus has no
  `fleet.config.apply` (unknown-method), the UI has no apply button, and
  the editor says so on the page. Browser apply stays terminal-only per
  ADR 0002 I7 until the user explicitly extends it (after #131) — tracked
  as a follow-up issue, not this ticket.
- Note: `docs/CONFIG.md` is generated from the config schema, so the
  editor is documented here instead of there (hand-editing generated docs
  fails `docs:check`).

## Evidence explorer (#133)

- Hash-routed (`#/evidence/<task>` from the task page): claim/source
  graph (coloured by tag, dashed when not LIVE), tag/status/tier
  filters, inspector (statement, rank explanation, retractions, history)
  and a source viewer that highlights verified quote ranges with `<mark>`
  elements built from text nodes — hostile source text is never parsed
  as HTML. Seal status (sealed / unsealed / invalid / unknown) shows on
  every source.
- Read-only bus methods: `evidence.claims {runId, filter}`,
  `evidence.claim {runId, id}` (quotes with original-text ranges from
  core's `locateQuote`, retractions, rank), `evidence.source {runId,
  sha}` (capped text, meta, seal) and `evidence.export {runId,
  markdown|html}` (the #112 `renderResearchRun` renderers). Lists and
  texts are capped; every call leaves all files untouched (hashed in
  tests). Editing claims and recording retractions stay terminal-only.
- Quote ranges come from `locateQuote` (core): `verifyQuote` decides,
  an index map through the same normalisation locates each fragment,
  and every range self-checks back to its fragment (a divergence yields
  no highlight, never a wrong one).

## Integration suite (#127)

`packages/fleet/test/integration.test.ts` is merge-blocking (runs in
`bun run check`, ~10 s, deterministic — 5/5 green): one booted testkit host
is the fleet repo, and scripted seat turns (fake model) do real work in real
isolated worktrees under the real daemon loop, landing and bus.
- Case 1: A, then B and C in parallel — start/finish marks prove ordering
  and overlap; branch trees prove output ownership and that `.factory/` run
  state never leaks across branches (it would collide on landing); the
  integration branch collects every output; `main` never moves.
- Case 2: error/retry/cancel/conflict — `failOnce`+`retry(1)` runs twice
  then succeeds; terminal failure cancels dependents; an add/add conflict
  reopens the loser as `waiting-human` (landing conflicts are the one
  transition allowed out of `done`) while the tip stays stable.
- Case 3: mid-run `shutdown()` SIGTERMs the worker (exit signal maps to
  `cancelled`/resumable), the abandoned branch is salvaged, `gc` is clean.
- Case 4: gates fail — the task is marked `failed` with the gate reason,
  the integration tip never moves, `main` never moves.
- Break probes: a shared worktree and a pre-dep start both fail the
  ownership/ordering checks, proving the suite bites.
