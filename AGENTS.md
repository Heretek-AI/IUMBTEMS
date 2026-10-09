# AGENTS.md — IUMBTEMS contributor guide (1.0 rewrite)

## Evidence first
Every factual claim in research or harvest artifacts carries a tag:
`[VERIFIED: <sha256>]` (verbatim quote in the content-addressed cache),
`[INFERRED: <parents>]`, `[HYPOTHESIS: <test>]`, or `[NEGATIVE_KNOWLEDGE: <query>]`.
Never present parametric recall as verified. Product code is exempt; the rules
apply to research/harvest claims and to capability claims (which name a test or
spike as proof).

## Naming
- **IUMBTEMS** is the project/brand; **Epistemic Swarm** is the product/technical
  name (npm `@heretek-ai/epistemic-swarm`, `@heretek-ai/es-core`,
  `@heretek-ai/es-cli`). Keep user-facing docs IUMBTEMS-led.

## Canonical surfaces (single source of truth)
- `packages/core/src/**` — the harness-neutral core. Skills and prompts live in
  `packages/core/assets/{prompts,skills}`; a prompt's frontmatter `seat` must
  match its registry agent and its body must mention every tool the seat may
  call (`packages/core/test/assets.test.ts` enforces both, with a version-bump
  snapshot).
- `packages/opencode/src/**` — the plugin (server + TUI entrypoints). The
  canonical agent registry (`packages/core/src/agents/registry.ts`) compiles to
  v2 agents with wildcard-deny scoping; never touch built-ins or defaults.
- `packages/fleet/src/**` — the human-only fleet daemon (`es-fleet`, private
  until its RPC is stable). Depends on core only; core, CLI and plugin never
  import it (`scripts/deps.ts` boundaries + a path-filtered CI job).
- `packages/web/src/**` — the web control plane (SolidJS + Vite, private,
  never published; ADR 0003). Served by the fleet daemon on loopback behind
  a single-use ticket exchange; a leaf surface — nothing imports it, and it
  imports nothing at runtime except the fleet API's schema types
  (`scripts/deps.ts` boundaries + a path-filtered CI job).
- `packages/core/src/capabilities.ts` — the capability matrix. ENFORCED rows
  must name a proof (test file or spike record) that exists; `bun run docs:check`
  and `capabilities.test.ts` fail otherwise.
- GENERATED — never hand-edit: `schemas/*.schema.json`, `docs/SCHEMAS.md`,
  `docs/CAPABILITIES.md`, `docs/CONFIG.md`. Edit the Zod schema / capability
  table, then run `bun run docs:gen`.
- Hand-maintained: `README.md`, `AGENTS.md`, `SYSTEM_ARCHITECTURE.md`, `docs/DOGFOOD.md`, `docs/adr/*.md`, `docs/roadmap/*.md`, `spikes/*/RESULTS.md`, `.github/**`.
- One repo, one npm package per surface (`docs/adr/0001-monorepo.md`): core never imports the CLI or the plugin, and the CLI never imports the plugin (`bun run deps:check`).

## Commands
- `bun install` · `bun run check` (biome + tsc + all tests) · `bun run test`
- `bun run docs:gen` / `bun run docs:check` (drift; CI runs the check)
- `scripts/v2-head.sh [tests…]` — real-host suite against OpenCode `v2` HEAD
  (repoints node_modules symlinks; `bun install` restores them)
- `es <status|runs|watch|approve|trust|waive|gates|factory|research|brainstorm|harvest|design|config|lsp|hooks|audit|scout|mcp|improve>`
- `es factory run --headless [--driver opencode] [--max-turns N] [--log-level quiet|info|debug] [--events jsonl] [--events-file <path>] [--turn-timeout S] [--cwd <dir>]` (SIGINT/SIGTERM cancel, exit 130; detached HEADs and other runs' seat worktrees refused; `docs/HEADLESS.md`)
- `es mcp` pins caller identity to the adapter environment (`ES_MCP_AGENT`, else legacy `ES_AGENT`): the per-call `agent` argument is ignored; without either the caller is `mcp` (no seat)
- The CLI grammar lives in core (`packages/core/src/util/args.ts`): `parseArgs`, `flag`, `Args`, `BOOLEAN_FLAGS` — the human-only policy reads the same grammar (argv parity, #97)
- One package list (`bun scripts/packages.ts [--release] [--tsconfig]`): the typecheck loop, `pack-smoke.sh`, `publish.yml` and `deps.ts` all read it; new packages declare `esRelease.order` and `BOUNDARIES` (#102)
- OpenCode slash commands: `/grill /factory /audit /scout /brainstorm /harvest /design /research /gates /status /lsp /hooks /config` plus `es-*` TUI palette commands (panels: `/es-factory`, `/es-lsp-panel`, `/es-hooks`, `/es-brainstorm`; `/es-close`).

## Contract invariants (do not break)
| Invariant | Where |
| :--- | :--- |
| Approvals are human-only; trust, waivers and resume stay terminal-only: passphrase confirmation (terminal echo-off, TUI masked dialog, or loopback browser input per ADR 0002) unlocks the sealed Ed25519 human key (signed, hash-bound) and every surface signs approvals in-process — the TUI with channel `tui`, the browser through the loopback-only fleet endpoints with channel `web`; the approve/trust/resume RPCs no longer exist; agents may request, never grant | `approval/`, `gates/waivers.ts` |
| Control files are deny-write for all agents: `.factory/{gates.json,config.json,frontier.json,waivers,approvals,runtime}`, the evidence (`.factory/research/{sources,coverage.json,dossier.json,brief.pcrb.json}`, `.factory/claims/`), `.git/config` and git hooks. The pinned ones (gates, config, frontier, approvals, waivers) are also hash-checked at every gate run; cached sources are engine-sealed (HMAC) and content-addressed | `trust/control.ts` |
| Per-seat path scopes: manager writes factory docs, programmer writes its worktree, QA and the auditor pair write nothing, research alpha/beta write only their own notes (`.factory/research/alpha.md` / `beta.md`) and only the factory writes `research/REPORT.md`, brainstorm/harvest/design/scout write only their `.factory/<x>/notes/`; research, scout and auditor seats are `web: "cached"` (host websearch/webfetch denied, web facts only through the cached `es_research_*` tools) and run `--unshare-net` sandboxed, while user agents keep host web tools | `trust/policy.ts`, `agents/registry.ts` |
| Factory seats launch seats in the foreground only: `subagent` with `background: true` from any seat is refused, and so is launching a seat that is still running; seat state and last activity are recorded in `.factory/runtime/seats.json` (advisory) | `opencode/src/policy.ts`, `opencode/src/seats.ts` |
| Code audits block: an opened phase audit holds `passPhase` (a missing one too with `audit.phase: required`, set via `es config set`), any other open or failed audit refuses the next stage transition; every finding is witnessed against the file on disk; only a human dismisses one | `factory/machine.ts`, `codeaudit/` |
| Scout verdicts are computed by core: `adopt` survives only for a verified, whitelisted, permissive license | `scout/verdict.ts` |
| Gate command sets are trust-pinned by hash; untrusted commands never run | `trust/store.ts` |
| `.factory/STOP` halts seats and `es_*` tools; the run's spend ceiling is mandatory | `factory/machine.ts` |
| Engine-owned run state is sidecar-signed (HMAC under the masked engine key): reads refuse a missing/forged seal; only a human re-signs reviewed files (`es reseal --sign`, terminal passphrase; no agent path) | `trust/sidecar.ts`, `factory/machine.ts` |
| The factory never pushes to the base branch; release opens a draft PR a human merges | `factory/machine.ts`, `pr.ts` |
| Every write to `.factory/` runtime state is atomic + lock-protected | `util/fs.ts` |
| Generated docs/schemas must match the source of truth (CI drift check) | `scripts/docs.ts` |

## Workflow rules
- Run `bun run check` and `bun run docs:check` after touching schemas, prompts,
  registry or capability rows. Prompt changes require the assets snapshot
  (`bun test -u packages/core/test/assets.test.ts`) and a version bump.
- Stage explicit paths; never `git add -A`. Commit per milestone.
- Push only `rewrite` during development; never push or merge to `main`
  without asking. The 1.0 cutover (tag legacy, reviewed merge, npm publish via
  OIDC) is a separate, human-approved step.
- After any push, check every workflow (`gh run list`) — not just the obvious one.
