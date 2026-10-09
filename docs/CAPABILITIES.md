# Capability matrix

What each harness actually enforces, declared once in `packages/core/src/capabilities.ts`.
ENFORCED rows name the test or spike that proves them; ADVISORY rows are best-effort and
labelled as such in the hook inspector; UNSUPPORTED rows are declared gaps (the Claude, Pi
and Antigravity adapters ship in 1.1–1.3). Generated: do not edit by hand.

## opencode

| capability | support | proof | detail |
| --- | --- | --- | --- |
| agents | ENFORCED | `packages/opencode/test/plugin.test.ts` | Registered by agent.transform with wildcard-deny scoping; never touches built-ins or defaults. |
| skills | ENFORCED | `packages/opencode/test/plugin.test.ts` | One shared SKILL.md tree registered at runtime; per-agent visibility via skill deny rules. |
| tools | ENFORCED | `packages/opencode/test/plugin.test.ts` | es_* tools registered direct (codemode:false) with a permission action per tool; seat-scoped. |
| permissions | ENFORCED | `packages/opencode/test/scoping.test.ts` | permission.evaluate + tool.execute.before enforce the write/read/shell policy; control files (incl. the engine-sealed evidence cache) denied; research seats get no host websearch/webfetch. Every agent shell runs under bubblewrap by seat kind (cached-web seats offline); seats are refused without it and the user's agents fall back to the weaker argv-aware text policy. |
| hooks | ENFORCED | `packages/opencode/test/hooks.test.ts` | Claude hook schema bridged in-process; Stop is emulated after the turn (advisory for plain chat). |
| question | ENFORCED | `packages/opencode/test/scoping.test.ts` | Session forms only humans can answer; primaries may ask, autonomous subagent seats may not. |
| subagents | ENFORCED | `packages/opencode/test/scoping.test.ts` | Depth 1; hidden seats are unlisted but invocable by ID, and only from the seats allowed to spawn them. Factory seats are not offered Code Mode execute. |
| compaction | ENFORCED | `packages/opencode/test/plugin.test.ts` | Session compaction injects the compact factory-state block for factory seats. |
| websearch | ENFORCED | `packages/opencode/test/research.test.ts` | The configured provider registers as the host websearch; results are cached and citable. Research, scout and auditor seats are cached-only (es_research_search/fetch) under an offline (--unshare-net) sandbox; host web caching applies only in a project that already has .factory/, and the cache is engine-sealed (planted entries refused). |
| lsp | ENFORCED | `packages/opencode/test/lsp.test.ts` | The lsp config key is read and served by our own manager (v2 accepts but does not run it). |
| panels | ENFORCED | `packages/opencode/test/panels.test.ts` | Four session.panel dashboards (factory, LSP, hooks, brainstorm), rendered by OpenTUI and refreshed on server changes; Esc/q closes a panel, f toggles fullscreen. The factory dashboard leads with the run headline, seats and research progress; a prompt-footer indicator shows the stage and the running seat. |
| research | ENFORCED | `packages/core/test/research.test.ts` | Engine-sealed cache (#52), fragment-level quote verifier (every ellipsis fragment >= 12 chars; code excerpts one contiguous span of at most 60 lines), auditor, providers and the websearch bridge. Research-only runs complete through the deep-researcher (thesis/antithesis/synthesis at depth 1) at DONE. |
| brainstorm | ENFORCED | `packages/opencode/test/brainstorm.test.ts` | Lens fan-out, record/score/complete tools, dedupe, rubric, shortlist with a forced outlier. Runs are id-scoped (the human's /brainstorm is the default run); the grill and the factory run callable brainstorms at depth 1 and get the shortlist as JSON. |
| harvest | ENFORCED | `packages/opencode/test/harvest.test.ts` | Fail-closed SPDX detection, provenance profiles, policy-enforced matrix, clean-room specs. Runs are id-scoped (the human's /harvest is the default run); es_harvest_target gives the grill, factory, scout and harvester deterministic verdicts, and prior-art search is shared with brainstorm callers. |
| design | ENFORCED | `packages/opencode/test/design.test.ts` | Queereye interview, DTCG tokens, contrast gate, generated guide and drift check; phase-02 specs/webref/csf/tui renders and the phase-03 ledger bundle with its cite-gate receipt. |
| claims | ENFORCED | `packages/core/test/research.test.ts` | Witnessed claims and dossiers: the evidence cache, dossiers and the claim ledger are tool-only; planted cache entries are refused (engine seal) and every VERIFIED quote and code span is re-checked against the bytes on disk. |
| audit | ENFORCED | `packages/opencode/test/fires.test.ts` | Code-audit pair: only auditor seats record verdicts; every finding is witnessed on disk (a hallucinated line is refused); quote fragments carry >= 12 chars each and a thesis pass needs a witnessed invariant; verdicts block (an opened phase audit holds the merge; audit.phase required also holds a missing one until it passes or a human dismisses it). |
| scout | ENFORCED | `packages/opencode/test/fires.test.ts` | OSS scout: cached-only web under an offline (--unshare-net) sandbox, fail-closed license verdicts computed by core (adopt only for verified permissive licenses), OSV advisories cited. |
| research-fires | ENFORCED | `packages/opencode/test/fires-research.test.ts` | Research fires: the whole research loop on the real host with loopback-only servers — grounded quotes survive the audit, failover records provenance, blocked never fails over, planted sources are refused, retractions degrade to STALE, renders snapshot. |

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
| claims | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| audit | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| scout | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |
| research-fires | UNSUPPORTED | — | The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1. |

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
| claims | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| audit | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| scout | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |
| research-fires | UNSUPPORTED | — | The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2. |

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
| claims | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| audit | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| scout | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |
| research-fires | UNSUPPORTED | — | The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3. |

## Hook bridge detail

| harness | event | support |
| --- | --- | --- |
| claude | PreToolUse | UNSUPPORTED |
| claude | PostToolUse | UNSUPPORTED |
| claude | PostToolUseFailure | UNSUPPORTED |
| claude | UserPromptSubmit | UNSUPPORTED |
| claude | SessionStart | UNSUPPORTED |
| claude | PermissionRequest | UNSUPPORTED |
| claude | Stop | UNSUPPORTED |
| claude | x-es.ShellPreExec | UNSUPPORTED |
| opencode | PreToolUse | ENFORCED |
| opencode | PostToolUse | ENFORCED |
| opencode | PostToolUseFailure | ENFORCED |
| opencode | UserPromptSubmit | ENFORCED |
| opencode | SessionStart | ENFORCED |
| opencode | PermissionRequest | ENFORCED |
| opencode | Stop | ADVISORY |
| opencode | x-es.ShellPreExec | ENFORCED |
| pi | PreToolUse | UNSUPPORTED |
| pi | PostToolUse | UNSUPPORTED |
| pi | PostToolUseFailure | UNSUPPORTED |
| pi | UserPromptSubmit | UNSUPPORTED |
| pi | SessionStart | UNSUPPORTED |
| pi | PermissionRequest | UNSUPPORTED |
| pi | Stop | UNSUPPORTED |
| pi | x-es.ShellPreExec | UNSUPPORTED |
| antigravity | PreToolUse | UNSUPPORTED |
| antigravity | PostToolUse | UNSUPPORTED |
| antigravity | PostToolUseFailure | UNSUPPORTED |
| antigravity | UserPromptSubmit | UNSUPPORTED |
| antigravity | SessionStart | UNSUPPORTED |
| antigravity | PermissionRequest | UNSUPPORTED |
| antigravity | Stop | UNSUPPORTED |
| antigravity | x-es.ShellPreExec | UNSUPPORTED |
