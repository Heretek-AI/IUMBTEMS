#!/usr/bin/env python3
"""Preflight / doctor report for a run (Heretek-AI/IUMBTEMS#6 item 3.2).

The plugin knows things the agent currently has to rediscover: which workspace
resolves, which manifest filename is in play, which backend binary will actually
spawn, and whether the search engine works right now. This reports all of it in
one place, prints it at run start, records it in the manifest, and backs the
`iumbtems_doctor` MCP tool.

Everything here is best-effort and offline-safe: the search probe is
timeout-bounded and can be skipped, and no failure raises.
"""

import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_PROBE_QUERY = "iumbtems preflight probe"


def plugin_version() -> Optional[str]:
    try:
        return json.loads(
            (PROJECT_ROOT / "package.json").read_text(encoding="utf-8")
        ).get("version")
    except (OSError, ValueError):
        return None


_plugin_version = plugin_version  # backwards-compatible alias


def _backend_report(base_dir: Path, mock_mode: bool) -> Dict[str, Any]:
    try:
        from runner.research_swarm import (
            SwarmRunner,  # noqa: F401  (ensures module import side effects)
            _default_backend_cmd,
            _opencode_auto,
        )

        runner = SwarmRunner(base_dir=base_dir, mock_mode=mock_mode, mode="research")
        backend, model = runner._resolve_agent_backend("alpha")
        family = backend[0] if backend else "?"
        resolved = shutil.which(family) or family
        return {
            "family": family,
            "argv": backend,
            "model": model,
            "binary": resolved,
            "binary_found": bool(shutil.which(family)),
            "opencode_auto": _opencode_auto(runner.config),
            "default_auto": _default_backend_cmd("auto"),
        }
    except Exception as exc:  # noqa: BLE001 - doctor must never raise
        return {"error": str(exc)}


def _engine_probe(engine: str, probe: bool, timeout: float) -> Dict[str, Any]:
    if not probe:
        return {"skipped": "probe disabled"}
    if engine != "duckduckgo":
        return {"skipped": f"no zero-key probe for engine '{engine}'"}
    try:
        sys.path.insert(
            0, str(PROJECT_ROOT / "skills" / "epistemic_search" / "scripts")
        )
        import search  # noqa: PLC0415

        results = search.search_duckduckgo(DEFAULT_PROBE_QUERY, max_results=3)
        return {"ok": bool(results), "results": len(results)}
    except Exception as exc:  # noqa: BLE001 - network/offline is not an error
        return {"ok": False, "error": str(exc)}


def _scratchpad_write_test(base_dir: Path) -> Dict[str, Any]:
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
        probe = base_dir / ".preflight-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return {"ok": True, "path": str(base_dir)}
    except OSError as exc:
        return {"ok": False, "path": str(base_dir), "error": str(exc)}


def preflight(
    base_dir: Path,
    mode: str = "research",
    config: Optional[Dict[str, Any]] = None,
    mock_mode: bool = False,
    probe: bool = True,
    timeout: float = 5.0,
) -> Dict[str, Any]:
    """Assemble the preflight report. Never raises."""
    config = config or {}
    engine = str(config.get("search_engine") or "duckduckgo")
    report: Dict[str, Any] = {
        "plugin_version": _plugin_version(),
        "python": sys.version.split()[0],
        "node": shutil.which("node") or None,
        "mode": mode,
        "workspace": str(base_dir),
        "manifest": None,
        "project_dir": os.environ.get("IUMBTEMS_PROJECT_DIR") or None,
        "cwd": os.getcwd(),
        "pwd": os.environ.get("PWD") or None,
        "engine": engine,
        "warnings": [],
    }
    try:
        from runner.state_machine import manifest_name_for_mode

        report["manifest"] = manifest_name_for_mode(mode)
    except Exception:  # noqa: BLE001
        pass

    report["backend"] = _backend_report(base_dir, mock_mode)
    report["engine_probe"] = _engine_probe(engine, probe, timeout)
    report["workspace_write"] = _scratchpad_write_test(base_dir)

    if report["backend"].get("binary_found") is False and not mock_mode:
        report["warnings"].append(
            f"backend binary '{report['backend'].get('family')}' not found on PATH"
        )
    if report["engine_probe"].get("ok") is False:
        report["warnings"].append("search engine probe returned no results")
    if report["workspace_write"].get("ok") is False:
        report["warnings"].append("workspace is not writable")
    return report


def format_report(report: Dict[str, Any]) -> str:
    backend = report.get("backend", {})
    probe = report.get("engine_probe", {})
    probe_txt = (
        f"{probe.get('results')} results"
        if probe.get("ok")
        else probe.get("skipped") or f"FAILED ({probe.get('error', '?')})"
    )
    lines = [
        f"iumbtems preflight: v{report.get('plugin_version')} | mode={report.get('mode')}",
        f"  workspace : {report.get('workspace')} | manifest: {report.get('manifest')}",
        f"  spawn cwd : {report.get('cwd')} | PWD: {report.get('pwd')}",
        f"  backend   : {backend.get('family')} ({backend.get('binary')})"
        f"{'' if backend.get('binary_found') else '  ⚠️ NOT FOUND'}"
        f"{' | --auto' if backend.get('opencode_auto') else ''}",
        f"  engine    : {report.get('engine')} -> {probe_txt}",
        f"  write test: {'ok' if report.get('workspace_write', {}).get('ok') else 'FAILED'}",
    ]
    for warning in report.get("warnings", []):
        lines.append(f"  ⚠️ {warning}")
    return "\n".join(lines)
