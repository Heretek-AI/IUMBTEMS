#!/usr/bin/env python3
"""
Antigravity Lifecycle Hook Interceptor & Epistemic Gate Bridge.

Binds Antigravity's lifecycle events (PreToolUse, PreInvocation, PostToolUse, Stop)
to IUMBTEMS's epistemic evidence verification pipeline and the 6-event Hook Bus:
1. Analysis Bridge (Biome CLI static analysis for JS/TS)
2. Dependency Health Gate (OSV.dev vulnerability & freshness scanner)
3. Weight Signals (esbuild bundle weight & coverage deltas vs baseline)
4. Pre-commit gating on .research/config.json with optimistic concurrency (expected_hash)
5. Session context & compaction preservation (buildCompactionContext)
6. Living dossier claim degradation stop-gating

Contract Invariants:
- Input is received as JSON on stdin (camelCase per Antigravity hook protojson).
- Output is emitted as JSON on stdout.
- Zero-failure tolerance: any unexpected internal error falls back safely without
  blocking the agent loop.
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


def _get_workspace_dir(payload: Dict[str, Any]) -> Path:
    workspaces = payload.get("workspacePaths", [])
    if workspaces and workspaces[0]:
        return Path(workspaces[0]).resolve()
    if payload.get("workspaceRoot"):
        return Path(payload["workspaceRoot"]).resolve()
    if "IUMBTEMS_WORKSPACE" in os.environ:
        return Path(os.environ["IUMBTEMS_WORKSPACE"]).resolve()
    if "IUMBTEMS_ROOT" in os.environ:
        return Path(os.environ["IUMBTEMS_ROOT"]).resolve()
    curr = Path.cwd().resolve()
    for p in [curr] + list(curr.parents):
        if (p / ".research").exists() or (p / ".git").exists():
            return p
    return curr


def _find_hook_bus_bridge(workspace_dir: Path) -> Optional[Path]:
    script_dir = Path(__file__).resolve().parent
    candidates = [
        script_dir / "hook_bus_bridge.js",
        script_dir.parent / "plugins" / "antigravity" / "hook_bus_bridge.js",
        workspace_dir / "plugins" / "antigravity" / "hook_bus_bridge.js",
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


def _run_node_bridge(action: str, payload: Dict[str, Any], timeout: int = 5) -> Dict[str, Any]:
    try:
        node_bin = shutil.which("node")
        if not node_bin:
            return {}
        workspace_dir = _get_workspace_dir(payload)
        bridge_script = _find_hook_bus_bridge(workspace_dir)
        if not bridge_script:
            return {}

        proc = subprocess.run(
            [node_bin, str(bridge_script), action],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(workspace_dir),
        )
        if proc.returncode == 0 and proc.stdout.strip():
            # Parse the last line starting with { to avoid node warnings
            for line in reversed(proc.stdout.strip().splitlines()):
                line = line.strip()
                if line.startswith("{") and line.endswith("}"):
                    return json.loads(line)
    except Exception:
        pass
    return {}


def _read_stdin_payload() -> Dict[str, Any]:
    try:
        content = sys.stdin.read()
        if not content.strip():
            return {}
        return json.loads(content)
    except Exception:
        return {}


def handle_pre_tool(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Intercept ungrounded search/fetch, pre-commit config edits, and pre-tool hooks."""
    tool_call = payload.get("toolCall", {})
    name = str(tool_call.get("name", "")).lower()
    args = tool_call.get("args", {})

    # 1. Epistemic Search & Fetch Quarantine (<1ms fast-path)
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

    # 2. Mutating tool calls: run pre-commit config check & hook bus
    target_file = str(args.get("TargetFile") or args.get("file") or args.get("path") or "")
    is_mutating = name in ("write_to_file", "replace_file_content", "run_command")

    if is_mutating or (".research" in target_file):
        bridge_res = _run_node_bridge("pre_tool", payload, timeout=3)
        if bridge_res.get("decision") == "deny" or bridge_res.get("allowed") is False:
            return {
                "decision": "deny",
                "reason": bridge_res.get("reason", "Blocked by Pre-Commit quality gate"),
            }

    return {"decision": "allow"}


def handle_pre_invocation(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Inject ephemeral evidence tagging constraints, compaction context, and quality gate notices."""
    inject_steps: List[Dict[str, Any]] = [
        {
            "ephemeralMessage": (
                "[EPISTEMIC INTEGRITY] Every factual claim must carry "
                "[VERIFIED: <sha256>] (verbatim quote in .research/sources/<hash>.md), "
                "[INFERRED: <parents>], [HYPOTHESIS: <test>], or [NEGATIVE_KNOWLEDGE: <query>]. "
                "Unverified parametric recall is strictly quarantined."
            )
        }
    ]

    # Query Node bridge for compaction context and pending quality gate annotations
    bridge_res = _run_node_bridge("pre_invocation", payload, timeout=3)
    compaction = bridge_res.get("compactionContext")
    if compaction and isinstance(compaction, str):
        inject_steps.append({"ephemeralMessage": compaction})

    annotations = bridge_res.get("annotations") or []
    if annotations and isinstance(annotations, list):
        notices = []
        for a in annotations:
            if isinstance(a, dict) and a.get("reason"):
                notices.append(f"- {a.get('handler', 'QualityGate')}: {a['reason']}")
            elif isinstance(a, str):
                notices.append(f"- {a}")
        if notices:
            inject_steps.append({
                "ephemeralMessage": "[QUALITY GATES ADVISORY]\n" + "\n".join(notices)
            })

    return {"injectSteps": inject_steps}


def handle_post_tool(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Log tool completions, record negative knowledge, and dispatch to quality gates."""
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

        tool_call = payload.get("toolCall", {})
        name = str(tool_call.get("name", "")).lower()
        if name in ("write_to_file", "replace_file_content", "run_command"):
            _run_node_bridge("post_tool", payload, timeout=4)
    except Exception:
        pass
    return {}


def handle_stop(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Prevent agent from terminating if an active swarm run has unverified claims or unsettled gates."""
    try:
        workspace_dir = _get_workspace_dir(payload)
        research_dir = workspace_dir / ".research"

        # If a STOP signal file was placed by user or factory, respect it immediately
        factory_stop = workspace_dir / ".factory" / "STOP"
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

        # Query Node hook bus bridge for stop event denial
        bridge_res = _run_node_bridge("stop", payload, timeout=3)
        if bridge_res.get("decision") == "continue" or bridge_res.get("allowed") is False:
            return {
                "decision": "continue",
                "reason": bridge_res.get("reason", "Blocked by Hook Bus stop policy"),
            }
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
