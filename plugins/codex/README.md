# IUMBTEMS for Codex CLI

Codex uses Skills (AgentSkills.io standard), not legacy `~/.codex/prompts/*.md`
(`/prompts:<name>` is deprecated). Explicit `$skill` / `/skills`, implicit via
`description`.

## Repo-local use (no install)

Codex auto-discovers `.agents/skills/*` from CWD up to repo root.
This repo ships generated mirrors there (see `scripts/build_adapters.py`):

```
.agents/skills/{grilling,research_cache,epistemic_search,swarm_config,code_audit,oss_scout,brainstorming,darkharvest,factory}/SKILL.md
```

Invoke: `$brainstorming Where do we go from here?` or let Codex pick
implicitly on speculative prompts.

## Plugin distribution

`plugins/codex/` is the distributable skill pack:

```
plugins/codex/
├── skills/<skill>/SKILL.md   # generated from canonical skills/
├── openai.yaml               # plugin appearance + component index
├── config.toml.snippet       # [mcp_servers.*] + [[skills.config]]
└── AGENTS.md.snippet         # paste into repo AGENTS.md for rule injection
```

Publish as a Codex marketplace plugin (cf. `~/.codex/plugins/cache/...`
+ `~/.codex/config.toml` marketplace blocks), or copy
`plugins/codex/skills/*` into any repo's `.agents/skills/`.

MCP: see `config.toml.snippet` (`codex mcp add ...`, `codex mcp login`).
Secrets via env: `BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`,
`FIRECRAWL_API_URL`, `SEARXNG_URL`, or `bearer_token_env_var` for HTTP MCP.
