# Hook-Bus Parity: Claude hooks ↔ IUMBTEMS bus (Phase 01-hook-bus-spec)

Minimal six-event blockable hook bus with tiered enforcement, wired to the
existing OpenCode v2 `command.transform + tool.transform + session.hook + rpc`
shape. North star is Claude Code parity (hooks.json-style pre/post tool,
commit, stop, notification, session-start guards); the table below maps each
Claude-side concept to its bus equivalent.

Phase evidence: transform-shaped registrations, commands via
`host.command.transform` and tools via `host.tool.transform`, with the
documented asymmetry of no `tool.execute.before`
[VERIFIED: sha256:52ac5b4d26062cfc6093440faa415ab152f8acd0d18c4496eb0087ed18a27d76];
mock-host QA home
[VERIFIED: sha256:06fff10d7c9d77a86c42d6f412b22de46a6f6bba89dea23a863075bdd3d98bda];
Gate-0 parents `08229740d0a7f752b0c388876ec1588e513f2b3bc8130a72771bee9593d92665`
and `131bcb343879bfadcba9a40719ddd0b77540eb21f4cdc937d18b1b2943579afa`.

## Tier table (H2+H6)

- `fast` tier: budget `FAST_TIMEOUT_MS` = 500 ms
  (see plugins/opencode/hook-bus.js:54). A fast deny **blocks**; a fast
  timeout degrades to fail-open allow + audit entry.
- `slow` tier: budget `SLOW_TIMEOUT_MS` = 5000 ms
  (see plugins/opencode/hook-bus.js:55). A slow deny blocks **only when it
  lands inside the slow budget**; a slow overrun degrades to an advisory
  annotation (fail-open allow) + audit entry, so a hung slow check can never
  brick the fast path (tiers run concurrently).
- Every decision is audit-logged (allow/deny/timeout/fallback + latency +
  tool/event id); bus-internal faults fail open and never throw into the host.

## Parity table

Per-event enforcement points are explicit (fix round): a row marked
`enforced` names the host code that honors a deny; a row marked otherwise
states exactly what a deny does and does not do. No row implies host
blocking without an emit site.

| Claude hook | Bus event | Payload | Blocking semantics | Enforcement point | Timeout | Fallback | Pointer |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| PreToolUse | pre-tool-use | `{ tool, args, sessionID }` | fast deny blocks; slow deny blocks inside slow budget | ENFORCED for this plugin's own tools in `registerHostTools` execute (deny blocks `callMcp` dispatch). Host-native tools (webfetch/websearch) are NOT gated — no `tool.execute.before` point exists (see gap 1) | fast 500 ms / slow 5000 ms | fail-open allow + audit | plugins/opencode/hook-bus.js:38 |
| PostToolUse | post-tool-use | `{ tool, result, sessionID }` | fast deny blocks; slow deny blocks inside slow budget | ENFORCED for this plugin's own tools: a deny blocks DELIVERY (result suppressed, notice returned). Same host-native scope limit as pre-tool-use | fast 500 ms / slow 5000 ms | fail-open allow + audit | plugins/opencode/hook-bus.js:38 |
| PreCommit (settings write) | pre-commit | `{ updates, root, expected_hash? }` | deny blocks the write (structured invalid / not-written, nothing written) | ENFORCED on BOTH legs: settings-RPC `set` AND the TUI direct-fs fallback (`gateDirectFsPreCommit`). Stale-write guard still enforced downstream in both | fast 500 ms / slow 5000 ms | fail-open allow; stale-write guard still enforced by the MCP write / `saveConfig` | plugins/opencode/hook-bus.js:377 |
| Stop | stop | `{ sessionID, reason? }` | deny blocks at `bus.emit` (direct subscribers) | BUS-LEVEL ONLY: no host interception point exists yet, so no host action is gated. Deny-blocks holds for bus participants, exactly like the six bus unit tests pin | fast 500 ms / slow 5000 ms | fail-open allow + audit | plugins/opencode/hook-bus.js:38 |
| Notification | notification | `{ message, level?, sessionID? }` | deny blocks at `bus.emit` (direct subscribers) | BUS-LEVEL ONLY: same scope as `stop` — no host toast/log interception point, no host action gated | fast 500 ms / slow 5000 ms | fail-open allow + audit | plugins/opencode/hook-bus.js:38 |
| SessionStart (compaction restore) | session-start | `{ root, eventId }` | advisory BY DESIGN: a deny is audit-logged but never drops the compaction state push | ADVISORY emit inside the compaction hook. Explicitly NOT counted as a deny-blocks host path — the bus unit test pins `bus.emit` returning `allowed: false` while the host push still proceeds | fast 500 ms / slow 5000 ms | fail-open allow + audit | plugins/opencode/index.js:1846 |

## Caller-latency contract (GOAL §5/§6)

`emit` runs the fast and slow tiers concurrently and bounds every handler
by its tier budget, so a call resolves within
`max(fastBudget, slowBudget)` + scheduling epsilon. A hung slow handler
delays the caller by at most the slow budget (default 5000 ms, see
plugins/opencode/hook-bus.js:55) — never indefinitely, never bricking the
fast path. Pinned by `test_emit_latency_bounded_by_slow_budget` in
runner/tests/test_hook_bus.py (a never-settling slow handler with a small
`slowTimeoutMs` still resolves on budget with a `timeout` audit entry).

## Audit-log guarantees (fix round)

- Every handler outcome appends exactly one entry: allow / deny / advisory /
  timeout / error / fallback, each with latency.
- Unrecognised handler verdicts degrade to fail-open allow but are TAGGED
  with `fallback: true` + a `note` (never silent) — see
  `normalizeVerdictEx` (plugins/opencode/hook-bus.js:87).
- Every entry ALWAYS carries `tool` and `eventId` keys (`null` when the
  payload has none), so consumers can rely on shape.
- The ring cap (`MAX_AUDIT_ENTRIES`, plugins/opencode/hook-bus.js:61)
  evictions are COUNTED (`getAuditStats()` →
  `{ entries, dropped, capacity }`, plugins/opencode/hook-bus.js:348);
  `clearAuditLog()` leaves a tombstone entry whose note carries the
  discarded count (plugins/opencode/hook-bus.js:322).

## Wire-in pointers

- Bus registry `on(event, handler, { tier })` and `emit(event, payload)` with
  per-tier timeouts: plugins/opencode/hook-bus.js:192
- `pre-tool-use` deny-blocks-execution emit in plugin-tool `execute`:
  plugins/opencode/index.js:1190
- `post-tool-use` deny-suppresses-delivery emit in plugin-tool `execute`:
  plugins/opencode/index.js:1213
- `pre-commit` gate helper (stale-write guards preserved downstream):
  plugins/opencode/hook-bus.js:377
- Direct-fs `pre-commit` gate helper (fallback leg):
  plugins/opencode/tui.js:120
- Bus adoption alongside existing registrations (same adopt/best-effort
  pattern): plugins/opencode/index.js:2885
- Shared bus instance: plugins/opencode/index.js:73
- `pre-commit` gate inside the settings-RPC `set` leg:
  plugins/opencode/index.js:2526
- Direct-fs `pre-commit` gate inside the wizard fallback leg:
  plugins/opencode/tui.js:1322
- `session-start` (advisory) emit inside the compaction hook:
  plugins/opencode/index.js:1846
- Audit ledger (ring-cap counter + clear tombstone):
  plugins/opencode/hook-bus.js:322
- Mock-host bus tests (order, timeouts, fail-open, audit completeness, six
  deny-blocks, registrar-adopt, doc pointers):
  runner/tests/test_hook_bus.py

## Gap list

1. **No `tool.execute.before` until upstream lands.** This plugin shape
   (command/tool transform + session hooks + event subscriptions) has no
   `tool.execute.before` registration point, so host webfetch/websearch calls
   cannot be intercepted the way Claude Code hooks do
   [VERIFIED: sha256:52ac5b4d26062cfc6093440faa415ab152f8acd0d18c4496eb0087ed18a27d76].
   Consequence: `pre-tool-use` / `post-tool-use` enforce on THIS plugin's own
   tool executions (see plugins/opencode/index.js:1190); they cannot yet veto
   arbitrary host tool executions. The bus degrades gracefully (advisory
   annotations + audit) until the upstream guard API exists.
2. `session-start` verdicts are advisory-only BY DESIGN (a deny never drops
   the compaction state push) to preserve the existing restore behavior —
   documented as advisory, never counted as a deny-blocks host path.
3. `stop` / `notification` are bus-level only: no host interception point
   exists for them yet (same gap class as gap 1), so no host action is gated;
   deny-blocks holds at `bus.emit` for direct subscribers.
4. The host may lack RPC/MCP/session-hook domains; every registrar is
   best-effort and the bus attaches fail-open (`host.iumbtemsHookBus`,
   see plugins/opencode/hook-bus.js:394). The TUI direct-fs fallback leg is
   gated through the bus anyway (`gateDirectFsPreCommit`,
   plugins/opencode/tui.js:120) — on RPC-null hosts the bus is still the
   enforcement point; a null bus fails open with an audit entry on the next
   emit that does run.

## Appendix: analysis bridge (Phase 02-lsp-bridge)

First bus consumer: CLI-invocation JS/TS analysis behind the Phase-01 bus —
all-advisory, never blocking.

- Module: `plugins/opencode/analysis-bridge.js` (runtime-dep-free; node
  builtins only). Tests: `runner/tests/test_analysis_bridge.py` (mock-host,
  mock analyzer, millisecond budgets).
- Subscribed events: `pre-tool-use`, `post-tool-use`, `pre-commit` for
  `*.js`/`*.ts` targets (`.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts); adopted in
  `setup` alongside the existing registrations (same adopt/best-effort
  pattern). `stop` / `notification` / `session-start` are NOT consumed by the
  bridge.
- All-advisory status: the bridge returns `{ allowed: true, annotations:
  [...] }` on every path and NEVER returns deny — even severe findings
  allow (pinned by the never-deny test: a dirty file still allows). Findings
  shape is `{ tool, eventId, rule, file, line, message, severity }` with all
  keys always present.
- Budget: the analyzer runs inside the fast-tier budget
  (`ANALYZER_TIMEOUT_MS`, see `plugins/opencode/analysis-bridge.js`); an
  overrun degrades to a single `analysis-bridge/timeout` annotation and the
  caller stays unblocked (fail-open allow).
- Audit + toast: every finding is audit-logged on the bus (one
  `notification` record per finding via the internal
  `analysis-bridge-audit-sink`, each carrying `tool`/`eventId`; finding
  detail rides in the entry reason). The toast summarizes counts only
  (`N finding(s) in M file(s)`), never finding text.
- Analyzer-missing (devDep not installed, e.g. fresh checkout): single audit
  entry (the handler's own fail-open `allow`) + silent skip — never throws,
  never blocks, no toast.
- Analyzer: exactly one pinned devDependency, Biome
  (`@biomejs/biome`, exact version in `package.json`; MIT OR Apache-2.0) —
  single dep, zero-config, fast, covers lint+format for JS/TS. Runtime
  `dependencies` are unchanged. No persistent LSP servers in this phase.
- Future tiers (deferred, not built here): SonarQube-class deep analysis and
  fallow-language bridges (Python and others follow the same
  collect → CLI → advisory-annotations shape once their runners land).

## Appendix: dep-health gate (Phase 03-dep-health-gate)

Second bus consumer: programmer-time outdated/vulnerable-dependency warnings
backed by a mechanical QA coverage gate — all severities advisory, never
blocking.

- Module: `plugins/opencode/dep-health.js` (runtime-dep-free; node builtins
  only). Tests: `runner/tests/test_dep_health.py` (mock-host, mocked
  npm/OSV runners, millisecond budgets).
- Subscribed events: `pre-tool-use`, `pre-commit` (programmer action-time
  points, `slow` tier); adopted in `setup` alongside the existing
  registrations (same adopt/best-effort pattern).
  `post-tool-use` / `stop` / `notification` / `session-start` are NOT consumed
  by dep-health (it writes its own per-finding `notification` records for the
  audit sink).
- All-advisory status: `checkDeps` returns `{ allowed: true, ecosystems }`
  on every path and NEVER returns deny — even a critical-CVE fixture allows
  (pinned by the never-blocks test). Findings shape is `{ tool, eventId,
  ecosystem, package, installed, wanted, latest, severity, advisory, fixedIn,
  source }` with all eleven keys always present (reusing the Phase-02
  annotation shape `{ tool, eventId, ... }`).
- Coverage-gate semantics (`depHealthCoverage`, pure): FAIL only when a
  present ecosystem lacks a report or findings went unrecorded. `scanned`
  passes (empty findings = clean), `unavailable` with recorded entries passes
  (a feed outage is a recorded fact, not a gate failure), `absent` passes
  with a note; a missing report, unrecorded findings, or an unknown status
  fails. Severities NEVER fail the gate.
- Ecosystem table (each reports `scanned | unavailable | absent`):

| Ecosystem | Manifests | Local signal | Feed enrichment | Baseline in this repo |
| :--- | :--- | :--- | :--- | :--- |
| npm | package.json | npm outdated + npm audit | OSV.dev best-effort | scanned |
| pip | requirements / pyproject / Pipfile | none (OSV only) | OSV.dev best-effort | absent (no manifests) |
| containers | compose files + Dockerfiles | static floating-tag scan | none | scanned (2 floating-tag advisories) |
| actions | workflow files | static uses-pin scan | none | scanned clean (majors pinned) |

- Feed policy: local `npm outdated` / `npm audit` plus credential-free OSV.dev
  lookup only (no authed feeds). OSV enrichment is bounded by
  `OSV_TIMEOUT_MS` (inside the slow-tier budget); offline/failure degrades to
  a RECORDED `unavailable` entry and fail-open allow — never a throw.
- Audit + toast: every finding is audit-logged on the bus (one
  `notification` record per finding via the `dep-health-audit-sink`, each
  carrying `tool`/`eventId`; finding detail rides in the entry reason). The
  toast summarizes counts only (findings count across ecosystems), never
  finding text.
- Repo baseline (pinned in tests with mocked versions, never live audit
  data): npm `scanned`, pip `absent`, containers `scanned` with the 2
  floating-tag advisories, actions `scanned` clean.
- Phase evidence: npm surface
  [VERIFIED: sha256:7690b878a654ee4dee2b649b60740bc95d4b746cf786051887153b6f656f2e5e];
  lockfile
  [VERIFIED: sha256:1fd0c2b8b0d37d553f1f841cea4e4b60d92cdf873257172a726d482954dddf8f];
  compose floating tags
  [VERIFIED: sha256:7b62111192e07c73547a125eeab7ff98f2d1305a04149f1ab51c66a41a3e3f95];
  majors-pinned workflows
  [VERIFIED: sha256:c381a646894ce66669432e847f0afd647ea5ff00ac64a01cf91f325f5515e601];
  dep-health vocabulary precedent
  [VERIFIED: sha256:ae16788a0a85caed3983dbc70455eaa05857827c837a5f5999242ef32b0a16a7].
- Deferred (not built here): authed feeds (Dependabot, commercial scanners)
  and auto-fix PRs — warnings only in this phase.

## Appendix: coverage + treeshake signals (Phase 04-coverage-treeshake-signals)

Third bus consumer: coverage deltas (existing unittest suites) + esbuild-measured
bundle weight (plugin surface) as advisory dossier annotations + audit log —
all advisory, never blocking.

- Module: `plugins/opencode/weight-signals.js` (runtime-dep-free; node
  builtins only). Baseline: `plugins/opencode/weight-baseline.json` (measured
  once at build, checked in). Tests: `runner/tests/test_weight_signals.py`
  (mock-host, mocked esbuild/tallies, millisecond budgets).
- Subscribed events: `pre-commit` (programmer commit-time point, `slow`
  tier); adopted in `setup` alongside the existing registrations (same
  adopt/best-effort pattern). Every record is audit-logged on the bus (one
  `notification` record per record via the `weight-signals-audit-sink`, each
  carrying `tool`/`eventId`); the toast summarizes counts only
  (`N record(s)`), never record text.
- All-advisory status: `measureBundle` returns `{ allowed: true, annotations }`
  on every path and NEVER denies — even a +500% weight blowup allows (pinned
  by the never-blocks test). No-threshold policy: there are NO blocking
  thresholds in this phase; hardening needs baselines + explicit user sign-off
  (Gate-0 R5). `coverageDelta({before, after})` maps unittest tallies to
  `{delta, direction}` (`up`/`down`/`flat` on pass-rate pp, `unknown` when a
  tally is missing/empty — recorded, never a throw).
- Measurement: one pinned devDependency, esbuild (exact version in
  `package.json`; MIT) — `metafile:true, write:false` (measure, never emit);
  esbuild stays `external` (it is the ruler, not shipped code). Runtime
  `dependencies` are unchanged. `bytes` sums output bytes, `files` counts
  distinct inputs, `topHeaviest[5]` lists the heaviest inputs;
  `deltaVsBaseline` is `{bytes, pct}` against `weight-baseline.json`.
- Honest-status vocabulary (same contract as 02-missing / 03-offline):
  esbuild missing/failing or malformed metafile → RECORDED `unavailable`
  entry + fail-open allow, never throws. Record shapes reuse the Phase-02
  annotation shape `{ tool, eventId, ... }` with always-present keys
  (`WEIGHT_RECORD_KEYS`, `COVERAGE_RECORD_KEYS` — `null` when unknown, no
  silent drops).
- Baseline staleness: a baseline older than `BASELINE_STALE_AFTER_MS` appends
  a `stale-baseline` annotation (refresh is user-confirmed only, never
  automatic) — deltas still compute, still allows.
- Hardening preconditions (deferred, not built here): checked-in baselines per
  gate, explicit sign-off on thresholds, auto-refresh policy — none of these
  exist yet, so nothing in this phase may block on weight or coverage.
- Phase evidence: plugin host surface (the measured entry)
  [VERIFIED: sha256:f42787d2ce436bbd6d55e90a15d45b656290a1a44451fff3318b094a4582ce01];
  bus transport
  [VERIFIED: sha256:f2c0843b598ba6f19cc0e208f8d02e0250c70615e3c484474d50635d0b5cdef8];
  never-deny precedent
  [VERIFIED: sha256:cd66253fec923d8210d2863f98d9c5669662ac70c3a1939f2bd8ea30ed007644];
  honest-status vocabulary
  [VERIFIED: sha256:da194d498bc256f2b619c406015a3fb600712ec5b8c8ab9001fc38f0a6f5c8cc];
  package.json baseline (Biome sole devDep before esbuild)
  [VERIFIED: sha256:7690b878a654ee4dee2b649b60740bc95d4b746cf786051887153b6f656f2e5e].

## Appendix: upstream issue draft (draft only — do not file without user sign-off)

Title: `Ask: tool.execute.before-class pre-execution guard API for plugins`

Body:

> IUMBTEMS ships an in-plugin six-event hook bus (pre-tool-use,
> post-tool-use, pre-commit, stop, notification, session-start) with tiered
> fast-short/slow-long enforcement and an audit log, wired to the v2
> command.transform + tool.transform + session.hook + rpc shape. What is
> missing is a host-side pre-execution guard: there is no
> `tool.execute.before` registration point, so a plugin cannot intercept or
> veto host tool calls (webfetch/websearch) the way Claude Code hooks do.
>
> Ask: a `tool.execute.before(handler)` (and ideally `tool.execute.after`)
> domain where a handler returning deny blocks the execution, with a bounded
> timeout and a documented fail-open/fail-closed contract. Until then our
> pre-tool-use/post-tool-use events enforce on this plugin's own tool
> executions and degrade to advisory annotations for host-native calls; stop /
> notification are bus-level only.
>
> Repro/pointer: the accepted-asymmetry comment in the plugin
> (see plugins/opencode/index.js:1137) and the parity gap list in
> docs/HOOK_BUS_PARITY.md.
