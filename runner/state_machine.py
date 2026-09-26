#!/usr/bin/env python3
"""
Filesystem IPC Protocol & State Machine for Epistemic Swarm.
Manages .research/ hierarchy, session state, scope DAG, and dossier serialization.
"""

import os
import json
import threading
import tempfile
from enum import Enum
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

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

class ResearchStateMachine:
    def __init__(self, base_dir: Optional[Path] = None):
        self.base_dir = base_dir or Path(".research")
        self.scratchpads_dir = self.base_dir / "scratchpads"
        self.sources_dir = self.base_dir / "sources"
        self.manifest_file = self.base_dir / "manifest.json"
        self._lock = threading.Lock()
        
        # Ensure directories exist
        self.scratchpads_dir.mkdir(parents=True, exist_ok=True)
        self.sources_dir.mkdir(parents=True, exist_ok=True)

    def init_session(self, objective: str, session_id: Optional[str] = None) -> Dict[str, Any]:
        """Initialize or reset a research session manifest."""
        sid = session_id or f"session-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
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
                "mean_divergence_score": 0.0
            }
        }
        self.save_global_manifest(manifest)
        return manifest

    def load_global_manifest(self) -> Dict[str, Any]:
        with self._lock:
            if not self.manifest_file.exists():
                raise FileNotFoundError(f"Global manifest not found at {self.manifest_file}")
            with open(self.manifest_file, "r", encoding="utf-8") as f:
                return json.load(f)

    def save_global_manifest(self, manifest: Dict[str, Any]):
        with self._lock:
            manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
            temp_path = self.manifest_file.with_suffix(".tmp")
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2)
            os.replace(temp_path, self.manifest_file)

    def update_session_status(self, status: SessionStatus):
        manifest = self.load_global_manifest()
        manifest["status"] = status.value
        self.save_global_manifest(manifest)

    def set_scopes(self, scopes: List[Dict[str, Any]]):
        """Set scopes decomposed by orchestrator and prepare scratchpads."""
        manifest = self.load_global_manifest()
        manifest["scopes"] = scopes
        manifest["telemetry"]["total_scopes"] = len(scopes)
        self.save_global_manifest(manifest)

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
                "created_at": datetime.now(timezone.utc).isoformat()
            }
            temp_scope_file = (scope_dir / "manifest.json").with_suffix(".tmp")
            with open(temp_scope_file, "w", encoding="utf-8") as f:
                json.dump(scope_manifest, f, indent=2)
            os.replace(temp_scope_file, scope_dir / "manifest.json")

    def get_scope_dir(self, scope_id: str) -> Path:
        return self.scratchpads_dir / scope_id

    def load_scope_manifest(self, scope_id: str) -> Dict[str, Any]:
        with self._lock:
            scope_manifest_file = self.get_scope_dir(scope_id) / "manifest.json"
            if not scope_manifest_file.exists():
                raise FileNotFoundError(f"Scope manifest not found for {scope_id}")
            with open(scope_manifest_file, "r", encoding="utf-8") as f:
                return json.load(f)

    def save_scope_manifest(self, scope_id: str, manifest: Dict[str, Any]):
        with self._lock:
            scope_manifest_file = self.get_scope_dir(scope_id) / "manifest.json"
            temp_path = scope_manifest_file.with_suffix(".tmp")
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2)
            os.replace(temp_path, scope_manifest_file)

    def update_scope_status(self, scope_id: str, status: ScopeStatus):
        sm = self.load_scope_manifest(scope_id)
        sm["status"] = status.value
        self.save_scope_manifest(scope_id, sm)

    def record_agent_completion(self, scope_id: str, agent_type: str, dossier_data: Dict[str, Any]):
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

        temp_dossier = (scope_dir / filename).with_suffix(".tmp")
        with open(temp_dossier, "w", encoding="utf-8") as f:
            json.dump(dossier_data, f, indent=2)
        os.replace(temp_dossier, scope_dir / filename)

        sm = self.load_scope_manifest(scope_id)
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

        self.save_scope_manifest(scope_id, sm)

    def get_ready_scopes(self) -> List[Dict[str, Any]]:
        """Return scopes whose dependencies are completed and status is PENDING."""
        manifest = self.load_global_manifest()
        ready = []
        completed_scope_ids = {
            s["scope_id"] for s in manifest["scopes"] 
            if self.load_scope_manifest(s["scope_id"]).get("status") == ScopeStatus.COMPLETE.value
        }

        for scope in manifest["scopes"]:
            sm = self.load_scope_manifest(scope["scope_id"])
            if sm["status"] == ScopeStatus.PENDING.value:
                deps = set(scope.get("dependencies", []))
                if deps.issubset(completed_scope_ids):
                    ready.append(scope)
        return ready
