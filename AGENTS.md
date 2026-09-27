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
- `python3 runner/mcp_server.py` — canonical programmatic surface (15 `iumbtems_*`
  tools: `config`, `swarm_research`, `code_audit`, `oss_scout`, `brainstorm`,
  `darkharvest`, `factory`, `verify_quote`, `socratic_frontier`, `export_brief`,
  `verify_brief`, `reindex_claims`, `report_retraction`, `check_staleness`,
  `set_domain_pack`).
- GENERATED — never hand-edit: `plugins/{antigravity,gemini,codex}/skills/**`,
  `.agents/skills/**`, and the modular copies under
  `plugins/{research-cache,socratic-grilling,darkharvest,factory}/skills/**`.
  Edit the canonical skill, then run `python3 scripts/build_adapters.py`.

## Commands
- `iumbtems run|audit|scout|brainstorm|darkharvest|grill|config|doctor|test`
- `iumbtems adapters|install|marketplace|help` — regenerate adapter stubs, install
  the Claude Code overlay, print the marketplace catalog, print usage.
- `iumbtems factory <init|phase-add|qa-record|expansion|stop>` — factory
  run-state helper (state in `.factory/`, output in `.roadmap/`, evidence in
  `.research/`).
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

## Workflow rules
- Writes go only to `.research/`, `.factory/` (runtime state), `.roadmap/`
  (phase output). Never auto-install dependencies.
- After touching `skills/*`, `package.json` (pi/omp blocks), or OpenCode plugin
  surface: run `python3 scripts/build_adapters.py --check` and
  `python3 -m unittest discover -s runner/tests`. Both must be green.
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
- Agent runtime backend is host-native by default (`claude -p` on Claude Code,
  `opencode run` on OpenCode via `IUMBTEMS_HOST`). Override with
  `--backend {auto,claude,opencode}`, `IUMBTEMS_BACKEND_<ROLE>`,
  `IUMBTEMS_MODEL_<ROLE>`, or `.research/config.json` (`backend`,
  `agents.<role>.backend/model/opencode_agent`). The OpenCode plugin cannot
  intercept host webfetch/websearch (OpenCode V2's `tool.execute.before` hook
  enables argument sanitization/mutation but lacks tool abort/redirection capabilities
  analogous to Claude Code's PreToolUse) — accepted asymmetry; steering lives in
  command templates.
- Legacy config migration: pre-0.7.6 configs pinned
  `agents.<role>.backend = ["claude", "-p"]`, which out-ranked the host-native
  default and silently spawned Claude even on OpenCode. `load_config` now
  deep-merges `agents` per role and migrates that pin to `null` (unless the
  top-level `backend` is an explicit `"claude"`); `heal_config` persists it via
  the CLI and `iumbtems_config` surfaces.
- Spawned agents get both the OS `cwd` and `PWD` set to the project root: OpenCode
  resolves its project from `$PWD`, and `subprocess.run(cwd=...)` does NOT update
  `PWD`. A mismatch sends evidence into a different tree than the auditor reads.
  Override the directory with `IUMBTEMS_AGENT_CWD` (`project` | `package` | path).

## Releases
- Bump `package.json` (+ lockfile sync) **and `.claude-plugin/plugin.json`**
  (0.7.5 shipped with a stale plugin manifest — keep all three in lockstep),
  commit, push to `main`, then
  `gh release create vX.Y.Z`. The `Publish to npm` workflow (OIDC trusted
  publishing) runs on release-published. Verify with
  `curl https://registry.npmjs.org/@heretek-ai%2Fepistemic-swarm`
  (allow propagation time).
