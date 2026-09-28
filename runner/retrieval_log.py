#!/usr/bin/env python3
"""Append-only retrieval telemetry for a research workspace.

Agents invoke the skill scripts (`skills/epistemic_search/scripts/search.py`,
`skills/research_cache/hasher.py`, `webcache.py`) as *subprocesses*, so a shared
JSONL log is the only place their retrieval activity is visible to the runner.
Without it a run that never searched looks identical to one whose cache writes
failed — the exact confusion in Heretek-AI/IUMBTEMS#3.

`.research/retrieval.jsonl`, one event per line::

    {"kind": "query", "query": "...", "results": 5, "ts": "..."}
    {"kind": "cache", "url": "...", "hash": "...", "ts": "..."}

Telemetry is best-effort: it must never break the caller.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

LOG_NAME = "retrieval.jsonl"
RESEARCH_DIR_ENV = "IUMBTEMS_RESEARCH_DIR"


def default_base_dir() -> Path:
    """Workspace for a skill subprocess: env override, else cwd/.research."""
    override = os.environ.get(RESEARCH_DIR_ENV, "").strip()
    if override:
        return Path(override)
    return Path.cwd() / ".research"


def log_path(base_dir) -> Path:
    return Path(base_dir) / LOG_NAME


def log_event(base_dir, kind: str, **fields: Any) -> None:
    """Append one telemetry event. Never raises."""
    try:
        path = log_path(base_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        event = {"kind": kind, "ts": datetime.now(timezone.utc).isoformat()}
        event.update(fields)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
    except OSError:
        pass


def current_offset(base_dir) -> int:
    """Byte offset to pass as `since` for a per-run delta."""
    try:
        return log_path(base_dir).stat().st_size
    except OSError:
        return 0


def summarize(base_dir, since: Optional[int] = None) -> Dict[str, int]:
    """Count query/cache events, optionally only those after a byte offset."""
    counts = {"queries": 0, "results": 0, "cached": 0, "events": 0}
    path = log_path(base_dir)
    if not path.exists():
        return counts
    try:
        with open(path, "r", encoding="utf-8") as f:
            if since:
                f.seek(since)
            for line in f:
                line = line.strip()
                if not line:
                    continue
                counts["events"] += 1
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get("kind") == "query":
                    counts["queries"] += 1
                    try:
                        counts["results"] += int(event.get("results") or 0)
                    except (TypeError, ValueError):
                        pass
                elif event.get("kind") == "cache":
                    counts["cached"] += 1
    except OSError:
        pass
    return counts
