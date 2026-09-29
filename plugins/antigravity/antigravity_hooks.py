#!/usr/bin/env python3
"""
Antigravity Lifecycle Hook Interceptor & Epistemic Gate Bridge.

Binds Antigravity's lifecycle events (PreToolUse, PreInvocation, PostToolUse, Stop)
to IUMBTEMS's epistemic evidence verification pipeline.

Contract Invariants:
- Input is received as JSON on stdin (camelCase per Antigravity hook protojson).
- Output is emitted as JSON on stdout.
- Zero-failure tolerance: any unexpected internal error falls back safely without
  blocking the agent loop.
"""

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict


def _get_workspace_dir(payload: Dict[str, Any]) -> Path:
    workspaces = payload.get("workspacePaths", [])
    if workspaces:
        return Path(workspaces[0]).resolve()
    if "IUMBTEMS_WORKSPACE" in os.environ:
        return Path(os.environ["IUMBTEMS_WORKSPACE"]).resolve()
    if "IUMBTEMS_ROOT" in os.environ:
        return Path(os.environ["IUMBTEMS_ROOT"]).resolve()
    curr = Path.cwd().resolve()
    for p in [curr] + list(curr.parents):
        if (p / ".research").exists() or (p / ".git").exists():
            return p
    return curr


def _read_stdin_payload() -> Dict[str, Any]:
    try:
        content = sys.stdin.read()
        if not content.strip():
            return {}
        return json.loads(content)
    except Exception:
        return {}


def handle_pre_tool(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Intercept ungrounded search/fetch and redirect to epistemic cache tools."""
    tool_call = payload.get("toolCall", {})
    name = str(tool_call.get("name", "")).lower()

    if "search_web" in name or "websearch" in name:
        return {
            "decision": "deny",
            "reason": (
                "Intercepted by IUMBTEMS epistemic-swarm: Web searches must be "
                "verifiable. Use epistemic search (python3 skills/epistemic_search/scripts/search.py "
                '"<query>") or MCP tool brave_web_search for SHA-256 cached verification.'
            ),
        }

    if "read_url_content" in name or "webfetch" in name:
        return {
            "decision": "deny",
            "reason": (
                "Intercepted by IUMBTEMS epistemic-swarm: Web fetches must be "
                "content-addressed. Use epistemic fetch (python3 skills/epistemic_search/scripts/fetch.py "
                '"<url>") to cache sources into .research/sources/<sha256>.md.'
            ),
        }

    return {"decision": "allow"}


def handle_pre_invocation(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Inject ephemeral evidence tagging constraints before model reasoning."""
    return {
        "injectSteps": [
            {
                "ephemeralMessage": (
                    "[EPISTEMIC INTEGRITY] Every factual claim must carry "
                    "[VERIFIED: <sha256>] (verbatim quote in .research/sources/<hash>.md), "
                    "[INFERRED: <parents>], [HYPOTHESIS: <test>], or [NEGATIVE_KNOWLEDGE: <query>]. "
                    "Unverified parametric recall is strictly quarantined."
                )
            }
        ]
    }


def handle_post_tool(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Log tool completions and record negative knowledge on failures."""
    try:
        workspace_dir = _get_workspace_dir(payload)
        research_dir = workspace_dir / ".research"

        error = payload.get("error")
        if error and research_dir.exists():
            log_file = research_dir / "retrieval.jsonl"
            entry = {
                "stepIdx": payload.get("stepIdx"),
                "error": str(error),
                "status": "tool_failure",
            }
            with log_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
    except Exception:
        pass
    return {}


def handle_stop(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Prevent agent from terminating if an active swarm run has unverified claims."""
    try:
        workspace_dir = _get_workspace_dir(payload)
        research_dir = workspace_dir / ".research"

        # If a STOP signal file was placed by user or factory, respect it immediately
        factory_stop = (workspace_dir / ".factory" / "STOP")
        if factory_stop.exists():
            return {"decision": "allow"}

        # Check if living dossier retractions require human/agent re-review
        ledger_path = research_dir / "ledger" / "claim_status.json"
        if ledger_path.exists():
            try:
                ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
                stale_claims = [
                    c for c in ledger.get("claims", [])
                    if c.get("status") in ("STALE", "SUSPECT")
                ]
                if stale_claims:
                    return {
                        "decision": "continue",
                        "reason": (
                            f"Epistemic audit warning: {len(stale_claims)} claims are degraded "
                            "(STALE/SUSPECT) due to source retractions. Review before finishing."
                        ),
                    }
            except Exception:
                pass
    except Exception:
        pass
    return {"decision": "allow"}


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else "pre_tool"
    payload = _read_stdin_payload()

    if action == "pre_tool":
        result = handle_pre_tool(payload)
    elif action == "pre_invocation":
        result = handle_pre_invocation(payload)
    elif action == "post_tool":
        result = handle_post_tool(payload)
    elif action == "stop":
        result = handle_stop(payload)
    else:
        result = {"decision": "allow"}

    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
