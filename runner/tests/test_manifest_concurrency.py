#!/usr/bin/env python3
"""Manifest concurrency + workspace-diagnostics regressions.

Reproduced live: four processes doing read-modify-write on the shared manifest
produced 758 `FileNotFoundError: manifest.tmp -> manifest.json` failures, because
every writer used the same fixed temp name and only an in-process lock. Also
covers per-mode manifests (concurrent brainstorm + darkharvest clobbering) and the
diagnostics that make a workspace mismatch self-reporting.
"""

import json
import multiprocessing as mp
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.research_swarm import SwarmRunner  # noqa: E402
from runner.state_machine import (  # noqa: E402
    ResearchStateMachine,
    ScopeStatus,
    SessionStatus,
    find_any_manifest,
    manifest_name_for_mode,
    resolve_manifest_path,
)


def _hammer(base_dir: str, n: int, iterations: int) -> int:
    sm = ResearchStateMachine(base_dir=Path(base_dir))
    errors = 0
    for i in range(iterations):
        try:
            sm.update_session_status(SessionStatus.AUDITING)
            sm.set_scopes(
                [
                    {
                        "scope_id": f"s{n}_{i}",
                        "title": "t",
                        "objective": "o",
                        "dependencies": [],
                    }
                ]
            )
        except Exception:
            errors += 1
    return errors


class TestManifestConcurrency(unittest.TestCase):
    def test_parallel_processes_never_collide_on_temp(self):
        """Four processes hammering the manifest must not raise or corrupt."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True)
            ResearchStateMachine(base_dir=base).init_session("race")

            with mp.Pool(4) as pool:
                results = pool.starmap(_hammer, [(str(base), n, 60) for n in range(4)])

            self.assertEqual(sum(results), 0, f"writers raised {sum(results)} times")
            # Manifest is still valid JSON without a stray temp file.
            manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
            self.assertIn("scopes", manifest)
            self.assertEqual(list(base.glob("manifest.*.tmp")), [])

    def test_alpha_beta_completion_is_not_lost(self):
        """Alpha and Beta complete concurrently; both flags must survive."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            sm = ResearchStateMachine(base_dir=base)
            sm.init_session("dossier race")
            sm.set_scopes([{"scope_id": "s1", "title": "t", "objective": "o"}])

            dossier = {"scope_id": "s1", "claims": []}
            threads = [
                threading.Thread(
                    target=sm.record_agent_completion, args=("s1", role, dossier)
                )
                for role in ("alpha", "beta")
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            sm_scope = sm.load_scope_manifest("s1")
            self.assertTrue(sm_scope["alpha_completed"])
            self.assertTrue(sm_scope["beta_completed"])
            self.assertEqual(sm_scope["status"], ScopeStatus.DOSSIERS_READY.value)


class TestPerModeManifests(unittest.TestCase):
    def test_default_and_research_share_canonical_name(self):
        self.assertEqual(manifest_name_for_mode(None), "manifest.json")
        self.assertEqual(manifest_name_for_mode("research"), "manifest.json")

    def test_non_research_modes_are_isolated(self):
        self.assertEqual(
            manifest_name_for_mode("brainstorm"), "manifest.brainstorm.json"
        )
        self.assertEqual(
            manifest_name_for_mode("darkharvest"), "manifest.darkharvest.json"
        )

    def test_concurrent_modes_do_not_clobber(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            brainstorm = ResearchStateMachine(base_dir=base, mode="brainstorm")
            darkharvest = ResearchStateMachine(base_dir=base, mode="darkharvest")
            brainstorm.init_session("one")
            darkharvest.init_session("two")
            brainstorm.set_scopes([{"scope_id": "b1", "title": "t", "objective": "o"}])
            darkharvest.set_scopes(
                [
                    {"scope_id": "d1", "title": "t", "objective": "o"},
                    {"scope_id": "d2", "title": "t", "objective": "o"},
                ]
            )
            self.assertEqual(len(brainstorm.load_global_manifest()["scopes"]), 1)
            self.assertEqual(len(darkharvest.load_global_manifest()["scopes"]), 2)
            self.assertNotEqual(brainstorm.manifest_file, darkharvest.manifest_file)

    def test_find_any_manifest_prefers_canonical_then_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True)
            ResearchStateMachine(base_dir=base, mode="darkharvest").init_session("d")
            found = find_any_manifest(base)
            self.assertIsNotNone(found)
            self.assertEqual(found.name, "manifest.darkharvest.json")

            ResearchStateMachine(base_dir=base).init_session("r")
            self.assertEqual(find_any_manifest(base).name, "manifest.json")
            self.assertEqual(
                resolve_manifest_path(base, "darkharvest").name,
                "manifest.darkharvest.json",
            )


class TestWorkspaceDiagnostics(unittest.TestCase):
    def _runner(self, env_dir: Path) -> SwarmRunner:
        with mock.patch.dict(os.environ, {"IUMBTEMS_PROJECT_DIR": str(env_dir)}):
            return SwarmRunner(
                base_dir=env_dir / ".research", mock_mode=True, mode="research"
            )

    def test_missing_dossier_message_names_workspace_and_alternate(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            alt = project / "alt"
            scope_alt = alt / ".research" / "scratchpads" / "s1"
            scope_alt.mkdir(parents=True)
            (scope_alt / "alpha_dossier.json").write_text("{}", encoding="utf-8")

            runner = self._runner(project)
            searched = (
                project / ".research" / "scratchpads" / "s1" / "alpha_dossier.json"
            )
            with mock.patch.dict(os.environ, {"PWD": str(alt)}):
                msg = runner._dossier_missing_message(searched, "s1", "alpha")
            self.assertIn(str(searched), msg)
            self.assertIn("runner workspace", msg)
            self.assertIn("FOUND A COPY ELSEWHERE", msg)
            self.assertIn(str(scope_alt / "alpha_dossier.json"), msg)

    def test_permission_failure_hint_only_for_permission_errors(self):
        runner = SwarmRunner(
            base_dir=Path(tempfile.mkdtemp()), mock_mode=True, mode="research"
        )
        self.assertEqual(runner._permission_failure_hint("boom"), "")
        hint = runner._permission_failure_hint(
            "! permission requested: external_directory (/x/.research/...) ; auto-rejecting"
        )
        self.assertIn("auto-rejected", hint)
        self.assertIn("IUMBTEMS_OPENCODE_AUTO", hint)


if __name__ == "__main__":
    unittest.main()
