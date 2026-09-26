# IUMBTEMS for Gemini CLI

Install from GitHub or local path:

```bash
gemini extensions install https://github.com/Heretek-AI/IUMBTEMS --path plugins/gemini
# local dev:
gemini extensions link /path/to/IUMBTEMS/plugins/gemini
gemini extensions list
/commands list
```

Contents: `gemini-extension.json` (manifest + MCP servers), `GEMINI.md`
(context loader), `commands/*.toml` (`/swarm`, `/grill`, `/audit`,
`/scout`, `/brainstorming`, `/swarm-config`), `hooks/hooks.json`,
`skills/` (generated copies of canonical `skills/` — run
`scripts/build_adapters.py`). Secrets via env:
`BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL`,
`SEARXNG_URL`. Zero-key DuckDuckGo fallback needs no keys.
