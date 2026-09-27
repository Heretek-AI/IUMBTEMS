# IUMBTEMS for AntiGravity

Native AntiGravity plugin (`agy`). Install from git or local path:

```bash
agy plugin install https://github.com/Heretek-AI/IUMBTEMS --path plugins/antigravity
# or local clone:
agy plugin install /path/to/IUMBTEMS/plugins/antigravity
agy plugin list
agy plugin validate /path/to/IUMBTEMS/plugins/antigravity
```

Layout follows the AntiGravity extensibility model:

```
plugins/antigravity/
├── plugin.json      # required manifest (name, description, skills, agents, rules)
├── mcp_config.json  # MCP servers (brave-search, firecrawl, searxng via config/mcp_launcher.py)
├── hooks.json       # pre/post tool hooks (WebSearch/WebFetch interception)
├── skills/          # generated copies of canonical skills/ (see scripts/build_adapters.py)
├── agents/          # subagent definitions (alpha-thesis, beta-antithesis, auditor, brainstormer)
└── rules/           # workspace rules (epistemic integrity invariant)
```

Skills auto-promote to slash commands (`/grilling`, `/brainstorming`, `/darkharvest`, `/factory`, ...).
Set optional secrets via workspace settings / env:
`BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL`, `SEARXNG_URL`.
Zero-key DuckDuckGo + readability fallback works with no keys.
