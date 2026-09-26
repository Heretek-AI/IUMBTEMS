#!/usr/bin/env python3
"""
Intelligent MCP Server Launcher & Epistemic Fallback Proxy for IUMBTEMS.
Safely detects API keys and endpoints:
- If keys are present (via env or userConfig): launches the official MCP server.
- If keys are absent: smoothly provides a zero-key JSON-RPC fallback MCP server
  backed by DuckDuckGo Lite search and content-addressed SHA256 caching.
Prevents startup crashes and missing environment variable errors in Claude Code.
"""

import sys
import os
import json
import subprocess
import shutil
from typing import Dict, Any, List

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
    # Also check user_config format
    user_cfg_val = os.environ.get(f"CLAUDE_PLUGIN_OPTION_{key.upper()}")
    if user_cfg_val:
        return user_cfg_val
    return default

def run_zero_key_mcp_server(service: str):
    """Run lightweight JSON-RPC MCP server handling search and fetch without API keys."""
    from skills.epistemic_search.scripts.search import search_duckduckgo
    from skills.epistemic_search.scripts.fetch import fetch_and_cache

    def send_response(response: Dict[str, Any]):
        out = json.dumps(response)
        sys.stdout.write(f"Content-Length: {len(out)}\r\n\r\n{out}")
        sys.stdout.flush()

    def send_json(response: Dict[str, Any]):
        # Direct newline JSON-RPC for stdio transports
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue

            # Check if line is Content-Length header or raw JSON
            if line.startswith("Content-Length:"):
                length = int(line.split(":")[1].strip())
                # Read blank line
                sys.stdin.readline()
                body = sys.stdin.read(length)
                req = json.loads(body)
                use_headers = True
            else:
                req = json.loads(line)
                use_headers = False

            req_id = req.get("id")
            method = req.get("method")
            params = req.get("params", {})

            if method == "initialize":
                res = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "serverInfo": {
                            "name": f"epistemic-{service}-fallback",
                            "version": "0.2.1"
                        },
                        "capabilities": {
                            "tools": {}
                        }
                    }
                }
            elif method == "tools/list":
                if service == "brave-search":
                    tools = [
                        {
                            "name": "brave_web_search",
                            "description": "Web search with DuckDuckGo fallback (zero API key required). Returns verifiable search results with titles, URLs, and snippets.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "query": {"type": "string", "description": "The search query terms"},
                                    "count": {"type": "number", "description": "Number of results (1-20)", "default": 10}
                                },
                                "required": ["query"]
                            }
                        }
                    ]
                elif service == "firecrawl":
                    tools = [
                        {
                            "name": "firecrawl_scrape",
                            "description": "Scrape and extract clean markdown with automatic content-addressed SHA-256 caching into .research/sources/.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "url": {"type": "string", "description": "URL to scrape and cache"}
                                },
                                "required": ["url"]
                            }
                        }
                    ]
                else:
                    tools = []

                res = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"tools": tools}
                }
            elif method == "tools/call":
                tool_name = params.get("name")
                args = params.get("arguments", {})

                if tool_name in ("brave_web_search", "search"):
                    q = args.get("query", "")
                    count = args.get("count", 10)
                    results = search_duckduckgo(query=q, max_results=count)
                    text_out = json.dumps(results, indent=2)
                    res = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "content": [{"type": "text", "text": text_out}]
                        }
                    }
                elif tool_name in ("firecrawl_scrape", "scrape", "fetch"):
                    target_url = args.get("url", "")
                    content = fetch_and_cache(url=target_url)
                    res = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "content": [{"type": "text", "text": content}]
                        }
                    }
                else:
                    res = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -32601, "message": f"Tool {tool_name} not found"}
                    }
            elif method == "notifications/initialized":
                continue
            else:
                res = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"Method {method} not handled"}
                }

            if use_headers:
                send_response(res)
            else:
                send_json(res)

        except Exception as e:
            sys.stderr.write(f"[mcp-launcher] Error handling request: {e}\n")
            break

def main():
    service = sys.argv[1] if len(sys.argv) > 1 else "brave-search"
    npx_bin = shutil.which("npx")

    if service == "brave-search":
        api_key = get_config_val("BRAVE_SEARCH_API_KEY")
        if api_key and npx_bin:
            os.environ["BRAVE_SEARCH_API_KEY"] = api_key
            os.execvp(npx_bin, [npx_bin, "-y", "@modelcontextprotocol/server-brave-search"])
        else:
            # Fall back to zero-key search proxy
            run_zero_key_mcp_server("brave-search")

    elif service == "firecrawl":
        api_key = get_config_val("FIRECRAWL_API_KEY")
        api_url = get_config_val("FIRECRAWL_API_URL", "https://api.firecrawl.dev")
        if api_key and npx_bin:
            os.environ["FIRECRAWL_API_KEY"] = api_key
            os.environ["FIRECRAWL_API_URL"] = api_url
            os.execvp(npx_bin, [npx_bin, "-y", "firecrawl-mcp"])
        else:
            # Fall back to zero-key readability fetcher + SHA-256 hasher
            run_zero_key_mcp_server("firecrawl")

    elif service == "searxng":
        searxng_url = get_config_val("SEARXNG_URL", "http://localhost:8080")
        searxng_script = os.path.join(SCRIPT_DIR, "searxng_mcp.py")
        if os.path.exists(searxng_script):
            os.environ["SEARXNG_URL"] = searxng_url
            os.execvp("python3", ["python3", searxng_script])
        else:
            run_zero_key_mcp_server("searxng")
    else:
        sys.stderr.write(f"Unknown service: {service}\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
