# AGENTS.md — IUMBTEMS contributor guide

## Evidence first
Every factual claim carries a tag: `[VERIFIED: <sha256>]` (verbatim quote in
`.research/sources/<hash>.md`), `[INFERRED: <parents>]`, `[HYPOTHESIS: <test>]`,
or `[NEGATIVE_KNOWLEDGE: <query>]`. Never present parametric recall as verified.

## Naming
- **IUMBTEMS** is the project/brand; **Epistemic Swarm** is the product/technical
  name (npm `@heretek-ai/epistemic-swarm`, Claude plugin `epistemic-swarm`). Keep
  user-facing docs IUMBTEMS-led and use "Epistemic Swarm" for the package/plugin.

## Canonical surfaces (single source of truth)
- `skills/*/SKILL.md` + `prompts/*.md` — canonical prose and specs.
- Hand-maintained (NOT generated): `README.md`, `MARKETPLACE.md`, `AGENTS.md`,
  `docs/*.md`, `.omp/*`, `.claude/*`, `plugins/*/README.md`, and the OpenCode
  plugin source `plugins/opencode/index.js`.
- `python3 runner/mcp_server.py` — canonical programmatic surface (17 `iumbtems_*`
  tools: `config`, `swarm_research`, `code_audit`, `oss_scout`, `brainstorm`,
  `darkharvest`, `factory`, `verify_quote`, `socratic_frontier`, `export_brief`,
  `verify_brief`, `reindex_claims`, `report_retraction`, `check_staleness`,
  `set_domain_pack`, `doctor`, `test`).
- GENERATED — never hand-edit: `plugins/{antigravity,gemini,codex}/skills/**`,
  `.agents/skills/**`, and the modular copies under
  `plugins/{research-cache,socratic-grilling,darkharvest,factory}/skills/**`.
  Edit the canonical skill, then run `python3 scripts/build_adapters.py`.

## Commands
- `iumbtems run|audit|scout|brainstorm|darkharvest|grill|config|doctor|test`
- `iumbtems adapters|install|marketplace|help` — regenerate adapter stubs, install
  the Claude Code overlay, print the marketplace catalog, print usage.
- `iumbtems factory <init|phase-add|qa-record|expansion|stop|gate>` — factory
  run-state helper (state in `.factory/`, output in `.roadmap/`, evidence in
  `.research/`). Run-shaping flags: `--resume` (continue a session), `--dry-run`
  (validate without spawning).
- OpenCode slash commands: `/swarm /grill /swarm-config /audit /scout
  /brainstorming /darkharvest /factory /domainexpansion`.

## Skills quick map
- `grilling` — Socratic assumption-inversion, decision frontier.
- `brainstorming` — divergent ideation (never bug fixes); scaffold via
  `skills/brainstorming/scripts/brainstorm.py`.
- `oss_scout` — library discovery, license red-team, clean-room blueprints.
- `darkharvest` — product competitor teardown; helper
  `skills/darkharvest/scripts/harvest.py`. Permissive-only vendoring;
  GPL/AGPL spec-rebuild only; workflows clonable, assets never.
- `factory` — Manager loop roles/gates/QA bounds; helper
  `skills/factory/scripts/factory.py` (3 QA failures escalate; expansion capped,
  STOP-file kill).
- `research_cache` — content-addressed SHA-256 source cache + quote verification
  (`hasher.py`).
- `epistemic_search` — zero-key DuckDuckGo search, fetch, and cache-through
  (`search.py`, `webcache.py`).
- `swarm_config` — inspect/tune/persist research parameters
  (`skills/swarm_config/configure.py`).
- `code_audit` — structural architecture mapping + vulnerability red-teaming.

## Contract invariants (do not break; detail lives in `docs/SYSTEM_ARCHITECTURE.md`)

| Invariant | Detail |
| :--- | :--- |
| Manifests are per mode (`manifest.json` for research, `manifest.<mode>.json` otherwise) | §6.2.2 |
| Manifest writes use unique temp names + `fcntl` lock (`.research/.manifest.lock`); readers use `find_any_manifest` | §6.2.2 |
| Role dossier contract: agents get the **exact** dossier path; completion is **derived from files on disk** (`reconcile_scope_status`) | §6.2.3 |
| Loader tolerates bounded mode aliases + manifest `outputs`, normalizing to the canonical name | §6.2.3 |
| Grounding is observable (`.research/retrieval.jsonl` + `retrieval:` banner); scoring is per mode; only `source_hash` + `verbatim_quote` claims count toward Verified | §6.3 |
| Darkharvest license cross-check is a safety control (`WARNING_LICENSE_CONFLICT`); `self_reported_*` fields are never counted | §6.4 |
| Contracts are generated (`runner/schemas.py` → `schemas/`); validation is warn-on-load | §6.5 |
| Agent runtime is host-native; spawned agents get matching OS `cwd` and `PWD`; `opencode run` passes `--auto` | §6.1–6.2 |
| Config deep-merges `agents` per role; legacy `["claude", "-p"]` pins migrate to `null` unless `backend` is `"claude"` | §6.6 |
| Preflight auto-runs at every swarm start (`iumbtems_doctor`); mode-aware fail-fast halts before spawning (exit 3) | §6.5 |
| Frontier is tool-drivable (`--add-node/--settle/--export`); frontier writes are atomic + locked | §5, §6.5 |
| Run-scoped layout is opt-in (`IUMBTEMS_RUN_SCOPED=1`); default is flat | §6.5 |
| `factory` writes `phase.json` (never `GOAL.md`/`dossier.json`, refused unless `--force`); `gate open|settle|approve|waive|escalate|count` | §10 |

## Workflow rules
- Writes go only to `.research/`, `.factory/` (runtime state), `.roadmap/`
  (phase output). Never auto-install dependencies.
- After touching `skills/*`, `package.json` (pi/omp blocks), or OpenCode plugin
  surface: run `python3 scripts/build_adapters.py --check` and
  `python3 -m unittest discover -s runner/tests`. Both must be green.
- After touching `runner/schemas.py`: run `python3 scripts/gen_schemas.py`
  (regenerates `schemas/*.schema.json`); `--check` must be green.
- Docs changes: `python3 scripts/check_docs.py` must resolve every repo-relative
  reference.
- OpenCode V2 is the first-class target: agent profiles + commands live in
  `config/opencode-snippet.json` and `plugins/opencode/index.js`
  (`OPENCODE_COMMANDS`, `commandCatalog()`); commands may pin `agent:` and
  `subagent:` (`subtask:` legacy alias) per https://opencode.ai/v2/docs/commands/.
- The plugin registers through the V2 domains at setup: `tool.transform` and
  `command.transform` (catalog), plus `agent.transform` (the snippet's role
  profiles, incl. manager/programmer/qa-a/qa-b) and `skill.transform` (bundled
  `skills/*/SKILL.md`). This removes the config-snippet install dependency —
  without it a `/factory` run executed as the generic `build` agent and the
  agent hunted the filesystem for its own skill prose. Commands that pin an
  agent also call `session.switchAgent` (best-effort, shape-tolerant) so the
  pinned role is actually active.
- V2 `AgentEditor` has NO `add()` — only `list/get/default/update/remove`, and
  `update(id, mutate)` upserts (seeded from `Agent.Info.default(id)`; the
  first-party `opencode.config.agent` uses the same path). The plugin registers
  profiles with `update`; calling `add` made opencode v2.0.18 disable the whole
  plugin (`disabled plugin after transform failure`, state=agent). The shipped
  snippet is V2-shaped: `agents` (plural), `skills` as a list, `mcp.servers`.
- Dual QA gates the loop: diverged `qa-a` (functional) and `qa-b`
  (adversarial) seats, manager tiebreak, 3 failures escalate. Waivers carry
  conditions. When a fix's precondition changes, re-verify its blast radius
  (see #7/#8).
- You drive the installed package, not the worktree: fixes authored here take
  effect only after release + reinstall.

## Releases
- Bump the **four enforced manifests** in lockstep — `package.json`,
  `package-lock.json`, `.claude-plugin/plugin.json`, and
  `plugins/antigravity/plugin.json` (0.7.5 shipped a stale plugin manifest and
  v0.7.18 missed the AntiGravity manifest, failing `Validate All Harnesses` +
  `Publish to npm` twice). Then commit, push to `main`, then
  `gh release create vX.Y.Z`. The `Publish to npm` workflow (OIDC trusted
  publishing) runs on release-published. Verify with
  `curl https://registry.npmjs.org/@heretek-ai%2Fepistemic-swarm`
  (allow propagation time).
- **After every push to `main` or release, check *all* workflows, not just the
  publisher:** `gh run list --limit 10` and inspect `Validate All Harnesses`,
  `Validate Claude Code Marketplace`, `Plugin Evals`, `CodeQL`, and
  `Publish to npm`. A green `Publish to npm` alone hid real failures for several
  releases (a committed symlink under `skills/` broke `plugin validate --strict`,
  and an OpenCode tool-parity gap went unnoticed) — the release is not done until
  every workflow is green.
