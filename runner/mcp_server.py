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
import copy
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

DEFAULT_RESEARCH_DIR = ".research"

# `iumbtems_config` arguments that are not config keys.
CONFIG_TOOL_CONTROL_ARGS = ("base_dir", "dir", "show", "expected_hash", "expectedHash")

# Legacy aliases accepted for the corresponding canonical key (kept for the
# slash-command/CLI vocabulary; the advertised schema uses canonical names).
CONFIG_KEY_ALIASES = {
    "engine": "search_engine",
    "depth": "max_iterations",
    "divergence": "divergence_threshold",
}


def config_tool_input_schema() -> Dict[str, Any]:
    """Advertised `iumbtems_config` input schema, derived from the canonical CONFIG.

    Generated from `runner.schemas.CONFIG` so the MCP surface cannot drift from
    the persisted contract (a parity fixture asserts this).
    """
    from runner.schemas import CONFIG

    props: Dict[str, Any] = {
        "base_dir": {
            "type": "string",
            "description": "Path to .research workspace (default .research)",
        },
        "show": {
            "type": "boolean",
            "description": (
                "Inspect only; equivalent to calling with no update keys "
                "(reads are always safe). When true, the call is read-only "
                "even if update keys are present: they are listed under "
                "`ignored_updates` and nothing is written (the expected_hash "
                "guard, including the dual-spelling conflict check, is not "
                "evaluated)."
            ),
        },
        "expected_hash": {
            "type": "string",
            "description": (
                "Optimistic-concurrency guard: SHA-256 (or a unique prefix of at "
                "least 8 hex chars) of the config file you read. A mismatch "
                "returns a structured stale error with a fresh snapshot and "
                "writes nothing. Empty/whitespace-only spellings count as absent. "
                "Alias: `expectedHash`; if both spellings are "
                "present they must be equal after normalization (strip + "
                "lowercase) or the call is rejected."
            ),
        },
        "expectedHash": {
            "type": "string",
            "description": "Alias of `expected_hash` (camelCase); must not conflict with it.",
        },
    }
    for key, subschema in CONFIG["properties"].items():
        props[key] = copy.deepcopy(subschema)
    return {"type": "object", "properties": props}


def _resolve_base_dir(args: Dict[str, Any]) -> Path:
    raw = args.get("base_dir") or args.get("dir")
    if raw:
        return Path(os.path.realpath(str(raw)))
    # Project root wins over process cwd: a relative ".research" resolved
    # against the MCP server's cwd escapes the project (observed live:
    # evidence landed in ~/.research instead of the project tree).
    project = os.environ.get("IUMBTEMS_PROJECT_DIR", "").strip()
    if project and Path(project).is_dir():
        return Path(os.path.realpath(os.path.join(project, DEFAULT_RESEARCH_DIR)))
    return Path(os.path.realpath(DEFAULT_RESEARCH_DIR))


def _canonical_config_keys() -> List[str]:
    from runner.schemas import CONFIG

    return list(CONFIG["properties"].keys())


def _allows_null(schema: Dict[str, Any]) -> bool:
    types = schema.get("type")
    if isinstance(types, list):
        return "null" in types
    return types == "null"


def _normalize_hash_spelling(value: Any) -> str:
    """Strip + lowercase a hash spelling for conflict comparison (H2).

    Mirrors `normalize_expected_hash` in `skills/swarm_config/configure.py`
    WITHOUT raising: malformed spellings still compare (so genuinely different
    malformed guards conflict), and the single `save_config` writer later
    validates the winner (malformed -> CONFIG_INVALID_EXPECTED_HASH).
    Empty/whitespace-only spellings normalize to "" and are treated as absent
    by the caller (R3: "" never conflicts).
    """
    return str(value).strip().lower()


def _hash_spelling_present(value: Any) -> bool:
    """True when an expected-hash spelling counts as provided (R3).

    `None` and empty/whitespace-only strings mean "no guard" (mirroring
    `normalize_expected_hash`); everything else is a guard spelling even if
    malformed (malformed -> CONFIG_INVALID_EXPECTED_HASH on the write leg).
    """
    if value is None:
        return False
    return str(value).strip() != ""


def _find_nested_null_violations(updates: Dict[str, Any]) -> List[str]:
    """Dotted paths in `updates` carrying None where the schema bans null (H4).

    The top-level loop in `_handle_config` already catches a direct
    `{"mode": None}`; this extends the same `NULL_FOR_NON_NULLABLE_KEY` code
    to nested nulls such as `{"verify": {"min_fuzzy_confidence": None}}`,
    which previously surfaced as the generic `CONFIG_VALIDATION_FAILED`.
    Contract: `NULL_FOR_NON_NULLABLE_KEY` wins for ANY caller-supplied null
    at any depth; `CONFIG_VALIDATION_FAILED` covers every other schema
    violation (including nulls already persisted on disk by a hand edit,
    which the caller did not supply in this call).
    """
    from runner.schemas import CONFIG

    found: List[str] = []

    def walk(value: Any, subschema: Any, path: str) -> None:
        if value is None:
            if isinstance(subschema, dict) and not _allows_null(subschema):
                found.append(path)
            return
        if isinstance(value, dict) and isinstance(subschema, dict):
            props = subschema.get("properties") or {}
            additional = subschema.get("additionalProperties")
            for key, child in value.items():
                if key in props:
                    walk(child, props[key], f"{path}.{key}" if path else str(key))
                elif isinstance(additional, dict):
                    # e.g. `mcp_servers` values must be boolean; a null there
                    # is a null-violation too, with the full dotted path.
                    walk(
                        child,
                        additional,
                        f"{path}.{key}" if path else str(key),
                    )
            # Unknown keys with no `additionalProperties` schema carry no
            # nullability info; generic validation decides them (unknown
            # object keys are preserved verbatim).
            return
        if isinstance(value, list) and isinstance(subschema, dict):
            items = subschema.get("items")
            if isinstance(items, dict):
                for idx, child in enumerate(value):
                    walk(child, items, f"{path}[{idx}]")

    props = CONFIG.get("properties") or {}
    for key, value in updates.items():
        if value is None or not isinstance(value, (dict, list)):
            continue  # top-level nulls are handled by the caller loop
        canon = CONFIG_KEY_ALIASES.get(key, key)
        if canon in props:
            walk(value, props[canon], str(canon))
    return sorted(found)


def _config_updated_payload(
    cfg_file: Path, candidate: Dict[str, Any], default_config: Dict[str, Any]
) -> Dict[str, Any]:
    """Success payload for the config write leg (H6).

    `written_to` is ALWAYS an absolute path (via realpath, so symlinked
    workspaces resolve to the true location). Both updated legs — the normal
    single-read leg and the defensive branch where the just-written bytes
    cannot be re-read — share this helper so the shape cannot diverge.
    """
    import hashlib

    from skills.swarm_config.configure import _read_bounded_bytes, merge_config

    abs_path = str(Path(os.path.realpath(str(cfg_file))))
    try:
        # Phase-08 R2 (W17): bounded re-read — the just-written file is
        # regular by construction, but a single read primitive keeps the
        # FIFO-hardening total (a concurrent swap can only fail into the
        # defensive branch below, never hang the writer).
        raw_bytes = _read_bounded_bytes(Path(cfg_file))
    except OSError:
        raw_bytes = None
    if raw_bytes is None:
        # A successful save always leaves bytes; keep the payload shape without
        # a second read in this (unreachable) defensive branch.
        return {
            "status": "updated",
            "config": candidate,
            "written_to": abs_path,
            "hash": None,
        }
    try:
        parsed = json.loads(raw_bytes.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        parsed = None
    effective = (
        merge_config(default_config, parsed)
        if isinstance(parsed, dict)
        else merge_config(default_config, {})
    )
    return {
        "status": "updated",
        "config": effective,
        "written_to": abs_path,
        "hash": hashlib.sha256(raw_bytes).hexdigest(),
    }


def _legacy_pin_migration_pending(base_dir: str) -> bool:
    """Would the legacy-pin migration apply on the next write? (read-only)

    Phase-04 R11: the `show` leg reports this WITHOUT persisting, so a read API
    stays side-effect free. Mirrors `heal_config`'s decision — the on-disk file
    carries a legacy ``["claude", "-p"]`` pin AND the would-be-persisted config
    passes canonical validation (an invalid file is never healed, R1) — but
    never writes.
    """
    try:
        from skills.swarm_config.configure import (
            _read_bounded_bytes,
            load_config,
            migrate_legacy_agent_backends,
            validate_config,
        )

        cfg_file = Path(base_dir) / "config.json"
        # Phase-08 R2 (W17): bounded pre-read — a FIFO here hung the show leg
        # on a plain `read_bytes`. Unreadable/non-regular yields "no pending
        # migration" (fail-open read, matching `load_config` defaults).
        raw_bytes = _read_bounded_bytes(cfg_file)
        if raw_bytes is None:
            return False
        raw = json.loads(raw_bytes.decode("utf-8"))
        if not isinstance(raw, dict):
            return False
        if not migrate_legacy_agent_backends(raw):
            return False
        return not validate_config(load_config(base_dir))
    except Exception:
        return False


def _handle_config(args: Dict[str, Any]) -> str:
    """Inspect or modify swarm parameters in .research/config.json.

    Every canonical key is accepted; invalid values, unknown keys, and `null`
    for non-nullable keys are rejected with a structured error before anything
    is written. Writes go through the single canonical writer (`save_config`:
    locked, validated, atomic, unknown-key-preserving) with an optional
    `expected_hash` guard (both `expected_hash` and `expectedHash` spellings).

    Phase-05 H2 decisions: the two hash spellings compare NORMALIZED
    (strip + lowercase, mirroring `normalize_expected_hash`), so
    `"ABCDEF12"` vs `"abcdef12"` is one guard, not a conflict; empty or
    whitespace-only spellings count as absent on both sides (R3), so `""`
    never conflicts; and `show` forces the read-only leg even when update
    keys are present (they are reported under `ignored_updates` and nothing
    is written, without evaluating the guard or the dual-spelling conflict
    check — R1 ordering).
    """
    from skills.swarm_config.configure import (
        DEFAULT_CONFIG,
        ConfigError,
        load_config,
        merge_config,
        save_config,
        validate_config,
    )
    from runner.schemas import CONFIG

    base_dir = str(_resolve_base_dir(args))
    cfg = load_config(base_dir)

    snake = args.get("expected_hash")
    camel = args.get("expectedHash")
    snake_present = _hash_spelling_present(snake)
    camel_present = _hash_spelling_present(camel)

    accepted = _canonical_config_keys()
    nullable = [key for key in accepted if _allows_null(CONFIG["properties"][key])]
    unknown: List[str] = []
    null_for_non_nullable: List[str] = []
    updates: Dict[str, Any] = {}
    for key, value in args.items():
        if key in CONFIG_TOOL_CONTROL_ARGS:
            continue
        canon = CONFIG_KEY_ALIASES.get(key, key)
        if canon not in accepted:
            unknown.append(str(key))
            continue
        if value is None:
            if _allows_null(CONFIG["properties"][canon]):
                # Nullable key: explicit clear / follow-the-default-policy.
                updates[canon] = None
            else:
                # R8: never mask a null for a non-nullable key as a no-op.
                null_for_non_nullable.append(str(canon))
            continue
        updates[canon] = value

    if unknown:
        return _tool_text(
            {
                "status": "error",
                "code": "UNKNOWN_CONFIG_KEY",
                "written": False,
                "errors": [f"unknown config key(s): {', '.join(sorted(unknown))}"],
                "accepted_keys": accepted,
            }
        )
    # H4: nested caller-supplied nulls share the top-level code, with dotted
    # paths (e.g. `verify.min_fuzzy_confidence`).
    null_for_non_nullable.extend(_find_nested_null_violations(updates))
    if null_for_non_nullable:
        return _tool_text(
            {
                "status": "error",
                "code": "NULL_FOR_NON_NULLABLE_KEY",
                "written": False,
                "errors": [
                    f"null is not accepted for non-nullable key(s): "
                    f"{', '.join(sorted(set(null_for_non_nullable)))}; omit the key to "
                    "leave it unchanged, or pass a valid value"
                ],
                "nullable_keys": nullable,
                "accepted_keys": accepted,
            }
        )

    if args.get("show") or not updates:
        # R11/H2/R1: the show leg is strictly read-only — a settings panel reads
        # through it, so it must never persist the legacy-pin migration nor
        # evaluate the expected_hash guard (including the dual-spelling
        # conflict check, which lives BELOW this return). Report whether a
        # migration is pending; only the write leg below heals. When `show`
        # overrides present update keys, name them so the caller knows nothing
        # was written.
        payload: Dict[str, Any] = {
            "status": "current",
            "config": cfg,
            "migrated": _legacy_pin_migration_pending(base_dir),
        }
        if args.get("show") and updates:
            payload["ignored_updates"] = sorted(updates)
        return _tool_text(payload)

    # R1 ordering: the dual-spelling conflict check lives BELOW the show
    # early-return so the show leg is fully read-only. R4/H2: both spellings
    # must agree AFTER normalization; never silently prefer one.
    # Case/whitespace-only differences are one guard; empty/whitespace-only
    # spellings count as absent (R3).
    if (
        snake_present
        and camel_present
        and _normalize_hash_spelling(snake) != _normalize_hash_spelling(camel)
    ):
        return _tool_text(
            {
                "status": "error",
                "code": "CONFLICTING_EXPECTED_HASH",
                "written": False,
                "errors": [
                    "expected_hash and expectedHash were both provided with "
                    "different values; provide one spelling (or two equal values)."
                ],
                "expected_hash": str(snake),
                "expectedHash": str(camel),
            }
        )
    if snake_present:
        expected: Any = snake
    elif camel_present:
        expected = camel
    else:
        expected = None

    candidate = merge_config(cfg, updates)
    problems = validate_config(candidate)
    if problems:
        return _tool_text(
            {
                "status": "error",
                "code": "CONFIG_VALIDATION_FAILED",
                "written": False,
                "errors": problems,
                "config": cfg,
            }
        )

    # R12 (F1): do NOT heal before saving. The candidate is already migrated in
    # memory (`load_config`) and `save_config` merges it over the on-disk bytes,
    # so the legacy-pin migration persists as a side effect — while the caller's
    # `expected_hash` guard still matches the bytes they read. A heal-before-save
    # rewrote the file and turned a valid guarded write into a false `stale`.
    try:
        save_config(
            candidate,
            base_dir,
            expected_hash=str(expected) if expected is not None else None,
        )
    except ConfigError as exc:
        payload: Dict[str, Any] = {"status": "error", "written": False}
        payload.update(exc.to_dict())
        if exc.code == "CONFIG_STALE":
            payload["status"] = "stale"
            payload.update(exc.details)
        return _tool_text(payload)

    # R10 (single read): derive BOTH the effective config and the hash from ONE
    # read of the just-published bytes, so the storage mirror and the `changed`
    # event can never receive an era-A config paired with an era-B hash.
    # `save_config` publishes a fully defaults-merged, validated object
    # atomically, so the bytes on disk are already the effective config; the
    # earlier `load_config()` + `config_hash()` were two independent reads.
    # H6: the shared helper guarantees an absolute `written_to` on both legs.
    cfg_file = Path(base_dir) / "config.json"
    return _tool_text(_config_updated_payload(cfg_file, candidate, DEFAULT_CONFIG))


def _run_swarm_mode(mode: Optional[str], args: Dict[str, Any]) -> str:
    """Shared dispatch for the four swarm-shaped tools."""
    from runner.research_swarm import SwarmRunner

    objective = args.get("objective") or args.get("target") or args.get("feature")
    if not objective:
        raise ValueError("objective is required")

    frontier = args.get("frontier") or args.get("frontier_file")
    overrides = None
    backend = (args.get("backend") or "").strip().lower()
    if backend in ("claude", "opencode"):
        argv = ["claude", "-p"] if backend == "claude" else ["opencode", "run"]
        overrides = {"alpha": {"backend": argv}, "beta": {"backend": argv}}
    runner = SwarmRunner(
        base_dir=_resolve_base_dir(args),
        mock_mode=bool(args.get("mock_claude") or args.get("mock_mode")),
        mode=mode or args.get("mode"),
        engine=args.get("engine"),
        depth=args.get("depth"),
        domain_pack=args.get("domain_pack"),
        agent_overrides=overrides,
        resume=bool(args.get("resume")),
        dry_run=bool(args.get("dry_run")),
    )
    buf = io.StringIO()
    status = None
    with redirect_stdout(buf):
        status = runner.run_swarm(
            objective, frontier_file=Path(frontier) if frontier else None
        )

    mode_name = mode or args.get("mode") or "research"
    log = buf.getvalue()[-4000:]

    # Decide from the ACTUAL run outcome, not the raw gate verdict: mock and dry
    # runs are exempt from the fail-fast halt (they complete/validate), and only
    # a real halt sets `_halted`. Reading `_search_gate.action` alone mislabelled
    # every blocked-but-exempt run as `halted`.
    if status == "halted" or getattr(runner, "_halted", False):
        gate = getattr(runner, "_search_gate", None) or {}
        return _tool_text(
            {
                "status": "halted",
                "mode": mode_name,
                "reason": gate.get("reason"),
                "message": gate.get("message"),
                "log": log,
            }
        )
    if status == "dry-run":
        return _tool_text({"status": "dry-run", "mode": mode_name, "log": log})
    if status == "incomplete":
        return _tool_text({"status": "incomplete", "mode": mode_name, "log": log})

    report = runner.base_dir / (
        {
            "audit": "code_audit_report.md",
            "scout": "oss_scout_report.md",
            "brainstorm": "brainstorm_report.md",
            "darkharvest": "darkharvest_report.md",
        }.get(mode_name, "final_synthesis.md")
    )
    return _tool_text(
        {
            "status": "completed",
            "mode": mode_name,
            "report": str(report),
            "log": log,
        }
    )


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


def _handle_darkharvest(args: Dict[str, Any]) -> str:
    """Run product competitor teardown (seed + expand, harvest verdicts)."""
    return _run_swarm_mode("darkharvest", args)


def _handle_factory(args: Dict[str, Any]) -> str:
    """Drive factory run state (init / phase-add / qa-record / expansion / stop / gate).

    Wraps skills/factory/scripts/factory.py so agents never need a filesystem
    path to the helper: the npm-installed toolchain lives outside the project,
    and relative `skills/...` paths broke in consuming projects (observed
    live: the manager agent ran `find / -name factory.py`).

    Phase-08 R4 (W6): the `gate` command forwards `--run/--phase/--action`
    (+ optional `--reason`) to the helper's `gate` subcommand. Before this
    fix the handler accepted `gate` but forwarded no gate args, so the helper
    exited 2 (missing required `--run/--phase/--action`) and gate was
    unreachable through the tool surface.
    """
    import subprocess

    command = str(args.get("command") or "").strip()
    if command not in ("init", "phase-add", "qa-record", "expansion", "stop", "gate"):
        raise ValueError(
            "command must be one of: init, phase-add, qa-record, expansion, stop, gate"
        )
    script = Path(PROJECT_ROOT) / "skills" / "factory" / "scripts" / "factory.py"
    if not script.is_file():
        raise FileNotFoundError(f"factory helper not found at {script}")

    project = (
        args.get("project_dir") or os.environ.get("IUMBTEMS_PROJECT_DIR") or os.getcwd()
    )
    cmd = [sys.executable, str(script), command, "--project-dir", str(project)]
    if command == "init":
        cmd += ["--run", str(args.get("run") or "")]
    elif command == "phase-add":
        cmd += [
            "--run",
            str(args.get("run") or ""),
            "--phase",
            str(args.get("phase") or ""),
            "--goal",
            str(args.get("goal") or ""),
            "--accept",
            str(args.get("accept") or ""),
        ]
    elif command == "qa-record":
        cmd += [
            "--run",
            str(args.get("run") or ""),
            "--phase",
            str(args.get("phase") or ""),
            "--seat",
            str(args.get("seat") or ""),
            "--verdict",
            str(args.get("verdict") or ""),
        ]
        if args.get("reason"):
            cmd += ["--reason", str(args["reason"])]
    elif command == "expansion":
        cmd += [
            "--run",
            str(args.get("run") or ""),
            "--loops",
            str(int(args.get("loops") or 1)),
        ]
        if args.get("max_loops"):
            cmd += ["--max-loops", str(int(args["max_loops"]))]
    elif command == "stop":
        cmd += ["--run", str(args.get("run") or "")]
    elif command == "gate":
        cmd += [
            "--run",
            str(args.get("run") or ""),
            "--phase",
            str(args.get("phase") or ""),
            "--action",
            str(args.get("action") or ""),
        ]
        if args.get("reason"):
            cmd += ["--reason", str(args["reason"])]

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        shell=False,
        stdin=subprocess.DEVNULL,
        cwd=str(project),
    )
    payload = {
        "status": "ok" if proc.returncode == 0 else "error",
        "command": command,
        "returncode": proc.returncode,
        "project_dir": str(project),
        "output": (proc.stdout or proc.stderr or "").strip()[-4000:],
    }
    if proc.returncode == 2:
        payload["status"] = "escalated"
    return _tool_text(payload)


def _verify_min_fuzzy_confidence(cfg: Any) -> Any:
    """Configured `verify.min_fuzzy_confidence`, defaulting to 0.88 (H5).

    SINGLE-ENFORCEMENT-POINT CONTRACT: this returns the configured value
    UNTOUCHED (no `float()` parse, no clamp) and `SourceHasher.verify_quote`
    enforces it via `coerce_min_fuzzy_confidence` at call time. The persisted
    schema stays strict (`type: number`); coercion exists only for
    hand-edited files and direct library callers. The response echoes the
    EFFECTIVE threshold (`coerce_min_fuzzy_confidence(configured)`), so the
    reported value is always the one that governed the decision.
    """
    verify = cfg.get("verify") if isinstance(cfg, dict) else None
    raw = verify.get("min_fuzzy_confidence") if isinstance(verify, dict) else None
    return 0.88 if raw is None else raw


def _handle_verify_quote(args: Dict[str, Any]) -> str:
    """Verify a verbatim quote against the content-addressed source cache."""
    from skills.research_cache.hasher import (
        SourceHasher,
        coerce_min_fuzzy_confidence,
    )
    from skills.swarm_config.configure import load_config

    content_hash = (
        args.get("hash") or args.get("content_hash") or args.get("source_hash")
    )
    quote = args.get("quote")
    if not content_hash or quote is None:
        raise ValueError("hash and quote are required")

    base_dir = _resolve_base_dir(args)
    configured = _verify_min_fuzzy_confidence(load_config(str(base_dir)))
    hasher = SourceHasher(base_dir)
    is_verified, confidence, message = hasher.verify_quote(
        content_hash, quote, min_fuzzy_confidence=configured
    )
    return _tool_text(
        {
            "verified": bool(is_verified),
            "confidence": float(confidence),
            "message": message,
            "content_hash": content_hash,
            "min_fuzzy_confidence": coerce_min_fuzzy_confidence(configured),
        }
    )


def _handle_report_retraction(args: Dict[str, Any]) -> str:
    """Record a RETRACTED/REVISED event for a cached source (Living Dossiers)."""
    from runner.living_dossiers import write_retraction

    source_hash = args.get("hash") or args.get("source_hash")
    event = args.get("event")
    if not source_hash or not event:
        raise ValueError("hash and event are required")
    base_dir = _resolve_base_dir(args)
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

    base_dir = _resolve_base_dir(args)
    scope_ids = args.get("scope_ids")
    return _tool_text(check_staleness(base_dir, scope_ids=scope_ids))


def _handle_set_domain_pack(args: Dict[str, Any]) -> str:
    """Activate a Regulated Domain Pack (epistemic constitution) in config.

    H3: surrounding whitespace is stripped before resolving — a blank or
    whitespace-only id is rejected (the canonical schema additionally rejects
    blank/padded ids at validation, so a padded id can never persist).
    """
    from runner.refinement import load_domain_pack
    from skills.swarm_config.configure import load_config, save_config

    raw_pack = args.get("pack") or args.get("domain_pack") or args.get("pack_id")
    pack = raw_pack.strip() if isinstance(raw_pack, str) else raw_pack
    if not pack or (isinstance(pack, str) and not pack.strip()):
        raise ValueError("pack is required (blank/whitespace-only ids are rejected)")
    constitution = load_domain_pack(pack)  # raises if unknown — fail loudly
    base_dir = str(_resolve_base_dir(args))
    cfg = load_config(base_dir)
    cfg["domain_pack"] = pack
    save_config(cfg, base_dir)
    return _tool_text(
        {
            "status": "activated",
            "domain_pack": pack,
            "accept_threshold": constitution.accept_threshold,
            "retraction_policy": constitution.retraction_policy,
            "banned_domains": constitution.banned_domains,
        }
    )


def _handle_export_brief(args: Dict[str, Any]) -> str:
    """Export a proof-carrying research brief (signed, self-contained bundle)."""
    from runner.pcrb import export_brief

    base_dir = _resolve_base_dir(args)
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
    p = Path(os.path.realpath(str(brief)))
    if not p.exists():
        raise FileNotFoundError(f"no such brief: {p}")
    bundle = json.loads(p.read_text(encoding="utf-8"))

    key = None
    if args.get("key"):
        key = args["key"].encode("utf-8")
    elif args.get("key_file"):
        kf = Path(os.path.realpath(str(args["key_file"])))
        # An explicit key_file that cannot be read must surface as an error, not
        # a silent fallthrough to `alg: "none"`.
        if not kf.is_file():
            raise ValueError(f"key file is not a readable file: {args['key_file']!r}")
        key = kf.read_bytes().strip()
    elif os.environ.get(ENV_KEY):
        key = os.environ[ENV_KEY].encode("utf-8")

    return _tool_text(verify_brief(bundle, key=key))


def _handle_reindex_claims(args: Dict[str, Any]) -> str:
    """Rebuild the derived claims.sqlite index from .research flat files."""
    from runner.claim_store import reindex

    base_dir = _resolve_base_dir(args)
    return _tool_text(reindex(base_dir))


def _handle_doctor(args: Dict[str, Any]) -> str:
    """Preflight for the resolved workspace: backend, engine, write test, version."""
    from runner.preflight import format_report, host_websearch_provider, preflight
    from skills.swarm_config.configure import load_config

    base_dir = _resolve_base_dir(args)
    cfg = load_config(str(base_dir))
    report = preflight(
        base_dir,
        mode=args.get("mode") or cfg.get("mode") or "research",
        config=cfg,
        # Never spawn in a health check; report resolution only.
        mock_mode=True,
        probe=bool(args.get("probe", True)),
        # Feed the same host-reported provider/since the run path uses, or the
        # doctor names a different provider than the run banner (observed:
        # IUMBTEMS_WEBSEARCH_PROVIDER=tavily -> doctor said duckduckgo).
        host_provider=host_websearch_provider(cfg),
        since=args.get("since"),
    )
    return _tool_text({"report": report, "text": format_report(report)})


def _handle_test(args: Dict[str, Any]) -> str:
    """Run the packaged test suite in a subprocess (timeout-bounded)."""
    import subprocess

    timeout = float(os.environ.get("IUMBTEMS_TEST_TIMEOUT", "300"))
    try:
        result = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "runner/tests"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return _tool_text({"status": "timeout", "timeout_s": timeout})
    tail = "\n".join((result.stderr or "").strip().splitlines()[-12:])
    passed = result.returncode == 0
    return _tool_text(
        {
            "status": "pass" if passed else "fail",
            "returncode": result.returncode,
            "tail": tail,
        }
    )


def _handle_socratic_frontier(args: Dict[str, Any]) -> str:
    """Inspect, add to, settle, or export the Socratic decision-tree frontier."""
    from skills.grilling.socratic_tree import (
        DecisionNode,
        DesignTree,
        frontier_transaction,
    )

    file_path = Path(
        args.get("file") or args.get("frontier_file") or ".research/frontier.json"
    )
    action = str(args.get("action") or "").strip().lower()
    node_spec = args.get("node") if isinstance(args.get("node"), dict) else {}
    objective = args.get("objective", "")

    # Authoring: add a node (tool-drivable, previously hand-written JSON only).
    # Mutations run as a locked read-modify-write so concurrent add/settle calls
    # are serialized across processes instead of racing on a bare open("w").
    if action == "add" or node_spec:
        if not node_spec.get("id") or not node_spec.get("question"):
            return _tool_text(
                {"status": "error", "message": "'node' needs 'id' and 'question'"}
            )
        with frontier_transaction(file_path, objective) as tree:
            tree.add_node(
                DecisionNode(
                    node_id=node_spec["id"],
                    title=node_spec.get("title") or node_spec["id"],
                    question=node_spec["question"],
                    recommended=node_spec.get("recommended", ""),
                    options=node_spec.get("options") or [],
                    prerequisites=node_spec.get("depends_on") or [],
                )
            )
        return _tool_text(
            {"status": "added", "node_id": node_spec["id"], "file": str(file_path)}
        )

    if action == "export":
        with frontier_transaction(file_path, objective):
            pass
        return _tool_text({"status": "exported", "file": str(file_path)})

    if args.get("settle"):
        node_id, answer = args["settle"][0], args["settle"][1]
        with frontier_transaction(file_path, objective) as tree:
            tree.settle_node(node_id, answer)
        return _tool_text(
            {"status": "settled", "node_id": node_id, "file": str(file_path)}
        )

    if not file_path.exists():
        return _tool_text(
            {
                "status": "no_frontier",
                "message": f"No frontier file at {file_path}. Run /grilling first.",
                "file": str(file_path),
            }
        )

    tree = DesignTree.load_from_json(file_path)
    frontier = tree.compute_frontier()
    return _tool_text(
        {
            "status": "frontier",
            "objective": tree.objective,
            "is_complete": tree.is_complete(),
            "total_nodes": len(tree.nodes),
            "settled": sum(1 for n in tree.nodes.values() if n.is_settled()),
            "frontier": [
                {"node_id": n.node_id, "question": n.question} for n in frontier
            ],
            "file": str(file_path),
        }
    )


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------


def build_tools() -> List[ToolSpec]:
    """The 7 canonical iumbtems_* tools, in-process wrappers only."""
    return [
        ToolSpec(
            name="iumbtems_config",
            description=(
                "Inspect or modify the active Epistemic Swarm configuration "
                "(.research/config.json). Accepts every canonical key; writes are "
                "schema-validated, locked, atomic, and preserve unknown keys. "
                "null is accepted only for nullable keys (it clears them / "
                "follows the default policy); null for a non-nullable key is "
                "rejected. Pass expected_hash (alias expectedHash; min 8 hex "
                "chars) to guard against a stale write."
            ),
            input_schema=config_tool_input_schema(),
            handler=_handle_config,
        ),
        ToolSpec(
            name="iumbtems_swarm_research",
            description="Dispatch the dialectic researcher pair (Agent Alpha thesis vs Agent Beta antithesis) with epistemic auditing. Long-running; blocks until the swarm completes.",
            input_schema={
                "type": "object",
                "properties": {
                    "objective": {
                        "type": "string",
                        "description": "Research question or objective",
                    },
                    "base_dir": {"type": "string"},
                    "frontier_file": {
                        "type": "string",
                        "description": "Settled frontier.json from grilling",
                    },
                    "engine": {
                        "type": "string",
                        "enum": ["duckduckgo", "brave", "firecrawl", "searxng"],
                    },
                    "depth": {"type": "integer"},
                    "mock_claude": {
                        "type": "boolean",
                        "description": "Synthetic run, zero API cost",
                    },
                    "backend": {
                        "type": "string",
                        "enum": ["auto", "claude", "opencode"],
                        "description": "Agent runtime backend (default auto = host-native)",
                    },
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
                    "target": {
                        "type": "string",
                        "description": "Codebase target or audit focus",
                    },
                    "base_dir": {"type": "string"},
                    "frontier_file": {
                        "type": "string",
                        "description": "Settled frontier.json from /grilling",
                    },
                    "mock_claude": {"type": "boolean"},
                    "backend": {
                        "type": "string",
                        "enum": ["auto", "claude", "opencode"],
                    },
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
                    "feature": {
                        "type": "string",
                        "description": "Feature or library to scout",
                    },
                    "base_dir": {"type": "string"},
                    "frontier_file": {
                        "type": "string",
                        "description": "Settled frontier.json from /grilling",
                    },
                    "mock_claude": {"type": "boolean"},
                    "backend": {
                        "type": "string",
                        "enum": ["auto", "claude", "opencode"],
                    },
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
                    "objective": {
                        "type": "string",
                        "description": "Ambiguous prompt to ideate on",
                    },
                    "base_dir": {"type": "string"},
                    "frontier_file": {
                        "type": "string",
                        "description": "Settled frontier.json from /grilling",
                    },
                    "mock_claude": {"type": "boolean"},
                    "backend": {
                        "type": "string",
                        "enum": ["auto", "claude", "opencode"],
                    },
                },
                "required": ["objective"],
            },
            handler=_handle_brainstorm,
        ),
        ToolSpec(
            name="iumbtems_darkharvest",
            description="Product competitor teardown: seed inspirations plus prompt, expand to adjacents, emit per-feature depend/vendor/clean-room/skip verdicts with SPDX attribution. Permissive-only vendoring; GPL/AGPL spec-rebuild only.",
            input_schema={
                "type": "object",
                "properties": {
                    "objective": {
                        "type": "string",
                        "description": "Product arena to tear down (e.g. Paseo-class agent harness competitor)",
                    },
                    "seeds": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Seed inspiration repo URLs",
                    },
                    "maxRepos": {
                        "type": "integer",
                        "description": "Cap on total competitors (default 10)",
                    },
                    "depth": {"type": "integer", "description": "Dialectic depth 1-4"},
                    "base_dir": {"type": "string"},
                    "frontier_file": {
                        "type": "string",
                        "description": "Settled frontier.json from /grilling",
                    },
                    "mock_claude": {"type": "boolean"},
                    "backend": {
                        "type": "string",
                        "enum": ["auto", "claude", "opencode"],
                    },
                },
                "required": ["objective"],
            },
            handler=_handle_darkharvest,
        ),
        ToolSpec(
            name="iumbtems_factory",
            description="Drive factory run state: init / phase-add / qa-record / expansion / stop / gate. State goes to <project>/.factory and <project>/.roadmap; no filesystem path to helper scripts required.",
            input_schema={
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "enum": [
                            "init",
                            "phase-add",
                            "qa-record",
                            "expansion",
                            "stop",
                            "gate",
                        ],
                    },
                    "action": {
                        "type": "string",
                        "enum": [
                            "open",
                            "settle",
                            "approve",
                            "waive",
                            "escalate",
                            "count",
                        ],
                        "description": "Gate action (with command: gate)",
                    },
                    "run": {"type": "string", "description": "Factory run name"},
                    "phase": {
                        "type": "string",
                        "description": "Phase id (e.g. 01-auth)",
                    },
                    "goal": {"type": "string"},
                    "accept": {
                        "type": "string",
                        "description": "Semicolon-separated acceptance criteria",
                    },
                    "seat": {"type": "string", "description": "QA seat (qa-a | qa-b)"},
                    "verdict": {
                        "type": "string",
                        "enum": ["pass", "fail", "conditional"],
                    },
                    "reason": {"type": "string"},
                    "loops": {
                        "type": "integer",
                        "description": "Expansion loop count (1-10)",
                    },
                    "max_loops": {"type": "integer"},
                    "project_dir": {
                        "type": "string",
                        "description": "Project root (default: IUMBTEMS_PROJECT_DIR or cwd)",
                    },
                },
                "required": ["command"],
            },
            handler=_handle_factory,
        ),
        ToolSpec(
            name="iumbtems_verify_quote",
            description="Audit a verbatim citation against the SHA-256 source cache (.research/sources/<hash>.md).",
            input_schema={
                "type": "object",
                "properties": {
                    "hash": {
                        "type": "string",
                        "description": "Content-addressed SHA-256 of the cached source",
                    },
                    "quote": {
                        "type": "string",
                        "description": "Verbatim quote to verify",
                    },
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
                    "base_dir": {
                        "type": "string",
                        "description": "Path to .research workspace",
                    },
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
                    "hash": {
                        "type": "string",
                        "description": "Content-addressed SHA-256 of the affected source",
                    },
                    "event": {"type": "string", "enum": ["RETRACTED", "REVISED"]},
                    "note": {
                        "type": "string",
                        "description": "Why the source was retracted/revised",
                    },
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
                    "pack": {
                        "type": "string",
                        "description": "Pack id: biopharma | quant | legal (or a path)",
                    },
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
                    "out": {
                        "type": "string",
                        "description": "Output path (default <base_dir>/brief.pcrb.json)",
                    },
                    "objective": {"type": "string"},
                    "key": {
                        "type": "string",
                        "description": "HMAC key (prefer key_file or env IUMBTEMS_PCRB_KEY)",
                    },
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
                    "brief": {
                        "type": "string",
                        "description": "Path to brief.pcrb.json",
                    },
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
                    "action": {
                        "type": "string",
                        "enum": ["inspect", "add", "settle", "export"],
                        "description": "inspect (default) | add a node | settle a node | export the file",
                    },
                    "node": {
                        "type": "object",
                        "description": "Node to add: {id, question, title?, recommended?, depends_on?[]}",
                    },
                    "settle": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Two-element [node_id, answer] to settle a frontier node",
                    },
                },
            },
            handler=_handle_socratic_frontier,
        ),
        ToolSpec(
            name="iumbtems_doctor",
            description="Preflight health check for the resolved workspace: plugin version, backend binary, search-engine reachability, and workspace writability. Run this first when anything looks wrong.",
            input_schema={
                "type": "object",
                "properties": {
                    "base_dir": {"type": "string"},
                    "mode": {"type": "string"},
                    "probe": {
                        "type": "boolean",
                        "description": "Run a live 1-query search probe (default true)",
                    },
                },
            },
            handler=_handle_doctor,
        ),
        ToolSpec(
            name="iumbtems_test",
            description="Run the packaged IUMBTEMS test suite (subprocess, timeout-bounded) and report pass/fail with the tail of the output.",
            input_schema={"type": "object", "properties": {}},
            handler=_handle_test,
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
            {
                "error": f"Tool {tool_name} not found",
                "available": [t.name for t in server.tools],
            },
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
