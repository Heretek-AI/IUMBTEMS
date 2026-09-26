#!/usr/bin/env python3
"""
Lightweight MCP Server for SearXNG Metasearch.
Provides unbiased search results directly to Claude Code agents.
"""

import os
import sys
import json
import urllib.request
import urllib.parse
from typing import Dict, Any, List

# Add parent dir to path so the shared protocol module resolves when this
# script is launched directly as `python3 config/searxng_mcp.py`.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from runner.mcp_protocol import StdioJsonRpcServer, ToolSpec  # noqa: E402

SEARXNG_URL = os.environ.get("SEARXNG_URL", "http://localhost:8080")

def search_searxng(query: str, categories: str = "general", max_results: int = 10) -> List[Dict[str, Any]]:
    """Query SearXNG JSON endpoint."""
    params = {
        "q": query,
        "format": "json",
        "categories": categories,
        "language": "en"
    }
    url = f"{SEARXNG_URL.rstrip('/')}/search?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "EpistemicSwarm/1.0"})

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = data.get("results", [])[:max_results]
            return [
                {
                    "title": r.get("title", ""),
                    "url": r.get("url", ""),
                    "snippet": r.get("content", ""),
                    "engine": r.get("engine", "")
                }
                for r in results
            ]
    except Exception as e:
        return [{"error": f"Failed to query SearXNG at {SEARXNG_URL}: {str(e)}"}]


def build_server() -> StdioJsonRpcServer:
    def handle_searxng_search(args: Dict[str, Any]) -> str:
        res = search_searxng(
            query=args.get("query", ""),
            categories=args.get("categories", "general"),
            max_results=args.get("max_results", 10),
        )
        return json.dumps(res, indent=2)

    return StdioJsonRpcServer(
        server_name="searxng-mcp",
        version="1.0.0",
        tools=[
            ToolSpec(
                name="searxng_search",
                description="Execute an unbiased multi-engine metasearch via SearXNG.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "categories": {
                            "type": "string",
                            "description": "Categories (general, science, it)",
                            "default": "general"
                        },
                        "max_results": {"type": "integer", "default": 10}
                    },
                    "required": ["query"]
                },
                handler=handle_searxng_search,
            )
        ],
    )


def main():
    build_server().serve_forever()

if __name__ == "__main__":
    main()
