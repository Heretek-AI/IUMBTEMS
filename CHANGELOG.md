# Changelog

## 1.6.0 — 2026-10-09

Phase 5 self-improvement: runs already leave rich records (audit chain,
QA failures, gate rejections, findings, spend, evals) and now the factory
learns from them. `es improve harvest` aggregates runs and evals into one
versioned, secret-scrubbed telemetry dataset; `es improve distill` clusters
recurring failures into reviewable proposals a human applies; the
`self-dogfood` preset builds this repo from an issue into a draft PR.
The published trio (core/CLI/plugin) releases in lockstep as 1.6.0.

**New.**
- **#135: telemetry harvester over runs and evals.** Read-only
  `es improve harvest --runs <dir>[,<dir>] [--evals <dir>[,<dir>]] --out <file>`
  (agent-safe) producing the versioned `TelemetrySchema` dataset: phases
  with replans and failure counts, halts with reasons, spend, gate
  rejections by rule, audit findings by kind/severity, eval results with
  `modelLimited`, and the audit-chain verification. A broken chain is
  reported, never repaired; env-like values are scrubbed and state-dir
  paths collapsed. Schemas render to `schemas/` and `docs/SCHEMAS.md`.
- **#136: distillation into reviewable proposals.** Deterministic
  clustering keyed on (kind, label) with defaults of 3 occurrences across
  2 runs; each surviving cluster becomes one proposal under
  `.factory/improve/proposals/<id>/` — `prompt-guidance` (a version-bumped
  patch that passes `git apply --check` and the assets drift check),
  `gate-tuning` (an explanation only; `gates.json` stays a human-applied
  control file) or `domain-pack` (validated against `DomainPackSchema`).
  The "code disposes" gate drops proposals whose evidence is not a
  verbatim harvester quote or whose model numerals the telemetry never
  recorded. `es improve distill --telemetry <file> --out <dir>` is
  agent-safe; `--open-pr` is human-run (refused without a terminal) and
  drafts from a topic branch without pushing the base.
- **#137: self-dogfood preset.** `es factory init --preset self-dogfood
  --issue <n>` (human-only) seeds `.factory/` from versioned preset
  assets — project config (`audit.phase: required`), the real merge gate
  (`bun install --frozen-lockfile`, `bun run check`, `bun run docs:check`),
  a roadmap seed pinning `baseBranch: rewrite`, and the issue as the idea
  note — then reminds about `es trust`, the $15 spend ceiling and the
  frontier/spec approvals. `docs/SELF-DOGFOOD.md` is the runbook
  (prerequisites, flow, review, abort); one human-run validation session
  to a draft PR is tracked on #137.
- **#138: release 1.6.0.** Version bump, changelog and status line; draft
  release PR from `integration/phase-5` to `rewrite`.

## 1.5.0 — 2026-10-09

Phase 4 web control plane: the fleet daemon serves a browser UI on
loopback behind a one-time URL — a fleet dashboard, frontier/spec
approvals in the browser (ADR 0002 option b), a preview-only config
editor, and an evidence explorer with range-highlighted quotes and seal
statuses. `packages/web` stays private and is served from the repo (the
fleet daemon is private too, so no asset-shipping decision is needed);
the published trio (core/CLI/plugin) release in lockstep as 1.5.0.

**Security.**
- **#129: the web UI is localhost-only behind a single-use ticket
  exchange.** `es-fleet web` (human-only, refused under `ES_SANDBOX`)
  mints a 32-byte ticket (TTL 120 s, atomic-rename claim) that the first
  load redeems for an `HttpOnly; SameSite=Strict` session cookie; wrong
  Host (DNS-rebinding defense) and non-loopback Origin are refused, and
  every web response carries a strict CSP (`default-src 'self'`, no
  inline scripts, `frame-ancestors 'none'`).
- **#131: browser approvals sign only what was previewed.** Preview
  returns the subject, files and hashes with a single-use ticket bound
  to `hashJson(subject)`; submit needs the session cookie, a loopback
  Origin and the session CSRF token, then re-derives the subject
  (409 on mismatch), unlocks the sealed key in-process, records with
  channel `web`, and destroys the signer. Five wrong passphrases lock
  the web surface with an audited `approval.lockout`; the passphrase
  lives in one page-local variable and appears in no log, event,
  response or state file (probed). The ADR 0002 adversarial-review
  checklist for the browser path passes 9/9 applicable probes (posted
  on #131); I8 stays user-confirmable (option b implemented).
  Trust, waive, resume, key seal, config set and export are untouched
  and stay terminal-only.
- **#133: hostile source text is inert.** Quotes render through text
  nodes split by verified ranges into `<mark>` spans (never HTML
  parsing, probed with `<script>`/event-handler payloads); seal status
  (sealed/unsealed/invalid/unknown) shows on every source, with
  tampered bytes refused by their content hash.

**Behaviour changes.**
- `fleet.status` pending entries now carry the approvable `stage`,
  enriched from each worktree's pending list (#131); snapshot tasks
  carry `title` and `deps` for the DAG (#130).
- `bun run test` runs the web suite first under browser conditions
  (the client Solid build), then every other package (#130).

**New.**
- **#129: `packages/web` (private, never published).** SolidJS + Vite
  (ADR 0003: shared signals with the TUI, 15 kB hello build), served by
  the daemon from the bus port; declared `deps.ts` boundaries and a
  path-filtered CI job.
- **#130: fleet dashboard.** Columns-by-depth task DAG, task table,
  spend against the ceiling, pending list, per-task pages and a live WS
  stream with reconnect refetch and a 5 s stale banner — read-only
  throughout, status always in words beside colour.
- **#131: approvals pages.** `#/approvals` list and
  `#/approve/<task>/<stage>` page (masked, non-reactive input cleared
  on submit; remaining-attempt and lockout-delay alerts).
- **#132: config editor, preview-only.** Project/gates tabs with
  strict-schema validation, exact hash diffs and copyable terminal
  commands over read-only `fleet.config.get`/`fleet.config.plan`; the
  bus has no apply method and the UI no apply button. Browser apply is
  deferred to #145 (needs #131's pattern plus the user's ADR 0002
  extension).
- **#133: evidence explorer.** Claim/source graph with tag/status/tier
  filters, inspector (rank explanation, retractions, history), source
  viewer with verified quote highlights, and Markdown/HTML dossier
  exports through the #112 renderers — read-only, capped payloads.
  Core gains `locateQuote` (index-mapped ranges, self-checked).

**Evals and CI.**
- Web tests render with the client Solid build under happy-dom
  (`bun --conditions=browser test packages/web`).
- Full `bun run test`: the same 8 pre-existing bwrap-overlay sandbox
  failures as 1.4.0 (identical set fails on the base; green in CI
  where bwrap works).

**Dependencies.**
- `packages/web` shares the TUI's `solid-js` 1.9.15 lockfile entry; new
  stock npm needs are `vite`, `vite-plugin-solid` and dev-only
  `happy-dom`. Zero vendored code in the phase.

## 1.4.0 — 2026-10-09

Phase 3 fleet: concurrent task DAGs run on one machine under a human-only
`es-fleet` daemon — a deterministic scheduler, isolated git worktrees per
task with gated landings onto an integration branch, one headless run per
task with per-task spend ceilings, and a read-only localhost telemetry bus
with an `es-fleet watch` dashboard. `@heretek-ai/es-fleet` ships from the
repo only (private) until its RPC is stable; the published trio
(core/CLI/plugin) release in lockstep as 1.4.0.

**Security.**
- **#122: starting or stopping the fleet is human-only, by policy and in
  the binary.** The policy's binary matcher knows `es-fleet`, and the whole
  binary is human-only except `status`/`--help` (fail-closed flag
  resolution); `start` additionally refuses agent sandboxes, requires a TTY
  plus a typed confirmation, and takes a mandatory fleet-wide spend ceiling.
  Fleet state lives under the sandbox-masked state dir.
- **#124: task worktrees are isolated by policy.** `.fleet/` is deny-write
  for every agent outside its own task worktree, and seats may not name
  other tasks' `.fleet/` paths in the shell. The base branch is never
  checked out, reset or merged — asserted in every worktree test.
- **#126: the telemetry bus is read-only, localhost-only and
  token-authenticated.** Host allowlist (DNS-rebinding defense), Origin
  checks on WebSocket upgrades, strict schemas that reject extra fields,
  and payload scrubbing (secret keys and known secret values never appear).

**Behaviour changes.**
- `es-fleet` refuses to start without a positive `--max-usd` ceiling, which
  caps the summed task ceilings.
- `es factory run --headless` takes no `--max-usd` (verified): workers
  provision each task's ceiling into its run state, where the factory guard
  enforces it.
- A landing conflict reopens the task as `waiting-human` — the one
  transition allowed out of `done` — and the daemon retries it after human
  repair.

**New.**
- **#122: `packages/fleet` (`@heretek-ai/es-fleet`, private).** State
  helpers, inode-bound socket guard, pidfile lifecycle with stale recovery,
  `es-fleet start/stop/status`, boundaries in `scripts/deps.ts` and a
  path-filtered CI job.
- **#123: task model and deterministic DAG scheduler.** `all_success` /
  `one_success` triggers, mandatory ceilings, `fail` / `retry(n)` /
  `replan` policies, `waiting-human` capacity relief, pure `schedule()`
  with a property test over random DAGs, `es-fleet task add/list/cancel`.
- **#124: worktree coordinator and gated integration branch.**
  Two-phase allocation, salvage refs, orphan `gc`, transactional landing
  (gates first, `--no-ff` merge in a throwaway worktree, verified rollback
  on conflict) onto `fleet/integration/<dag>`.
- **#125: workers.** Argv-only headless runs, event folding with spend and
  token tracking, no-double-start supervision with restart recovery,
  StillDown + mass-death circuit breaker, and the daemon tick loop
  (`schedule → allocate → launch → land → release`) with a SIGTERM kill
  switch recording resumable cancellations.
- **#126: telemetry bus and `es-fleet watch`.** Strict-schema RPC
  (`fleet.status/task/pending/events` with monotonic backlog replay),
  coalesced WebSocket stream, 0600 token, TTY dashboard.
- **#127: merge-blocking fleet integration suite.** A→B+C on the real host
  with the fake model proving ordering, overlap, output ownership (and no
  `.factory/` leakage across branches), failure/retry/cancel, conflict
  repair and stop/salvage/gc — plus break probes proving the suite bites.

**Evals and CI.**
- #127 runs in `bun run check` (~10 s, 5/5 deterministic locally).
- Full `bun run test`: 8 failures are the pre-existing bwrap-overlay
  sandbox failures of containers (identical set fails on the base; green in
  CI where bwrap works).

## 1.3.0 — 2026-10-09

Phase 2 approvals everywhere: frontier and spec approvals complete in the
OpenCode TUI as well as the CLI, through one shared core service, under
the threat model and invariants of ADR 0002. The headless runner gains
the fleet entrypoint: a versioned JSONL event stream with per-turn
metrics, graceful cancellation and turn timeouts, and worktree validation.

**Security.**
- **#116: ADR 0002 (proposed) puts approvals on every surface.**
  Threat model (5 actors), normative invariants I1–I8, a 25-row inventory
  of terminal-only enforcement points, and the adversarial-review checklist
  gating the TUI (#119) and browser (#131) builds. Trust, waive, resume,
  key seal, config set and export stay terminal-only.
- **#119: frontier and spec approvals complete in the OpenCode TUI.**
  A masked passphrase dialog (plaintext only in a closure-scoped buffer,
  zeroed on submit/cancel) unlocks the sealed human key and signs
  in-process through the core `approveStage` service (`channel: "tui"`).
  No passphrase and no approval cross RPC (no approve/trust/resume RPC
  exists); previews bind the signed subject through a single-use ticket
  (TTL ≤ 120 s); 5 wrong passphrases per 10 minutes lock the TUI surface
  out with an audited lockout. The masked-input spike (#118) verdict is GO
  with headless-renderer evidence.
- **#117: one approval code path in core.** `approveStage` re-derives the
  subject with a preview-hash check, signs, clears pending and begins
  research under its locks; re-approval of an unchanged subject is a
  side-effect-ensuring no-op. `HumanSigner.destroy()` ends signing.
  `ChannelSchema` is now `cli | tui | web`, shared by approvals and waivers.

**Behaviour changes.**
- Approval status messages name `/es-approve` first; the TUI pending panel
  and the liveness lines point at the TUI with the terminal as the fallback.
- `schemas/approval-channel.schema.json` is replaced by
  `schemas/channel.schema.json` (same shape, plus `web`).
- Headless runs without the new flags print as before, plus a
  `turn-metrics` line per turn at info level and above.

**New.**
- **#120: fleet-ready headless runner.** `--events jsonl` (versioned
  envelope per line: `JsonlEnvelope`/`HeadlessJsonlSchema` exported from
  the CLI; `--events-file` redirects to a file), per-turn `turn-metrics`
  (sealed spend delta, tool activity, opportunistic tokens),
  SIGINT/SIGTERM cancellation (exit 130, resumable), `--turn-timeout`,
  and `--cwd` validation (other runs' seat worktrees and detached HEADs
  refused; the root is indexed). See `docs/HEADLESS.md`.

## 1.2.0 — 2026-10-09

Phase 1 epistemic layer: research, brainstorm and harvest work outside the
fixed factory flow. Backends fail over with the gateway leading, the grill
and the factory fan out brainstorms and verdict-check harvest targets
themselves, deep research runs thesis/antithesis/synthesis to a grounded
report anywhere, dossiers render to Markdown and HTML, and domain-pack tiers
weight the score. A merge-blocking research-fires suite pins the whole loop.

**Security.**
- **#106: provider API keys are masked in seat sandboxes.**
  `BRAVE_API_KEY` and `FIRECRAWL_API_KEY` join `SECRET_ENV`, so agent shells
  never see them; backends run in the plugin process.
- **#107: the gateway token never leaves its header.** It comes only from
  `ES_SCRAPER_SWARM_TOKEN`, is masked in sandboxes, and never reaches
  `.factory/`, logs or error messages.

**Behaviour changes.**
- Research completion in research-mode runs ends at DONE (build runs still
  move to SPEC); deferred frontier facts are required only in build runs.
- `FETCHED` snapshots are capability-derived (fetch-capable backends count);
  legacy `fetch`/`webfetch` entries still do.
- Prior-art records are keyed per brainstorm run; legacy global records
  satisfy any run.
- Brainstorm and harvest artifacts live under `runs/<run>/` (the human's
  flows stay the `default` run); legacy top-level files still read.

**New.**
- **#106: ordered source-backend failover** (`SourceBackend`,
  `research.backends`, per-backend cooldowns with 429 Retry-After;
  `blocked` safety refusals never fail over; `searchProvider` kept as an
  alias).
- **#107: Scraper-Swarm gateway backend** (JSON-RPC `web_search`/`fetch_page`
  over `POST /mcp`, contract v1 with `content_sha256` verification, leading
  the default order when configured; recorded-fixture contract tests).
- **#108: callable brainstorm fan-out** (run-scoped store, grill/factory
  callers at depth 1, shortlist JSON, lean budgets).
- **#109: callable harvest target and shared prior art**
  (`es_harvest_target` verdicts for grill/factory/scout/harvester,
  run-scoped harvest plans, `PriorArtSearchSchema`).
- **#110: research-only runs** (`beginResearchRun`, objective + ceiling, no
  frontier/approvals/git needed).
- **#111: deep-research coordinator** (`deep-researcher` + synthesizer seats,
  human-only `es research deep`, interactive `/research deep`).
- **#112: dossier renders** (deterministic Markdown + self-contained HTML,
  XSS-tested; agent-safe `es research render`).
- **#113: domain-pack tiers reach claims** (deterministic source
  classification sealed in `SourceMeta`, `ClaimSchema.tier`, tier-weighted
  scores; unknowns stay `__default__`).

**Evals and CI.**
- **#114: merge-blocking research-fires suite** (grounded quotes, failover,
  sealing, degradation, renders; break-probe verified) plus a
  reported-never-blocking `deep-research` eval case.

## 1.1.5 — 2026-10-09

Phase 0 hardening: every trust boundary the 1.1.x series left soft is now
sealed, pinned or tested — source-cache seals on every reader, MCP caller
identity, CLI/policy argv parity, a registry-generated scoping suite,
fail-closed seat models, and consistency cleanup. No human-only verb changed.

**Security.**
- **#98: every source-cache reader verifies seals.** Scout advisories,
  brief export, retract and audit dossiers went through unsealed caches, so
  planted entries read as evidence. All constructions now go through the
  sealed constructor, planted entries are refused, and a misuse-guard test
  fails any new unsealed construction.
- **#99: MCP caller identity is pinned, research tools gain core seat
  checks.** A piped `agent` argument could claim any seat over `es mcp`;
  identity now comes from the adapter environment (`ES_MCP_AGENT`, else
  legacy `ES_AGENT`), defaulting to seat-less `mcp`. `es_research_search`,
  `es_research_fetch` and `es_research_audit` enforce the registry grants in
  core. The research tools are not on the MCP surface at all.

**Behaviour changes.**
- **#96: seat models fail closed.** Malformed refs and unknown
  `models.agents` keys are rejected at config load; a configured model
  missing on the host refuses that seat at launch with remediation (naming
  the key and `es config set`) and shows in `es_status`. Unset tiers still
  inherit the session default, explicitly.
- **#101: `es_request_approval` admits factory and grill only.** The manager
  seat was accepted against the registry's grants.
- **#97 precision:** known boolean flags read single-way in the human-only
  rule, cutting false denials with zero lost denials (property-gated).

**New.**
- **#100: registry-generated permission matrix and bypass probes**
  (`packages/opencode/test/scoping.test.ts`). OpenCode's
  `Permission.evaluate` + `Wildcard.match` (MIT) are vendored into the
  testkit; every seat's compiled rules are asserted against its registry
  spec, and each restriction class is probed on the real host, including the
  post-#99 MCP pin.
- **#102: one workspace package list** (`bun scripts/packages.ts`):
  the typecheck loop, `pack-smoke.sh`, `publish.yml` and `deps.ts` read it;
  new packages declare `esRelease.order` and `BOUNDARIES`.

**Fixes.**
- **#101 registry consistency:** factory tool union equals `ALL_ES_TOOLS`
  with single registration (tested both halves); `confirmationCode` and the
  ignored `recordApproval` `stateDir` removed; waivers comment corrected to
  Ed25519; subagent `spawns` stay empty (depth 1, tested).
- **#139: the `auditor-thesis` eval stages an open audit run**, graded
  deterministically on the verdict record instead of narration luck.
- **#103 hygiene:** `.claude/CLAUDE.md` is a pointer to AGENTS.md (dead
  `runner/` paths gone); README and DOGFOOD gain the 0.7 options note.

**Evals and CI.**
- Seeded argv-parity property (3 × 2,000 cases) plus HELP-marker parity,
  both with recorded break probes (#97).
- `docs/CONFIG.md` documents the nested `models.*` keys (#96).
- CI pattern for future packages documented in ADR 0001 (path-filtered
  workflows; `check` stays unfiltered) (#102).

**Dependencies.** `@opentui/core` + `@opentui/solid` 0.5.14 → 0.5.17: the
nested `@babel/core` 7.28.0 pin is gone (7.29.7).

## 1.1.4 — 2026-10-08

A security fix for the human-only shell rule, plus the E2E feedback fixes
(#85). This closes the 1.1.x proof-of-work phase (#35); the user waived the
dogfood and the local real-model run.

**Security.**
- **#88: a flag before the verb slipped past the human-only shell rule.**
  The rule read only the word right after the es binary, but the CLI takes
  `--flag`, `--flag value`, `--flag=value` and `--` anywhere. So
  `es --cwd . approve spec`, `es -- approve spec`,
  `es --run <id> factory resume` and `es factory --cwd . resume` were
  allowed for every agent, factory seats included.
  - Approvals and keys stayed guarded by the masked key and the
    terminal-only passphrase. Spend-bearing `audit` and `scout` runs and
    `factory resume` were not.
  - The rule now finds the verb the way the CLI parser does. A bare `--flag`
    counts both as a boolean and as taking a value.
  - Upgrade from any earlier version.

**Fixes.**
- **#86: refusals for text that only names a guarded verb.** The rule stays
  quote-blind, so a here-doc, a commit message or a `--body` argument that
  mentions a human-only verb is still refused. The refusal now says how to
  pass such text by file (`gh … --body-file`, `git commit -F`).
- **The grill skill's first turn asks and never records** (#85). The seat
  had been writing the frontier before asking anything.

**Evals and CI (#85).**
- The `programmer` case stages a BUILD run with a phase worktree, so it can
  pass (#66).
- Step caps were re-budgeted from observed need, and the `ES_EVAL_MAX_STEPS`
  ceiling went from 16 to 24 (#67).
- `e2e-feedback` fails only when a historically stable case fails
  (`scripts/e2e-gate.ts`, #68). `audit-fires` is marked model-limited on the
  free CI model.
- Grading reads completed tool outputs, except the raw fetch tools, whose
  verbatim quoting is the skill under test.
- Kept workspaces mirror `.factory/` to `keep/factory/`, because the
  artifact upload drops dot-dirs.

**Dependencies.** `@babel/core` 7.29.6, dev only (GHSA-4x5r-pxfx-6jf8).

## 1.1.3 — 2026-10-08

Live-run visibility and seat discipline, from the 1.1.2 dogfood (#63): a
human could not tell a working run from a frozen one, and the factory
relaunched live research seats as second writers.

**Behaviour changes.**
- Factory seats launch seats in the foreground only. `subagent` with
  `background: true` from a seat is refused, and so is launching a seat
  that is still running. A pair (QA, auditors, brainstorm lenses) is
  several calls in one message, which the host runs in parallel. RESEARCH
  runs alpha, then beta.
- One writer per research file. Alpha writes only `research/alpha.md`, beta
  only `research/beta.md`, and only the factory writes `research/REPORT.md`.
- Prompts: factory v7, research alpha/beta v3, brainstormer v2.
- `es factory run --headless` emits `progress` events. `stalled` carries
  evidence, and the turn cap is its own `turn-cap` event. The default
  output is one line per tool call (`--log-level quiet|info|debug`).

**Fixes.**
- **#60: the false stall and the duplicate writer.** Three causes:
  - The in-host continuation re-prompted the factory right after it
    launched background seats.
  - The headless driver's own turns suspended those seats.
  - Neither counted research artifacts as progress.

  Progress is now a shared fingerprint over the stage machine, research
  artifacts, seat outcomes and the audit head. The continuation waits while
  a seat runs, and announces its pause instead of going silent.
- **#59: the signature-mismatch dead end.** `es status` from an agent shell
  minted a throwaway engine key in the sandbox's masked state dir and
  called the run state forged.
  - Verifiers never create the key. A missing key gets its own message
    (use the `es_status` tool in an agent shell; otherwise set
    `ES_STATE_DIR`), and sandboxes set `ES_SANDBOX`.
  - `es reseal` names the key it checks and refuses to sign without it.
  - Sidecars are written atomically.
- **#59: `--help`.** A plain `es <command> --help` is allowed for agents,
  and prints that command's usage. The seat block on control paths points
  at the read tool, glob, grep and `es_status`.
- **#57: the dashboard.** It shows the headline, the run header, seats,
  research progress, phases (no dangling `Phases:`), what waits on you and
  recent events. It opens beside the session: `Esc`/`q` closes, `f` toggles
  fullscreen, `r` refreshes, and `/es-close` closes it too.
- **#62: the RPC `changed` event is emitted.** It fires after `es_*` tools
  and seat transitions (coalesced to one a second) and with pause notices.
  The TUI toasts only stage changes and notices.

**New (#58, #61).**
- `es status` leads with a plain sentence, then the run id, stage, project
  path and age, seats, research progress and recent events.
  - `--json` gives the same data to scripts.
  - `--run <id>` targets another project's run.
  - It hints when another project's run is fresher.
- `es runs [--all] [--json]` lists recent runs across projects, from a
  per-user index under the state dir.
- `es watch [--interval S]` redraws `es status` in the terminal; `q` quits.
- `es_status` and `/status` add the headline, last activity, seats and
  research progress. The `<factory-state>` block injected into prompts is
  unchanged.
- The TUI prompt footer shows `ES · <stage> · <seat> running · <age>`, or
  what waits on you.
- Seat records live in `.factory/runtime/seats.json` (advisory, written by
  the plugin).

## 1.1.2 — 2026-10-07

Proof-of-work follow-up to the 1.1.1 security release (#54).

- **`audit.phase: optional|required` (#33).** Default `optional` keeps 1.1.x
  behaviour; `es config set audit.phase required` refuses merges of QA-passed
  phases without a passed or human-dismissed audit. The factory prompt (v6)
  opens the phase audit as the phase enters QA when required.
- **`@@CHILD` testkit directive (#34).** Delegated child sessions receive
  scripted tool calls through the parent's subagent prompt; the parent's
  `@@CALL` script no longer consumes them.
- **Pipeline A.** Deterministic real-host factory loop (grill → research with
  a deferred fact → spec → two phases with build/QA/audit, a QA fail and a
  STOP/resume → release → DONE), with required audits reached through
  delegation; merge-blocking in CI.
- **B eval cases.** research, thesis auditor, programmer, adversarial QA and
  designer cases with staged fixtures and a localhost fixture server
  (`{{SERVE_URL}}`); validated locally, scored nightly.
- **Signed sidecars.** `.factory/runtime/state.json` carries an HMAC sidecar
  under the masked engine key; reads refuse pre-seeded or tampered state and
  only a human re-signs reviewed files (`es reseal --sign`).

## 1.1.1 — 2026-10-07

Security release (#35). The 1.1.0 adversarial audit broke the text-matched
shell policy six ways, forged VERIFIED claims through the shell, and drove
approvals through a stealable service password; 1.1.1 moves that enforcement
into the OS, the crypto and the sandbox. Published 1.1.0 is deprecated.

**Breaking.**
- Re-approve, re-trust and re-waive after `es key seal`: v1 HMAC records
  were MACed with a key agents could read; they are refused with the
  re-record hint.
- Bubblewrap is required for factory seats (refused a shell without it) and
  factory gate runs (halt with `gates/sandbox-missing`); CI, nightly, E2E
  and publish install it and allow unprivileged user namespaces.
- Approvals, waivers, trust and resume happen at a terminal only: the
  approve/trust/resume RPCs no longer exist and the TUI only previews, then
  points at the terminal command.

- **S1: quotes are evidence fragment by fragment (#38, #46, #48).** Every
  ellipsis fragment must be at least 12 characters on its own; code excerpts
  are one contiguous verbatim span of the cited lines (at most 60 lines); a
  thesis pass needs at least one witnessed invariant that holds; the
  audit/scout/harvest fire graders are exact (plants cited within 3 lines,
  no extra or duplicate rows).
- **S2: argv-aware shell policy (#37, #40–#45, #50, #51).** Quotes and escapes
  are stripped before matching, human-only verbs are found behind wrappers,
  git subcommands past global options, and control paths match
  case-insensitively; any `.factory/` mention needs a provably read-only
  command. This is defence in depth and the only layer for the user's own
  agents without bubblewrap — documented as weaker.
- **S3: every agent shell and gate run is sandboxed by bubblewrap.** Kinds:
  `user`, `seat`, `programmer`, `readonly` and `gate`; cached-web seats get
  `--unshare-net`; the private state dir and service credentials are masked
  in every kind. Seats lose Code Mode `execute`; the shell is re-checked by
  the last hook after the hook bridge.
- **S4: passphrase-sealed Ed25519 human key, terminal-only approvals (#39).**
  `es key seal` (asked twice, at least 10 characters) seals the key with
  scrypt + AES-256-GCM; every human action unlocks it with a passphrase at a
  TTY. A wrong or empty passphrase records nothing.
- **#49: no approval RPC for a stolen service password.** Verified: the
  mutating RPC methods are gone (previews still work) and `service.json` is
  masked in every agent sandbox.
- **#52: engine-sealed source cache.** Each entry's metadata carries an
  HMAC-SHA256 seal from a key in the masked state dir; unsealed (planted)
  entries are refused on read.
- **#32: per-file control re-pin.** `es_frontier_write` re-pins only
  `frontier.json` when its baseline matches, so a concurrent hand edit to
  another control file still halts as drift instead of being absorbed.
- **#31: host web caching only for factory seats in a factory project.**
  Without `.factory/`, nothing is cached and no `.factory/` is created;
  the user's agent never caches.
- **M1: eval harness that can pass (#25–#29, #36).** Case caps authoritative
  under a ceiling of 16, `toolsUsed` counts completed calls, spend read from
  `step_finish` cost under `ES_EVAL_MAX_USD`, failed workspaces kept and
  uploaded, nightly evals off push, agent feedback uses PWD.

## 1.1.0 — 2026-10-07

"Dialectic Restoration" (#20) brings back the best of the 0.7 research
harness, ported to TypeScript inside the 1.x trust model. Milestones: M1
foundation (#21), M2 seats (#22), M3 rigor (#23).

**Breaking, no migration.** The frontier schema moves from 1.0 to 1.1. 1.0.x
frontiers are **not** migrated: a 1.0 `.factory/frontier.json` is refused with
the fresh-run instruction, so 1.1 needs fresh runs.

### M1: foundation (#21)
- **Security: cached evidence is tool-only.** Before this release, a research
  or factory seat could write `.factory/research/sources/<sha256>.md` with made-up
  text. The cache's only tamper check is "content hashes to the file name",
  which a forgery passes by construction, so the seat could then cite its own
  text as VERIFIED. The source cache, `coverage.json`, the research dossier,
  the signed brief and `.factory/claims/` are now control files: no agent may
  write them, and seats may not mention them from the shell.
- **Claim stack** (`packages/core/src/claims/`):
  - Claims have content-hash ids and both an epistemic tag and a lifecycle
    status.
  - The witness re-checks every VERIFIED quote against the cache, and every
    code location (file, line range and verbatim excerpt) against the file on
    disk.
  - Dossiers refuse any claim whose witness fails.
    `es_research_complete` now writes `.factory/research/dossier.json`.
  - Retracted sources make their claims STALE, and revised ones SUSPECT
    (`es research retract`, human-only).
  - `ClaimStore` indexes the dossiers.
  - A deterministic, lexicographic ranker orders rival claims and dossiers.
- **Proof-carrying research brief.** `es research export` writes a signed
  `.factory/research/brief.pcrb.json`, and `es research verify-brief` checks
  source identity, the manifest (it notices deleted members), the signature
  and the quotes.
- **Design tree (frontier 1.1).** Nodes gain `kind` (decision or fact),
  `recommended` and `round`. `es_frontier_write` checks each save against the
  previous one:
  - no deleted nodes;
  - no silent edits to settled answers (reopen first);
  - no going back a round.

  It also returns the next round's questions. `<factory-state>` gains a tree
  progress line, and the factory panel shows it too.
- **Facts versus decisions.** The grill settles repo facts itself and defers
  web facts as `kind: "fact"` nodes. `es_research_complete` refuses until
  every deferred fact is answered on a grounded claim line marked
  `(fact:<id>)`.
- **Prompts.** `grill` goes from v1 to v2: frontier rounds, round-1 premise
  inversion, the freeze procedure. `factory` goes from v3 to v4: deferred
  facts and research depth. The 1.0.5 no-run routing is kept.
- **Search as policy.** Research seats no longer get the host `websearch`
  or `webfetch` tools; every web fact goes through `es_research_search` and
  `es_research_fetch`. Fetches are keyed by canonical URL (ported exactly from
  the 0.7 webcache), and a fresh full-page snapshot is served from the cache.
  The freshness window is 7 days, or 30 for documentation hosts;
  `refresh: true` refetches.
- **Configure.**
  - New `research.depth` (1–4, advisory), `research.cacheTtlDays`,
    `research.searchTimeoutS` and `research.searxngUrl` (global only).
  - `es config set <key> <value> [--global]` is human-only, validated against
    the schema and confirmed with a typed code. It refuses to accept drift in
    other control files, and it re-pins the project config.
- The research auditor's `ClaimStatus` type is renamed `ClaimAuditStatus`.

### M2: seats (#22)
- **Breaking:** the factory state goes from version 1 to version 2. 1.0.x run
  states are refused with the fresh-run instruction; there is no migration.
- **Code-audit pair.** The hidden `es-auditor-thesis` seat maps invariants and
  the hidden `es-auditor-antithesis` seat red-teams them with CWE ids.
  - **The line-pointer law:** `es_audit_verdict` checks every finding against
    the file on disk (it must exist inside the target, the lines must be in
    range, the excerpt must be verbatim). A hallucinated reference refuses the
    whole verdict.
  - **Audits block.** A phase audit holds the merge until it passes, and a
    failed one sends the phase back to the programmer. An open or failed path
    audit refuses the next stage transition.
  - Splits go to the manager: `es_tiebreak` gains `audit`. Only a human can
    dismiss an audit (`es audit dismiss`).
  - Each round writes `.factory/audits/<id>/{records,dossier}.json` and a
    deterministic `REPORT.md`.
- **OSS scout (`/scout`).** The scout plans, discovers (sharing darkharvest's
  search), scans (darkharvest's fail-closed license detection), checks OSV
  advisories (the responses are cached and cited) and records witnessed
  assessments. Core recomputes every verdict, keeping `adopt` only for a
  verified, whitelisted, permissive license, flags severe advisories, ranks the
  candidates and writes `.factory/scout/REPORT.md`. Adoption stays a human
  decision.
- **CLI:** `es audit <target>` (plus `show` and `dismiss`), and
  `es scout "<feature>"` (plus `show`). Both are headless, honour STOP and the
  spend ceiling, and, with no run, start one at a terminal with `--max-usd N`.
  Agents cannot launch them from a shell.
- **A halted run now stops every seat tool except `es_status`.** Previously a
  seat's own `es_*` tools kept running after a halt.
- **Fires.** The deterministic `audit-fires` and `scout-fires` suites run on
  the real host in CI. The same graders score the nightly model runs
  (`evals/cases/*-fires.json`; cases can now seed files).
- New ENFORCED capability rows: `claims`, `audit`, `scout`. Prompts:
  `auditor-thesis` and `auditor-antithesis` v1, `scout` v1, `factory` v4 → v5,
  `manager` v1 → v2.
- When research completes, pruning the cache keeps every source that any
  dossier cites.

### M3: rigor (#23)
- **Domain packs, the full legacy port.** `quant`, `biopharma` and `legal`
  constitutions (tier weights incl. `__default__`, negative-knowledge bonus,
  reject penalty, accept threshold, banned domains, mandatory tags, standard
  or zero-tolerance retraction), selected with `config.domainPack` (for
  example `es config set domainPack biopharma`). With a pack active,
  `es_research_complete` rejects claims that break the constitution — a
  banned source domain, a missing tag, a retracted source — and refuses a
  score below the pack's accept threshold; unknown packs fail closed. Without
  a pack nothing changes. Claims now carry their source URL, and the summary
  shows the active pack during RESEARCH.
- **All five fire suites are merge-blocking.** `grill-fires` (no deleted
  nodes, no silent settled edits, no round regress; deferred facts gate
  research), `factory-gate` (the build starts only through the approvals;
  STOP and the spend ceiling halt, `es_status` stays reportable when halted)
  and `darkharvest-fires` (core keeps `depend` only for verified permissive
  licences, whatever the harvester proposes) join `audit-fires` and
  `scout-fires` on the real host. The same graders score the nightly
  model-backed runs.
- **Drift CI with a canary.** `docs:check` also fails on prompt, skill and
  registry drift: a prompt whose frontmatter id or seat disagrees with the
  registry, an orphaned prompt file or skill directory, a skill without its
  `SKILL.md`, a spawn naming no agent, an unknown `es_*` tool, or a duplicate
  agent id. The canary proves every class is caught.
- **Queereye phases 02 and 03.** The designer seat now renders the full
  design surface under `.factory/design/` (paths adapted from the legacy
  `.queereye/`):
  - `es_design_specs` (phase 02): behaviour-first component specs for
    `button`, `dialog`, `form-input`, `table`, `nav` and `toast`, the pinned
    MIT `webref.json` snapshot, the headless `csf.json` play harness and
    deterministic `tui-notes.md`, with drift, coverage, freshness and
    play-suite gates (`check:true` re-checks only).
  - `es_design_harvest` (phase 03): the full skill-harvest ledger
    (`harvest.json`: rows, SPDX blocks, transitive closure, negative
    knowledge) with the fail-closed MIT/Apache-2.0/BSD-3-Clause/ISC
    whitelist, the skill bundle and the factory cite-gate receipt, which is
    verified against the live tokens and ledger. The bundle check script is
    TypeScript against `es-core`; no Python is vendored.
- **Post-audit hardening (shell control files).** An adversarial audit found
  that a non-seat agent could still write control files through interpreter
  one-liners (`python3 -c`, `node -e`, …), which the shell rule never
  matched. A control-file mention is now allowed in an agent's shell command
  only when the command is provably read-only (allowlisted segments; no
  redirection, here-doc or substitution); seats keep the stricter
  no-mention rule, and the forge test now covers the shell path.
- **Post-audit parity hardening.** A parity audit against 0.7.25 found two
  port drifts, both fixed: `NEGATIVE_KNOWLEDGE` claims keep a full-key hash
  (`nkKey`, sha256 of the cleaned pre-truncate query/finding pair) so
  distinct past-2k rows stay distinct in ids and scoring while the stored
  fields stay capped (legacy R11); and the pack constitution carries the
  legacy structural rules again (VERIFIED needs its hash + quote or a code
  location; INFERRED its reasoning; HYPOTHESIS its falsification; NK query
  and finding). The legacy INFERRED "parents non-empty" rule is documented
  as not applicable to 1.x REPORT.md claims.
- **System architecture doc.** `SYSTEM_ARCHITECTURE.md` now describes the
  pipeline, the seats, the claim flow and the trust invariants in one place.

## 1.0.5 — 2026-10-07

Run-lifecycle gaps from dogfooding 1.0.4 (#19):

- `es … --help` is now side-effect free on every subcommand: it prints usage
  and exits 0 without minting runs or writing files. Previously
  `es factory begin --help` minted a phantom `run-…` GRILL state.
- `/factory` with no run no longer dead-ends the agent: the command itself
  replies "No factory run here yet — run /grill first."
- A missing or unsettled frontier now points at the recording step instead of
  a bare "missing artifact" error: `approvalSubject` and
  `es_request_approval` direct the human to `/grill`
  (or `es factory begin` + grill flow). No new write path: agents stay
  deny-write on `frontier.json`, approvals stay human-only.
- `factory` prompt v2 → v3: stop and route to `/grill` when `<factory-state>`
  reports no run.

## 1.0.4 — 2026-10-07

The 1.0 cutover replaces the Python research harness with the TypeScript
**Epistemic Swarm** monorepo (`@heretek-ai/es-core`, `@heretek-ai/es-cli`,
`@heretek-ai/epistemic-swarm`). This is a **breaking, one-way** change:

- **No migration.** Python-era `.research/` and `.factory/` state is **not**
  imported. The legacy harness is preserved at the `legacy-final` tag
  (v0.7.25) and receives **no further support** after cutover.
- The product is now an **AI build factory**: grill → research → spec → build
  ⇄ QA → release, enforced by a code state machine, hash-pinned gates, a
  signed audit chain, a mandatory spend ceiling and a `.factory/STOP` kill
  switch. Approvals, waivers and trust are human-only.
- Delivery is **OpenCode v2 first**; the Claude Code (1.1), Pi (1.2) and
  Antigravity (1.3) adapters follow, each publishing capability-matrix rows
  with smoke tests.
- Platform: Linux, Node ≥ 22 or Bun. No Python.
- Darkharvest licence verdicts are fail-closed: permissive only on a full-text
  SPDX template match, every licence file and SPDX header counted, harvested
  content never executed and confined to the project for agents.
- Packages publish from `bun pm pack` tarballs (real versions, no `workspace:`)
  that `scripts/pack-smoke.sh` installs and runs first.
