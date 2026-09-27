#!/usr/bin/env python3
"""
Intelligent MCP Server Launcher & Epistemic Fallback Proxy for IUMBTEMS.
Safely detects API keys and endpoints:
- If keys are present (via env or userConfig): launches the official MCP server.
- If keys are absent: smoothly provides a zero-key JSON-RPC fallback MCP server
  backed by DuckDuckGo Lite search and content-addressed SHA256 caching.
Prevents startup crashes and missing environment variable errors in Claude Code.
"""

import json
import os
import shutil
import sys
from typing import Any, Dict, List, Optional

# Add parent dir to path for imports
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)


def get_config_val(key: str, default: str = "") -> str:
    """Retrieve config from env, userConfig, or defaults."""
    env_val = os.environ.get(key)
    if env_val:
        return env_val
    user_cfg_val = os.environ.get(f"CLAUDE_PLUGIN_OPTION_{key.upper()}")
    if user_cfg_val:
        return user_cfg_val
    return default


def _build_brave_tools() -> list:
    from runner.mcp_protocol import ToolSpec
    from skills.epistemic_search.scripts.search import search_duckduckgo

    def handle_brave_search(args: Dict[str, Any]) -> str:
        results = search_duckduckgo(
            query=args.get("query", ""), max_results=args.get("count", 10)
        )
        return json.dumps(results, indent=2)

    return [
        ToolSpec(
            name="brave_web_search",
            description="Web search with DuckDuckGo fallback (zero API key required). Returns verifiable search results with titles, URLs, and snippets.",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query terms"},
                    "count": {"type": "number", "description": "Number of results (1-20)", "default": 10},
                },
                "required": ["query"],
            },
            handler=handle_brave_search,
            aliases=("search",),
        )
    ]


def _build_firecrawl_tools() -> list:
    from runner.mcp_protocol import ToolSpec
    from skills.epistemic_search.scripts.fetch import fetch_and_cache

    def handle_firecrawl_scrape(args: Dict[str, Any]) -> str:
        return fetch_and_cache(url=args.get("url", ""))

    return [
        ToolSpec(
            name="firecrawl_scrape",
            description="Scrape and extract clean markdown with automatic content-addressed SHA-256 caching into .research/sources/.",
            input_schema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to scrape and cache"},
                },
                "required": ["url"],
            },
            handler=handle_firecrawl_scrape,
            aliases=("scrape", "fetch"),
        )
    ]


def run_zero_key_mcp_server(service: str):
    """Run lightweight JSON-RPC MCP server handling search and fetch without API keys."""
    from runner.mcp_protocol import StdioJsonRpcServer

    if service == "brave-search":
        tools = _build_brave_tools()
    elif service == "firecrawl":
        tools = _build_firecrawl_tools()
    else:
        tools = []

    server = StdioJsonRpcServer(
        server_name=f"epistemic-{service}-fallback",
        version="0.2.1",
        tools=tools,
        log_prefix="[mcp-launcher]",
    )
    server.serve_forever()


def _launch_brave(npx_bin: Optional[str]) -> None:
    api_key = get_config_val("BRAVE_SEARCH_API_KEY")
    if api_key and npx_bin:
        os.environ["BRAVE_SEARCH_API_KEY"] = api_key
        os.execvp(npx_bin, [npx_bin, "-y", "@modelcontextprotocol/server-brave-search"])
    else:
        run_zero_key_mcp_server("brave-search")


def _launch_firecrawl(npx_bin: Optional[str]) -> None:
    api_key = get_config_val("FIRECRAWL_API_KEY")
    api_url = get_config_val("FIRECRAWL_API_URL", "https://api.firecrawl.dev")
    if api_key and npx_bin:
        os.environ["FIRECRAWL_API_KEY"] = api_key
        os.environ["FIRECRAWL_API_URL"] = api_url
        os.execvp(npx_bin, [npx_bin, "-y", "firecrawl-mcp"])
    else:
        run_zero_key_mcp_server("firecrawl")


def _launch_searxng() -> None:
    searxng_url = get_config_val("SEARXNG_URL", "http://localhost:8080")
    searxng_script = os.path.join(SCRIPT_DIR, "searxng_mcp.py")
    if os.path.exists(searxng_script):
        os.environ["SEARXNG_URL"] = searxng_url
        os.execvp("python3", ["python3", searxng_script])
    else:
        run_zero_key_mcp_server("searxng")


def main():
    service = sys.argv[1] if len(sys.argv) > 1 else "brave-search"
    npx_bin = shutil.which("npx")

    if service == "brave-search":
        _launch_brave(npx_bin)
    elif service == "firecrawl":
        _launch_firecrawl(npx_bin)
    elif service == "searxng":
        _launch_searxng()
    else:
        sys.stderr.write(f"Unknown service: {service}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
