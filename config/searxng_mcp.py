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


def handle_json_rpc(line: str):
    """Minimal JSON-RPC 2.0 loop for MCP protocol."""
    try:
        msg = json.loads(line)
    except Exception:
        return

    msg_id = msg.get("id")
    method = msg.get("method")

    if method == "initialize":
        response = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "searxng-mcp",
                    "version": "1.0.0"
                }
            }
        }
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

    elif method == "tools/list":
        response = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "tools": [
                    {
                        "name": "searxng_search",
                        "description": "Execute an unbiased multi-engine metasearch via SearXNG.",
                        "inputSchema": {
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
                        }
                    }
                ]
            }
        }
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

    elif method == "tools/call":
        params = msg.get("params", {})
        tool_name = params.get("name")
        args = params.get("arguments", {})

        if tool_name == "searxng_search":
            query = args.get("query", "")
            cat = args.get("categories", "general")
            limit = args.get("max_results", 10)
            res = search_searxng(query, categories=cat, max_results=limit)
            response = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(res, indent=2)
                        }
                    ]
                }
            }
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()


def main():
    for line in sys.stdin:
        if line.strip():
            handle_json_rpc(line.strip())

if __name__ == "__main__":
    main()
