# Capability matrix

What each harness actually enforces, declared once in `packages/core/src/capabilities.ts`.
ENFORCED rows name the test or spike that proves them; ADVISORY rows are best-effort and
labelled as such in the hook inspector; UNSUPPORTED rows are declared gaps (the Claude, Pi
and Antigravity adapters ship in 1.1–1.3). Generated: do not edit by hand.

## opencode

| capability | support | proof | detail |
| --- | --- | --- | --- |
| agents | ENFORCED | `packages/opencode/test/plugin.test.ts` | Registered by agent.transform with wildcard-deny scoping; never touches built-ins or defaults. |
| skills | ENFORCED | `spikes/m0/RESULTS.md` | One shared SKILL.md tree registered at runtime; per-agent visibility via skill deny rules. |
| tools | ENFORCED | `packages/opencode/test/plugin.test.ts` | es_* tools registered direct (codemode:false) with a permission action per tool; seat-scoped. |
| permissions | ENFORCED | `packages/opencode/test/plugin.test.ts` | permission.evaluate + tool.execute.before enforce the write/read/shell policy; control files denied. |
| hooks | ENFORCED | `packages/opencode/test/hooks.test.ts` | Claude hook schema bridged in-process; Stop is emulated after the turn (advisory for plain chat). |
| question | ENFORCED | `spikes/m0/RESULTS.md` | Session forms; agents cannot answer them (only humans can). |
| subagents | ENFORCED | `spikes/m0/RESULTS.md` | Depth 1; hidden subagents are unlisted but invocable by ID; background fan-out supported. |
| compaction | ENFORCED | `spikes/m0/RESULTS.md` | Session compaction injects the compact factory-state block for factory seats. |
| websearch | ENFORCED | `packages/opencode/test/research.test.ts` | The configured provider registers as the host websearch; results are cached and citable. |
| lsp | ENFORCED | `packages/opencode/test/lsp.test.ts` | The lsp config key is read and served by our own manager (v2 accepts but does not run it). |
| panels | ENFORCED | `packages/opencode/test/tui.test.ts` | Four session.panel dashboards (factory, LSP, hooks, brainstorm) opened via ui.panel.open. |
| research | ENFORCED | `packages/opencode/test/research.test.ts` | Cache, quote verifier, auditor, providers and the websearch bridge. |
| brainstorm | ENFORCED | `packages/opencode/test/brainstorm.test.ts` | Lens fan-out, record/score/complete tools, dedupe, rubric, shortlist with a forced outlier. |
| harvest | ENFORCED | `packages/opencode/test/harvest.test.ts` | Fail-closed SPDX detection, provenance profiles, policy-enforced matrix, clean-room specs. |
| design | ENFORCED | `packages/opencode/test/design.test.ts` | Queereye interview, DTCG tokens, contrast gate, generated guide and drift check. |

## claude

| capability | support | proof | detail |
| --- | --- | --- | --- |
| agents | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| skills | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| tools | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| permissions | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| hooks | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| question | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| subagents | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| compaction | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| websearch | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| lsp | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| panels | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| research | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| brainstorm | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| harvest | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| design | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |

## pi

| capability | support | proof | detail |
| --- | --- | --- | --- |
| agents | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| skills | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| tools | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| permissions | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| hooks | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| question | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| subagents | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| compaction | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| websearch | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| lsp | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| panels | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| research | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| brainstorm | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| harvest | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| design | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |

## antigravity

| capability | support | proof | detail |
| --- | --- | --- | --- |
| agents | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| skills | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| tools | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| permissions | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| hooks | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| question | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| subagents | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| compaction | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| websearch | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| lsp | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| panels | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| research | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| brainstorm | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| harvest | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| design | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |

## Hook bridge detail

| harness | event | support |
| --- | --- | --- |
| claude | PreToolUse | ENFORCED |
| claude | PostToolUse | ENFORCED |
| claude | PostToolUseFailure | ENFORCED |
| claude | UserPromptSubmit | ENFORCED |
| claude | SessionStart | ENFORCED |
| claude | PermissionRequest | ENFORCED |
| claude | Stop | ENFORCED |
| claude | x-es.ShellPreExec | UNSUPPORTED |
| opencode | PreToolUse | ENFORCED |
| opencode | PostToolUse | ENFORCED |
| opencode | PostToolUseFailure | ENFORCED |
| opencode | UserPromptSubmit | ENFORCED |
| opencode | SessionStart | ENFORCED |
| opencode | PermissionRequest | ENFORCED |
| opencode | Stop | ADVISORY |
| opencode | x-es.ShellPreExec | ENFORCED |
| pi | PreToolUse | ENFORCED |
| pi | PostToolUse | ENFORCED |
| pi | PostToolUseFailure | ENFORCED |
| pi | UserPromptSubmit | ADVISORY |
| pi | SessionStart | ENFORCED |
| pi | PermissionRequest | UNSUPPORTED |
| pi | Stop | ENFORCED |
| pi | x-es.ShellPreExec | ENFORCED |
| antigravity | PreToolUse | ENFORCED |
| antigravity | PostToolUse | ADVISORY |
| antigravity | PostToolUseFailure | ADVISORY |
| antigravity | UserPromptSubmit | ADVISORY |
| antigravity | SessionStart | UNSUPPORTED |
| antigravity | PermissionRequest | UNSUPPORTED |
| antigravity | Stop | ENFORCED |
| antigravity | x-es.ShellPreExec | UNSUPPORTED |
