# M0 spike results

Run: 2026-10-06, branch `rewrite`. Host: published `@opencode/sdk@2.0.24` (in-process, no listener) driven by a scripted
OpenAI-compatible fake model (`fake-llm.ts`). Plugins load from disk through the `plugins` config key, the same path a user
install takes. Source references are to `review/opencode` at `4a0f273fa7` (v2.0.24).

Reproduce: `cd spikes/m0 && bun install && bun test` (16 host proofs in `m0.test.ts`, 1 TUI proof in `tui.test.ts`), then
`bunx tsc -p tsconfig.json` (probe plugins type-check against the published 2.0.24 types).

## Verdicts

| # | Assumption (plan) | Verdict | Evidence |
|---|---|---|---|
| A1 | `tool.execute.before` can block a plugin tool | **CONFIRMED** | `m0.test.ts` A1: Effect hook `Effect.fail(new Tool.Error)` → tool `executed:false`, error fed to the model, loop continues. [VERIFIED: core/src/plugin/hooks.ts:23 "Only tool execute.before may fail"] |
| A2 | …and host-native tools (read/edit/webfetch/websearch) | **CONFIRMED** | A2 blocks the built-in `read`. The old repo's "tool.execute.before gap" is stale. |
| A3 | (control) unblocked read works | CONFIRMED | A3 |
| A4 | Promise-API hook can block | **CONFIRMED (undocumented path)** | A4: a thrown `Tool.Error` becomes an Effect defect (`plugin/src/promise/adapter.ts:504`, `Effect.promise`) that the step runner still settles as a model-facing tool error. Docs only say "inspect or replace input". |
| A5/A6 | Tool failures reach the model | CONFIRMED | Effect `Tool.Error` (A5) and Promise throw (A6) are both fed back gracefully. |
| A7 | `permission.evaluate` can deny | **CONFIRMED** | A7: allow→deny with message; surfaced as `permission.rejected`. Explicit configured `deny` never reaches the hook (docs). |
| A8 | `agent.transform` wildcard-deny hides MCP tools and skills per agent | **CONFIRMED** | A8: `{action:"probe_*",resource:"*",effect:"deny"}` + allow `probe_alpha` leaves only `tools.probe.alpha` in the Code Mode catalog; skill deny removes `<id>es-hidden</id>` from `<available_skills>`; a plugin tool with `options.permission:"es_gate"` disappears from the tool list. [VERIFIED: core/src/tool.ts `whollyDisabled` (last matching rule with `resource:"*"`,`deny`); core/src/skill/instructions.ts:61] |
| A9 | Subagent depth is 1; hidden subagents | **CONFIRMED + refined** | A9: hidden subagent (`hidden:true`) is omitted from the `subagent` tool description but invocable by ID; a nested call fails with "Subagent depth limit reached (1)". Depth is configurable via `experimental.subagent_depth` [VERIFIED: core/src/tool/plugin/subagent.ts:129]. `background:true` exists for parallel fan-out. |
| A10 | `websearch.transform` | CONFIRMED | A10: plugin provider becomes the host `websearch` default. |
| A11 | Context injection | CONFIRMED | A11: `session.hook("context")` appends a system block. |
| A12 | `session.compaction` | CONFIRMED | A12: `compaction` hook sets `result`, no model request is made. |
| A13 | Commands via transform | CONFIRMED | A13: `command.transform` adds `/es-probe`; its executor runs plugin code. |
| A14 | Shell pre-exec hook | CONFIRMED | A14: `shell.create.before` rewrites the command. |
| A15 | Question tool | CONFIRMED | A15: `question` raises a session form; a client answers via `session.form.reply`. Agents cannot answer forms. |
| A16 | `lsp` key passthrough | **CONFIRMED, with a gap** | A16: `lsp` is accepted and returned by `GET /api/config`, but the plugin `ctx` has no config API. The LSP plugin must read `opencode.json(c)` itself (same discovery order) or take options. [VERIFIED: schema/src/config/lsp.ts; migrate-v1.mdx:415] |
| T1 | TUI panel API | **CONFIRMED (headless)** | `tui.test.ts`: TSX loads through the host's runtime Solid transform (`@opentui/solid/runtime-plugin-support`, as `tui/src/plugin/runtime-plugin-support.bun.ts`), registers a `session.panel` slot and a slash command that calls `ui.panel.open(name,{presentation:"fullscreen"})`, and renders with OpenTUI's test renderer. A real TUI-process load is covered by the M6 pty smoke test. |
| P1 | Pi `execute` signature | VERIFIED | `@earendil-works/pi-coding-agent@1.0.4` (the `@mariozechner` package is deprecated): `execute(toolCallId, params, signal, onUpdate, ctx)`; `tool_call` returns `{block, reason, terminate}`; a `tool_call` handler failure blocks (fail-safe); TypeBox schemas; `pi.registerMcpServer`. [VERIFIED: dist/core/extensions/types.d.ts:494,1054; source bd2ed1f7…] |
| G1 | `agy plugin validate` | VERIFIED | `agy` 1.3.0: `agy plugin validate <dir>` passes the legacy plugin (11 agents, 9 skills, 10 commands→skills, 4 MCP servers, 2 hooks). |
| G2 | "Antigravity `hooks.json` shape looks wrong" (plan item 1, [INFERRED]) | **REFUTED** | The embedded hooks contract (source 13167e22…) matches the legacy file: named hooks, grouped `PreToolUse`/`PostToolUse` with `matcher`, flat `PreInvocation`/`PostInvocation`/`Stop`. Antigravity also has a real `Stop` (`decision:"continue"`), `force_ask`, and `overwrite` arg rewriting. |

## Facts discovered (not in the plan)

1. **Host input repair runs before plugin hooks.** Built-in `execute.before` hooks (`plugin/tool-input-repair.ts`) strip unknown keys first, so plugin hooks see normalized input.
2. **Code Mode is the default.** Tools without `options.codemode:false` are listed in the `execute` tool's catalog rather than advertised directly; nested Code Mode calls still pass through `execute.before`. Factory tools use `codemode:false`.
3. **Tool permission actions.** `options.permission` gives a plugin tool its own permission action, so per-agent hiding works by action family (`es_*`).
4. **MCP connects lazily** when a location instance starts; catalog changes arrive mid-turn as user-role system notices.
5. **No session-scoped rules API for plugins.** The docs show `ctx.permission.rules(...)`, but the 2.0.24 plugin `PermissionDomain` is `Pick<PermissionApi,"list"|"get"|"reply">`. Per-seat path scoping therefore uses `permission.evaluate` plus `execute.before`, keyed by agent ID.
6. **Idle and usage events.** `session.idle`, `session.execution.succeeded`, `session.usage.recorded` (host usage for the spend ceiling) and `session.step.ended` are available for Stop emulation.
7. **Published packages.** `@opencode/sdk`, `@opencode/plugin`, `@opencode/core` and `@opencode/schema` 2.0.24 are on npm, so real-host tests pin them as dev dependencies and nightly CI swaps in v2 HEAD.

## Design decisions taken from M0

- **OpenCode adapter API: Promise (`@opencode/plugin`), no Effect in our code.** Every extension point the design needs is proven on the Promise API (A4/A6 show blocking and failures surface gracefully). This avoids coupling our runtime to the host's Effect instance version. Fallback: if a v2 release changes defect handling, the gate hook moves to the Effect API (`Tool.Error` typed failure, A1), which the spike keeps tested. The real-host test for the PreToolUse-deny matrix row catches either regression.
- **Tool input schemas:** JSON Schema or Standard Schema (Zod 4), both accepted by `Tool.ValueSchema`.
- **TUI ships TSX source** (`./tui` export), compiled by the host's runtime transform, so `solid-js`/`@opentui/*`/`@opencode/plugin/tui` resolve to the host's instances.
- **LSP config** is read from `opencode.json(c)` by the plugin (plus plugin options), because `ctx` exposes no config read.
