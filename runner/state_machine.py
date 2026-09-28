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
RUNS_DIRNAME = "runs"
LATEST_POINTER = "latest.json"


def run_scoped_enabled() -> bool:
    """Opt-in run-scoped layout (`.research/runs/<id>/`). Default: flat.

    The capability ships behind `IUMBTEMS_RUN_SCOPED=1` rather than flipped by
    default: it changes every artifact path and deserves a live end-to-end run
    before it becomes the default (see issue #6 item 3.9).
    """
    return os.environ.get("IUMBTEMS_RUN_SCOPED", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def latest_run_dir(workspace: Path) -> Optional[Path]:
    """The run dir a `latest.json` pointer refers to, if any."""
    try:
        data = json.loads((workspace / LATEST_POINTER).read_text(encoding="utf-8"))
        run_id = data.get("run_id")
    except (OSError, ValueError):
        return None
    if not run_id:
        return None
    candidate = workspace / RUNS_DIRNAME / str(run_id)
    return candidate if candidate.is_dir() else None


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

    Understands both layouts: flat (`manifest.json`, `manifest.<mode>.json`) and
    run-scoped (`runs/<id>/manifest*.json`, resolved via `latest.json`).
    """
    base = Path(os.path.realpath(str(base_dir)))
    candidates = []
    canonical = base / MANIFEST_FILENAME
    if canonical.exists():
        return canonical
    candidates.extend(base.glob("manifest.*.json"))

    run_dir = latest_run_dir(base)
    if run_dir is not None:
        run_manifest = run_dir / MANIFEST_FILENAME
        if run_manifest.exists():
            return run_manifest
        candidates.extend(run_dir.glob("manifest.*.json"))
    if (base / RUNS_DIRNAME).is_dir():
        candidates.extend((base / RUNS_DIRNAME).glob("*/manifest*.json"))

    existing = [c for c in candidates if c.exists()]
    if not existing:
        return None
    return max(existing, key=lambda p: p.stat().st_mtime)


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
    def __init__(
        self,
        base_dir: Optional[Path] = None,
        mode: Optional[str] = None,
        run_scoped: Optional[bool] = None,
        run_id: Optional[str] = None,
    ):
        workspace = Path(os.path.realpath(str(base_dir or ".research")))
        if run_scoped is None:
            run_scoped = run_scoped_enabled()
        self.workspace = workspace
        self.run_scoped = bool(run_scoped)
        if self.run_scoped:
            self.run_id = run_id or (
                f"{mode or 'run'}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
            )
            self.base_dir = workspace / RUNS_DIRNAME / self.run_id
        else:
            self.run_id = None
            self.base_dir = workspace
        self.scratchpads_dir = self.base_dir / "scratchpads"
        self.sources_dir = self.base_dir / "sources"
        self.manifest_file = self.base_dir / manifest_name_for_mode(mode)
        self._lock_file = self.base_dir / ".manifest.lock"
        self._lock = threading.Lock()

        # Ensure directories exist
        self.scratchpads_dir.mkdir(parents=True, exist_ok=True)
        self.sources_dir.mkdir(parents=True, exist_ok=True)
        if self.run_scoped:
            self._write_latest_pointer(mode)

    def _write_latest_pointer(self, mode: Optional[str]) -> None:
        try:
            (self.workspace / LATEST_POINTER).write_text(
                json.dumps({"run_id": self.run_id, "mode": mode}), encoding="utf-8"
            )
        except OSError:
            pass

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

    def record_preflight(
        self, report: Dict[str, Any], backend: Optional[str] = None
    ) -> None:
        """Persist the preflight report + plugin version into the manifest."""
        with self._lock, _file_lock(self._lock_file):
            try:
                manifest = self._read_manifest_unlocked()
            except FileNotFoundError:
                # Dry runs / pre-orchestration: keep the report rather than fail.
                manifest = {"preflight": report}
            manifest["preflight"] = report
            version = report.get("plugin_version")
            if version:
                manifest["plugin_version"] = version
            if backend:
                manifest["backend"] = backend
            self._write_manifest_unlocked(manifest)

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

    def find_orphan_scopes(self) -> List[Dict[str, Any]]:
        """Scope dirs not referenced by any manifest — marked, never deleted.

        A dir may belong to a concurrently running session, so this reports
        rather than prunes (issue #5 layer 6: 14 manifest-only leftovers).
        """
        referenced: set = set()
        manifests = [self.manifest_file, *self.base_dir.glob("manifest.*.json")]
        for manifest_path in manifests:
            if not manifest_path.exists():
                continue
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            for scope in data.get("scopes") or []:
                if isinstance(scope, dict) and scope.get("scope_id"):
                    referenced.add(scope["scope_id"])

        orphans: List[Dict[str, Any]] = []
        if not self.scratchpads_dir.is_dir():
            return orphans
        for scope_dir in sorted(self.scratchpads_dir.iterdir()):
            if not scope_dir.is_dir() or scope_dir.name in referenced:
                continue
            orphans.append(
                {
                    "scope_id": scope_dir.name,
                    "path": str(scope_dir),
                    "alpha_dossier": (scope_dir / "alpha_dossier.json").exists(),
                    "beta_dossier": (scope_dir / "beta_dossier.json").exists(),
                }
            )
        return orphans

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
        elif agent_type.lower() in ["beta", "antithesis", "adversary", "red_team"]:
            filename = "beta_dossier.json"
        else:
            raise ValueError(f"Unknown agent type: {agent_type}")

        _atomic_write_json(scope_dir / filename, dossier_data)
        self.reconcile_scope_status(scope_id)

    def _artifacts_complete(self, scope_id: str) -> tuple:
        """(alpha, beta) dossier presence, derived from disk — never from stored flags."""
        scope_dir = self.get_scope_dir(scope_id)
        return (
            (scope_dir / "alpha_dossier.json").exists(),
            (scope_dir / "beta_dossier.json").exists(),
        )

    def reconcile_scope_status(self, scope_id: str) -> Dict[str, Any]:
        """Recompute completion flags + status from dossier artifacts on disk.

        The scope manifest is runner-owned, but agents can write to the workspace
        and have forged `beta_completed: true` / `DOSSIERS_READY` without emitting
        the dossier. Deriving from files means stored booleans can never disagree
        with reality.
        """
        alpha, beta = self._artifacts_complete(scope_id)
        with self._lock, _file_lock(self._lock_file):
            sm = self._read_scope_unlocked(scope_id)
            sm["alpha_completed"] = alpha
            sm["beta_completed"] = beta
            if sm.get("audit_completed"):
                sm["status"] = ScopeStatus.COMPLETE.value
            elif alpha and beta:
                sm["status"] = ScopeStatus.DOSSIERS_READY.value
            elif alpha:
                sm["status"] = ScopeStatus.ALPHA_COMPLETE.value
            elif beta:
                sm["status"] = ScopeStatus.BETA_COMPLETE.value
            elif sm.get("status") not in (
                ScopeStatus.RUNNING_PARALLEL.value,
                ScopeStatus.AUDITING.value,
            ):
                sm["status"] = ScopeStatus.PENDING.value
            self._write_scope_unlocked(scope_id, sm)
        return sm

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
