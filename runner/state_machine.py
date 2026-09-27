#!/usr/bin/env python3
"""
Filesystem IPC Protocol & State Machine for Epistemic Swarm.
Manages .research/ hierarchy, session state, scope DAG, and dossier serialization.
"""

import os
import json
import threading
import tempfile
from contextlib import contextmanager
from enum import Enum
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

try:  # POSIX advisory locking; no-op where unavailable
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX
    fcntl = None


class SessionStatus(str, Enum):
    INITIALIZING = "INITIALIZING"
    FRONTIER_SETTLING = "FRONTIER_SETTLING"
    ORCHESTRATING = "ORCHESTRATING"
    SWARM_DISPATCHED = "SWARM_DISPATCHED"
    AUDITING = "AUDITING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class ScopeStatus(str, Enum):
    PENDING = "PENDING"
    ALPHA_RUNNING = "ALPHA_RUNNING"
    BETA_RUNNING = "BETA_RUNNING"
    RUNNING_PARALLEL = "RUNNING_PARALLEL"
    ALPHA_COMPLETE = "ALPHA_COMPLETE"
    BETA_COMPLETE = "BETA_COMPLETE"
    DOSSIERS_READY = "DOSSIERS_READY"
    AUDITING = "AUDITING"
    COMPLETE = "COMPLETE"
    FAILED = "FAILED"


MANIFEST_FILENAME = "manifest.json"


def manifest_name_for_mode(mode: Optional[str]) -> str:
    """Manifest filename for a run mode.

    The default research flow keeps the historical `manifest.json`; every other
    mode gets its own file so concurrently running tools (e.g. brainstorm and
    darkharvest) cannot clobber each other's scope DAG.
    """
    key = (mode or "").strip().lower()
    if key in ("", "research"):
        return MANIFEST_FILENAME
    return f"manifest.{key}.json"


def resolve_manifest_path(base_dir, mode: Optional[str] = None) -> Path:
    """Absolute manifest path for a workspace + mode."""
    base = Path(os.path.realpath(str(base_dir)))
    return base / manifest_name_for_mode(mode)


def find_any_manifest(base_dir) -> Optional[Path]:
    """Newest manifest in the workspace, preferring the canonical name.

    Lets mode-agnostic readers (e.g. PCRB export) find whichever session last
    wrote a manifest.
    """
    base = Path(os.path.realpath(str(base_dir)))
    canonical = base / MANIFEST_FILENAME
    if canonical.exists():
        return canonical
    candidates = sorted(
        base.glob("manifest.*.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


@contextmanager
def _file_lock(lock_path: Path):
    """Cross-process advisory lock over one workspace."""
    if fcntl is None:
        yield
        return
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _atomic_write_json(path: Path, data: Any) -> None:
    """Write JSON atomically via a UNIQUE temp file + os.replace.

    A fixed `*.tmp` name let concurrent writers collide on the same temp path
    (reproduced: `FileNotFoundError: manifest.tmp -> manifest.json`, 758 times
    across 4 parallel writers).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class ResearchStateMachine:
    def __init__(self, base_dir: Optional[Path] = None, mode: Optional[str] = None):
        self.base_dir = Path(os.path.realpath(str(base_dir or ".research")))
        self.scratchpads_dir = self.base_dir / "scratchpads"
        self.sources_dir = self.base_dir / "sources"
        self.manifest_file = self.base_dir / manifest_name_for_mode(mode)
        self._lock_file = self.base_dir / ".manifest.lock"
        self._lock = threading.Lock()

        # Ensure directories exist
        self.scratchpads_dir.mkdir(parents=True, exist_ok=True)
        self.sources_dir.mkdir(parents=True, exist_ok=True)

    def init_session(
        self, objective: str, session_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Initialize or reset a research session manifest."""
        sid = (
            session_id
            or f"session-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        )
        manifest = {
            "session_id": sid,
            "objective": objective,
            "status": SessionStatus.INITIALIZING.value,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "scopes": [],
            "telemetry": {
                "total_scopes": 0,
                "completed_scopes": 0,
                "total_claims_audited": 0,
                "total_verified_claims": 0,
                "total_rejected_claims": 0,
                "mean_epistemic_score": 0.0,
                "mean_divergence_score": 0.0,
            },
        }
        self.save_global_manifest(manifest)
        return manifest

    def _read_manifest_unlocked(self) -> Dict[str, Any]:
        if not self.manifest_file.exists():
            raise FileNotFoundError(
                f"Global manifest not found at {self.manifest_file}"
            )
        with open(self.manifest_file, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write_manifest_unlocked(self, manifest: Dict[str, Any]) -> None:
        manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
        _atomic_write_json(self.manifest_file, manifest)

    def load_global_manifest(self) -> Dict[str, Any]:
        with self._lock:
            return self._read_manifest_unlocked()

    def save_global_manifest(self, manifest: Dict[str, Any]):
        with self._lock, _file_lock(self._lock_file):
            self._write_manifest_unlocked(manifest)

    def update_session_status(self, status: SessionStatus):
        # Read-modify-write under the cross-process lock so a concurrent writer
        # cannot lose this update.
        with self._lock, _file_lock(self._lock_file):
            manifest = self._read_manifest_unlocked()
            manifest["status"] = status.value
            self._write_manifest_unlocked(manifest)

    def set_scopes(self, scopes: List[Dict[str, Any]]):
        """Set scopes decomposed by orchestrator and prepare scratchpads."""
        with self._lock, _file_lock(self._lock_file):
            manifest = self._read_manifest_unlocked()
            manifest["scopes"] = scopes
            manifest.setdefault("telemetry", {})["total_scopes"] = len(scopes)
            self._write_manifest_unlocked(manifest)

        for scope in scopes:
            scope_id = scope["scope_id"]
            scope_dir = self.scratchpads_dir / scope_id
            scope_dir.mkdir(parents=True, exist_ok=True)

            scope_manifest = {
                "scope_id": scope_id,
                "title": scope.get("title", ""),
                "objective": scope.get("objective", ""),
                "dependencies": scope.get("dependencies", []),
                "status": ScopeStatus.PENDING.value,
                "alpha_completed": False,
                "beta_completed": False,
                "audit_completed": False,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            _atomic_write_json(scope_dir / MANIFEST_FILENAME, scope_manifest)

    def get_scope_dir(self, scope_id: str) -> Path:
        return self.scratchpads_dir / scope_id

    def _read_scope_unlocked(self, scope_id: str) -> Dict[str, Any]:
        scope_manifest_file = self.get_scope_dir(scope_id) / MANIFEST_FILENAME
        if not scope_manifest_file.exists():
            raise FileNotFoundError(f"Scope manifest not found for {scope_id}")
        with open(scope_manifest_file, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write_scope_unlocked(self, scope_id: str, manifest: Dict[str, Any]) -> None:
        _atomic_write_json(self.get_scope_dir(scope_id) / MANIFEST_FILENAME, manifest)

    def load_scope_manifest(self, scope_id: str) -> Dict[str, Any]:
        with self._lock:
            return self._read_scope_unlocked(scope_id)

    def save_scope_manifest(self, scope_id: str, manifest: Dict[str, Any]):
        with self._lock, _file_lock(self._lock_file):
            self._write_scope_unlocked(scope_id, manifest)

    def update_scope_status(self, scope_id: str, status: ScopeStatus):
        with self._lock, _file_lock(self._lock_file):
            sm = self._read_scope_unlocked(scope_id)
            sm["status"] = status.value
            self._write_scope_unlocked(scope_id, sm)

    def record_agent_completion(
        self, scope_id: str, agent_type: str, dossier_data: Dict[str, Any]
    ):
        """Records dossier from Alpha or Beta and advances scope state machine."""
        scope_dir = self.get_scope_dir(scope_id)

        if agent_type.lower() in ["alpha", "thesis", "proponent"]:
            filename = "alpha_dossier.json"
            is_alpha = True
        elif agent_type.lower() in ["beta", "antithesis", "adversary", "red_team"]:
            filename = "beta_dossier.json"
            is_alpha = False
        else:
            raise ValueError(f"Unknown agent type: {agent_type}")

        _atomic_write_json(scope_dir / filename, dossier_data)

        # Alpha and Beta complete concurrently in separate threads: hold the lock
        # across the read-modify-write so neither loses the other's flag.
        with self._lock, _file_lock(self._lock_file):
            sm = self._read_scope_unlocked(scope_id)
            if is_alpha:
                sm["alpha_completed"] = True
            else:
                sm["beta_completed"] = True

            if sm.get("alpha_completed") and sm.get("beta_completed"):
                sm["status"] = ScopeStatus.DOSSIERS_READY.value
            elif sm.get("alpha_completed"):
                sm["status"] = ScopeStatus.ALPHA_COMPLETE.value
            elif sm.get("beta_completed"):
                sm["status"] = ScopeStatus.BETA_COMPLETE.value

            self._write_scope_unlocked(scope_id, sm)

    def get_ready_scopes(self) -> List[Dict[str, Any]]:
        """Return scopes whose dependencies are completed and status is PENDING."""
        manifest = self.load_global_manifest()
        ready = []
        completed_scope_ids = {
            s["scope_id"]
            for s in manifest["scopes"]
            if self.load_scope_manifest(s["scope_id"]).get("status")
            == ScopeStatus.COMPLETE.value
        }

        for scope in manifest["scopes"]:
            sm = self.load_scope_manifest(scope["scope_id"])
            if sm["status"] == ScopeStatus.PENDING.value:
                deps = set(scope.get("dependencies", []))
                if deps.issubset(completed_scope_ids):
                    ready.append(scope)
        return ready
