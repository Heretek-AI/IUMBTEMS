#!/usr/bin/env python3
"""
Antigravity MCP Server Launcher & Epistemic Fallback Proxy.

Binds Antigravity's MCP server declarations to:
- runner/mcp_server.py (canonical 17 iumbtems_* tools)
- config/mcp_launcher.py (brave-search, firecrawl, searxng with zero-key fallback)
"""

import os
import sys
from pathlib import Path
import runpy

SCRIPT_DIR = Path(__file__).resolve().parent

def find_project_root() -> Path:
    candidates = []
    if "IUMBTEMS_WORKSPACE" in os.environ:
        candidates.append(Path(os.environ["IUMBTEMS_WORKSPACE"]).resolve())
    if "IUMBTEMS_ROOT" in os.environ:
        candidates.append(Path(os.environ["IUMBTEMS_ROOT"]).resolve())

    curr = Path.cwd().resolve()
    candidates.extend([curr] + list(curr.parents))

    for c in candidates:
        if (c / "runner" / "mcp_server.py").is_file():
            return c
    return curr

def main():
    service = sys.argv[1] if len(sys.argv) > 1 else "iumbtems"
    root = find_project_root()

    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    if service == "iumbtems":
        server_script = root / "runner" / "mcp_server.py"
        if server_script.is_file():
            # Run runner/mcp_server.py directly in this process
            sys.argv = [str(server_script)]
            runpy.run_path(str(server_script), run_name="__main__")
        else:
            sys.stderr.write(f"IUMBTEMS mcp_server.py not found under project root: {root}\n")
            sys.exit(1)
    else:
        launcher = root / "config" / "mcp_launcher.py"
        if launcher.is_file():
            sys.argv = [str(launcher), service]
            runpy.run_path(str(launcher), run_name="__main__")
        else:
            sys.stderr.write(f"IUMBTEMS config/mcp_launcher.py not found under project root: {root}\n")
            sys.exit(1)

if __name__ == "__main__":
    main()
