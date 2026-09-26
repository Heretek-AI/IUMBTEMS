#!/usr/bin/env python3
"""
IUMBTEMS first-party MCP server: the canonical tool surface.

Wraps the existing Python APIs in-process (no spawnSync, no shell-outs):
- SwarmRunner  (runner/research_swarm.py)
- SourceHasher  (skills/research_cache/hasher.py)
- load_config / save_config  (skills/swarm_config/configure.py)
- DesignTree  (skills/grilling/socratic_tree.py)

Exposes the 7 canonical iumbtems_* tool names already registered by the
OpenCode plugin and Pi extension, so harness adapters can thin out to a
pointer at this server.

Two entry points:
  python3 runner/mcp_server.py                 # stdio MCP server
  python3 runner/mcp_server.py call <tool> '{}' # one-shot dispatch (JSON out)

Zero external dependencies by design: protocol loop is runner/mcp_protocol.py.
"""

import argparse
import io
import json
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# Bootstrap imports when launched as `python3 runner/mcp_server.py`
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from runner.mcp_protocol import PROTOCOL_VERSION, StdioJsonRpcServer, ToolSpec  # noqa: E402

SERVER_NAME = "iumbtems"
SERVER_VERSION = "0.3.0"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _tool_text(payload: Any) -> str:
    """Normalize a handler return into the MCP text content block body."""
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, indent=2, default=str)


def _capture_stdout(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> str:
    """Run a print-based CLI function and return what it wrote to stdout."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        fn(*args, **kwargs)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# tool handlers
# ---------------------------------------------------------------------------

def _handle_config(args: Dict[str, Any]) -> str:
    """Inspect or modify swarm parameters in .research/config.json."""
    from skills.swarm_config.configure import (
        display_config,
        load_config,
        save_config,
    )

    base_dir = args.get("base_dir") or args.get("dir") or ".research"
    cfg = load_config(base_dir)

    updates = {}
    for key in ("search_engine", "engine", "max_iterations", "depth", "mode", "divergence_threshold"):
        if key in args and args[key] is not None:
            canon = {
                "engine": "search_engine",
                "depth": "max_iterations",
                "divergence": "divergence_threshold",
            }.get(key, key)
            updates[canon] = args[key]

    if updates:
        cfg.update(updates)
        save_config(cfg, base_dir)
        return _tool_text({"status": "updated", "config": cfg, "written_to": str(Path(base_dir) / "config.json")})

    return _tool_text({"status": "current", "config": cfg})


def _run_swarm_mode(mode: Optional[str], args: Dict[str, Any]) -> str:
    """Shared dispatch for the four swarm-shaped tools."""
    from runner.research_swarm import SwarmRunner

    objective = args.get("objective") or args.get("target") or args.get("feature")
    if not objective:
        raise ValueError("objective is required")

    frontier = args.get("frontier") or args.get("frontier_file")
    runner = SwarmRunner(
        base_dir=Path(args.get("base_dir") or args.get("dir") or ".research"),
        mock_mode=bool(args.get("mock_claude") or args.get("mock_mode")),
        mode=mode or args.get("mode"),
        engine=args.get("engine"),
        depth=args.get("depth"),
        domain_pack=args.get("domain_pack"),
    )
    buf = io.StringIO()
    with redirect_stdout(buf):
        runner.run_swarm(objective, frontier_file=Path(frontier) if frontier else None)

    report = runner.base_dir / (
        {"audit": "code_audit_report.md", "scout": "oss_scout_report.md", "brainstorm": "brainstorm_report.md"}.get(
            mode or args.get("mode") or "research", "final_synthesis.md"
        )
    )
    return _tool_text({
        "status": "completed",
        "mode": mode or args.get("mode") or "research",
        "report": str(report),
        "log": buf.getvalue()[-4000:],
    })


def _handle_swarm_research(args: Dict[str, Any]) -> str:
    """Run the dialectic multi-agent research swarm (thesis vs antithesis)."""
    return _run_swarm_mode(None, args)


def _handle_code_audit(args: Dict[str, Any]) -> str:
    """Run a dialectic codebase architecture & security audit."""
    return _run_swarm_mode("audit", args)


def _handle_oss_scout(args: Dict[str, Any]) -> str:
    """Scout open-source software, libraries, and clean-room blueprints."""
    return _run_swarm_mode("scout", args)


def _handle_brainstorm(args: Dict[str, Any]) -> str:
    """Run lateral brainstorming (feature vectors + paradigm moves + spikes)."""
    return _run_swarm_mode("brainstorm", args)


def _handle_verify_quote(args: Dict[str, Any]) -> str:
    """Verify a verbatim quote against the content-addressed source cache."""
    from skills.research_cache.hasher import SourceHasher

    content_hash = args.get("hash") or args.get("content_hash") or args.get("source_hash")
    quote = args.get("quote")
    if not content_hash or quote is None:
        raise ValueError("hash and quote are required")

    hasher = SourceHasher(Path(args.get("base_dir") or args.get("dir") or ".research"))
    is_verified, confidence, message = hasher.verify_quote(content_hash, quote)
    return _tool_text({
        "verified": bool(is_verified),
        "confidence": float(confidence),
        "message": message,
        "content_hash": content_hash,
    })


def _handle_report_retraction(args: Dict[str, Any]) -> str:
    """Record a RETRACTED/REVISED event for a cached source (Living Dossiers)."""
    from runner.living_dossiers import write_retraction

    source_hash = args.get("hash") or args.get("source_hash")
    event = args.get("event")
    if not source_hash or not event:
        raise ValueError("hash and event are required")
    base_dir = Path(args.get("base_dir") or args.get("dir") or ".research")
    path = write_retraction(
        base_dir,
        source_hash,
        str(event).upper(),
        note=args.get("note") or "",
        supersedes=args.get("supersedes"),
    )
    return _tool_text({"status": "recorded", "path": str(path)})


def _handle_check_staleness(args: Dict[str, Any]) -> str:
    """Run one claim-degradation pass (retractions -> STALE/SUSPECT + requeue)."""
    from runner.living_dossiers import check_staleness

    base_dir = Path(args.get("base_dir") or args.get("dir") or ".research")
    scope_ids = args.get("scope_ids")
    return _tool_text(check_staleness(base_dir, scope_ids=scope_ids))


def _handle_set_domain_pack(args: Dict[str, Any]) -> str:
    """Activate a Regulated Domain Pack (epistemic constitution) in config."""
    from runner.refinement import load_domain_pack
    from skills.swarm_config.configure import load_config, save_config

    pack = args.get("pack") or args.get("domain_pack") or args.get("pack_id")
    if not pack:
        raise ValueError("pack is required")
    constitution = load_domain_pack(pack)  # raises if unknown — fail loudly
    base_dir = args.get("base_dir") or args.get("dir") or ".research"
    cfg = load_config(base_dir)
    cfg["domain_pack"] = pack
    save_config(cfg, base_dir)
    return _tool_text({
        "status": "activated",
        "domain_pack": pack,
        "accept_threshold": constitution.accept_threshold,
        "retraction_policy": constitution.retraction_policy,
        "banned_domains": constitution.banned_domains,
    })


def _handle_export_brief(args: Dict[str, Any]) -> str:
    """Export a proof-carrying research brief (signed, self-contained bundle)."""
    from runner.pcrb import export_brief

    base_dir = Path(args.get("base_dir") or args.get("dir") or ".research")
    key = args.get("key")
    key_path = Path(args["key_file"]) if args.get("key_file") else None
    path = export_brief(
        base_dir,
        out_path=Path(args["out"]) if args.get("out") else None,
        scope_ids=args.get("scope_ids"),
        objective=args.get("objective"),
        key=key,
        key_path=key_path,
        key_id=args.get("key_id") or "local",
    )
    return _tool_text({"status": "exported", "path": str(path)})


def _handle_verify_brief(args: Dict[str, Any]) -> str:
    """Verify a proof-carrying brief against its bundled sources (no trust in the LLM)."""
    import os

    from runner.pcrb import ENV_KEY
    from runner.pcrb_verify import verify_brief

    brief = args.get("brief") or args.get("path")
    if not brief:
        raise ValueError("brief path is required")
    p = Path(brief)
    if not p.exists():
        raise FileNotFoundError(f"no such brief: {p}")
    bundle = json.loads(p.read_text(encoding="utf-8"))

    key = None
    if args.get("key"):
        key = args["key"].encode("utf-8")
    elif args.get("key_file") and Path(args["key_file"]).exists():
        key = Path(args["key_file"]).read_bytes().strip()
    elif os.environ.get(ENV_KEY):
        key = os.environ[ENV_KEY].encode("utf-8")

    return _tool_text(verify_brief(bundle, key=key))


def _handle_reindex_claims(args: Dict[str, Any]) -> str:
    """Rebuild the derived claims.sqlite index from .research flat files."""
    from runner.claim_store import reindex

    base_dir = Path(args.get("base_dir") or args.get("dir") or ".research")
    return _tool_text(reindex(base_dir))


def _handle_socratic_frontier(args: Dict[str, Any]) -> str:
    """Advance or inspect the Socratic decision-tree frontier."""
    from skills.grilling.socratic_tree import DesignTree

    file_path = Path(args.get("file") or args.get("frontier_file") or ".research/frontier.json")

    if args.get("settle"):
        node_id, answer = args["settle"][0], args["settle"][1]
        if file_path.exists():
            tree = DesignTree.load_from_json(file_path)
        else:
            tree = DesignTree(objective=args.get("objective", ""))
        tree.settle_node(node_id, answer)
        tree.export_frontier_json(file_path)
        return _tool_text({"status": "settled", "node_id": node_id, "file": str(file_path)})

    if not file_path.exists():
        return _tool_text({
            "status": "no_frontier",
            "message": f"No frontier file at {file_path}. Run /grilling first.",
            "file": str(file_path),
        })

    tree = DesignTree.load_from_json(file_path)
    frontier = tree.compute_frontier()
    return _tool_text({
        "status": "frontier",
        "objective": tree.objective,
        "is_complete": tree.is_complete(),
        "total_nodes": len(tree.nodes),
        "settled": sum(1 for n in tree.nodes.values() if n.is_settled()),
        "frontier": [{"node_id": n.node_id, "question": n.question} for n in frontier],
        "file": str(file_path),
    })


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------

def build_tools() -> List[ToolSpec]:
    """The 7 canonical iumbtems_* tools, in-process wrappers only."""
    return [
        ToolSpec(
            name="iumbtems_config",
            description="Inspect or dynamically adjust Epistemic Swarm parameters (search engine, depth, mode) in .research/config.json.",
            input_schema={
                "type": "object",
                "properties": {
                    "base_dir": {"type": "string", "description": "Path to .research workspace (default .research)"},
                    "search_engine": {"type": "string", "enum": ["duckduckgo", "brave", "firecrawl", "searxng"]},
                    "max_iterations": {"type": "integer", "description": "Dialectic depth 1-4"},
                    "mode": {"type": "string", "enum": ["research", "audit", "scout", "hybrid", "brainstorm"]},
                    "divergence_threshold": {"type": "number"},
                },
            },
            handler=_handle_config,
        ),
        ToolSpec(
            name="iumbtems_swarm_research",
            description="Dispatch the dialectic researcher pair (Agent Alpha thesis vs Agent Beta antithesis) with epistemic auditing. Long-running; blocks until the swarm completes.",
            input_schema={
                "type": "object",
                "properties": {
                    "objective": {"type": "string", "description": "Research question or objective"},
                    "base_dir": {"type": "string"},
                    "frontier_file": {"type": "string", "description": "Settled frontier.json from grilling"},
                    "engine": {"type": "string", "enum": ["duckduckgo", "brave", "firecrawl", "searxng"]},
                    "depth": {"type": "integer"},
                    "mock_claude": {"type": "boolean", "description": "Synthetic run, zero API cost"},
                },
                "required": ["objective"],
            },
            handler=_handle_swarm_research,
        ),
        ToolSpec(
            name="iumbtems_code_audit",
            description="Dispatch a dialectic codebase review (structural architect vs vulnerability red-team).",
            input_schema={
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Codebase target or audit focus"},
                    "base_dir": {"type": "string"},
                    "mock_claude": {"type": "boolean"},
                },
                "required": ["target"],
            },
            handler=_handle_code_audit,
        ),
        ToolSpec(
            name="iumbtems_oss_scout",
            description="Scout open-source libraries, audit licenses, and build clean-room blueprints.",
            input_schema={
                "type": "object",
                "properties": {
                    "feature": {"type": "string", "description": "Feature or library to scout"},
                    "base_dir": {"type": "string"},
                    "mock_claude": {"type": "boolean"},
                },
                "required": ["feature"],
            },
            handler=_handle_oss_scout,
        ),
        ToolSpec(
            name="iumbtems_brainstorm",
            description="Lateral ideation portfolio (feature vectors + paradigm moves + falsifiable spikes). Never bug fixes.",
            input_schema={
                "type": "object",
                "properties": {
                    "objective": {"type": "string", "description": "Ambiguous prompt to ideate on"},
                    "base_dir": {"type": "string"},
                    "mock_claude": {"type": "boolean"},
                },
                "required": ["objective"],
            },
            handler=_handle_brainstorm,
        ),
        ToolSpec(
            name="iumbtems_verify_quote",
            description="Audit a verbatim citation against the SHA-256 source cache (.research/sources/<hash>.md).",
            input_schema={
                "type": "object",
                "properties": {
                    "hash": {"type": "string", "description": "Content-addressed SHA-256 of the cached source"},
                    "quote": {"type": "string", "description": "Verbatim quote to verify"},
                    "base_dir": {"type": "string"},
                },
                "required": ["hash", "quote"],
            },
            handler=_handle_verify_quote,
        ),
        ToolSpec(
            name="iumbtems_reindex_claims",
            description="Rebuild the derived claims.sqlite index from .research flat files (idempotent; flat files are source of truth).",
            input_schema={
                "type": "object",
                "properties": {
                    "base_dir": {"type": "string", "description": "Path to .research workspace"},
                },
            },
            handler=_handle_reindex_claims,
        ),
        ToolSpec(
            name="iumbtems_report_retraction",
            description="Record a RETRACTED/REVISED event for a cached source; dependent VERIFIED claims degrade to STALE/SUSPECT on the next audit (Living Dossiers).",
            input_schema={
                "type": "object",
                "properties": {
                    "hash": {"type": "string", "description": "Content-addressed SHA-256 of the affected source"},
                    "event": {"type": "string", "enum": ["RETRACTED", "REVISED"]},
                    "note": {"type": "string", "description": "Why the source was retracted/revised"},
                    "base_dir": {"type": "string"},
                },
                "required": ["hash", "event"],
            },
            handler=_handle_report_retraction,
        ),
        ToolSpec(
            name="iumbtems_check_staleness",
            description="Run one claim-degradation pass: join claims against retraction events, write the status ledger, and queue re-runs for degraded scopes. Never mutates dossiers.",
            input_schema={
                "type": "object",
                "properties": {
                    "base_dir": {"type": "string"},
                    "scope_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Limit the pass to specific scopes",
                    },
                },
            },
            handler=_handle_check_staleness,
        ),
        ToolSpec(
            name="iumbtems_set_domain_pack",
            description="Activate a Regulated Domain Pack (biopharma/quant/legal epistemic constitution) for subsequent audits.",
            input_schema={
                "type": "object",
                "properties": {
                    "pack": {"type": "string", "description": "Pack id: biopharma | quant | legal (or a path)"},
                    "base_dir": {"type": "string"},
                },
                "required": ["pack"],
            },
            handler=_handle_set_domain_pack,
        ),
        ToolSpec(
            name="iumbtems_export_brief",
            description="Export a proof-carrying research brief (PCRB): self-contained signed bundle of synthesis, claims, quote witnesses, and full source texts.",
            input_schema={
                "type": "object",
                "properties": {
                    "base_dir": {"type": "string"},
                    "out": {"type": "string", "description": "Output path (default <base_dir>/brief.pcrb.json)"},
                    "objective": {"type": "string"},
                    "key": {"type": "string", "description": "HMAC key (prefer key_file or env IUMBTEMS_PCRB_KEY)"},
                    "key_file": {"type": "string"},
                },
            },
            handler=_handle_export_brief,
        ),
        ToolSpec(
            name="iumbtems_verify_brief",
            description="Verify a proof-carrying brief against its BUNDLED sources: manifest integrity, HMAC signature, and every quote re-checked. Exit-fail semantics; no trust in the producing LLM.",
            input_schema={
                "type": "object",
                "properties": {
                    "brief": {"type": "string", "description": "Path to brief.pcrb.json"},
                    "key": {"type": "string"},
                    "key_file": {"type": "string"},
                },
                "required": ["brief"],
            },
            handler=_handle_verify_brief,
        ),
        ToolSpec(
            name="iumbtems_socratic_frontier",
            description="Inspect or advance the Socratic decision-tree frontier (.research/frontier.json).",
            input_schema={
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "Path to frontier.json"},
                    "objective": {"type": "string"},
                    "settle": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Two-element [node_id, answer] to settle a frontier node",
                    },
                },
            },
            handler=_handle_socratic_frontier,
        ),
    ]


def build_server() -> StdioJsonRpcServer:
    return StdioJsonRpcServer(
        server_name=SERVER_NAME,
        version=SERVER_VERSION,
        tools=build_tools(),
        protocol_version=PROTOCOL_VERSION,
        log_prefix="[iumbtems-mcp]",
    )


# ---------------------------------------------------------------------------
# entry points
# ---------------------------------------------------------------------------

def call_once(tool_name: str, arguments: Dict[str, Any]) -> int:
    """One-shot dispatch: run a single tool and print its text payload."""
    server = build_server()
    spec = server._by_name.get(tool_name)
    if spec is None:
        json.dump(
            {"error": f"Tool {tool_name} not found", "available": [t.name for t in server.tools]},
            sys.stdout,
            indent=2,
        )
        sys.stdout.write("\n")
        return 1
    try:
        text = spec.handler(arguments)
    except Exception as exc:  # noqa: BLE001 - surface as a JSON error payload
        json.dump({"error": f"{type(exc).__name__}: {exc}"}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 1
    sys.stdout.write(text if text.endswith("\n") else text + "\n")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="IUMBTEMS MCP server")
    sub = parser.add_subparsers(dest="command")

    call_p = sub.add_parser("call", help="One-shot tool dispatch (JSON out)")
    call_p.add_argument("tool", help="Tool name, e.g. iumbtems_verify_quote")
    call_p.add_argument("arguments", help="JSON object of tool arguments")

    sub.add_parser("serve", help="Run stdio MCP server (default)")

    args = parser.parse_args(argv)

    if args.command == "call":
        try:
            arguments = json.loads(args.arguments) if args.arguments else {}
        except json.JSONDecodeError as exc:
            print(json.dumps({"error": f"arguments must be valid JSON: {exc}"}))
            return 1
        return call_once(args.tool, arguments)

    build_server().serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
