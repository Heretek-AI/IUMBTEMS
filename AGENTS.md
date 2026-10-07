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
- `packages/core/src/capabilities.ts` — the capability matrix. ENFORCED rows
  must name a proof (test file or spike record) that exists; `bun run docs:check`
  and `capabilities.test.ts` fail otherwise.
- GENERATED — never hand-edit: `schemas/*.schema.json`, `docs/SCHEMAS.md`,
  `docs/CAPABILITIES.md`, `docs/CONFIG.md`. Edit the Zod schema / capability
  table, then run `bun run docs:gen`.
- Hand-maintained: `README.md`, `AGENTS.md`, `SYSTEM_ARCHITECTURE.md`, `docs/DOGFOOD.md`, `spikes/*/RESULTS.md`, `.github/**`.

## Commands
- `bun install` · `bun run check` (biome + tsc + all tests) · `bun run test`
- `bun run docs:gen` / `bun run docs:check` (drift; CI runs the check)
- `scripts/v2-head.sh [tests…]` — real-host suite against OpenCode `v2` HEAD
  (repoints node_modules symlinks; `bun install` restores them)
- `es <status|approve|trust|waive|gates|factory|research|brainstorm|harvest|design|config|lsp|hooks|audit|scout|mcp>`
- OpenCode slash commands: `/grill /factory /audit /scout /brainstorm /harvest /design /research /gates /status /lsp /hooks /config` plus `es-*` TUI palette commands.

## Contract invariants (do not break)
| Invariant | Where |
| :--- | :--- |
| Approvals and waivers are human-only (TUI/CLI dialog, signed, hash-bound); agents may request, never grant | `approval/`, `gates/waivers.ts` |
| Control files are deny-write for all agents: `.factory/{gates.json,config.json,frontier.json,waivers,approvals,runtime}`, the evidence (`.factory/research/{sources,coverage.json,dossier.json,brief.pcrb.json}`, `.factory/claims/`), `.git/config` and git hooks. The pinned ones (gates, config, frontier, approvals, waivers) are also hash-checked at every gate run; cached sources are self-verifying (content-addressed) | `trust/control.ts` |
| Per-seat path scopes: manager writes factory docs, programmer writes its worktree, QA and the auditor pair write nothing, brainstorm/harvest/design/scout write only their `.factory/<x>/notes/`; research, scout and auditor seats get web facts only through the cached `es_research_*` tools (registry `web: "cached"`) | `trust/policy.ts`, `agents/registry.ts` |
| Code audits block: a phase audit holds `passPhase`, any other open or failed audit refuses the next stage transition; every finding is witnessed against the file on disk; only a human dismisses one | `factory/machine.ts`, `codeaudit/` |
| Scout verdicts are computed by core: `adopt` survives only for a verified, whitelisted, permissive license | `scout/verdict.ts` |
| Gate command sets are trust-pinned by hash; untrusted commands never run | `trust/store.ts` |
| `.factory/STOP` halts seats and `es_*` tools; the run's spend ceiling is mandatory | `factory/machine.ts` |
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
