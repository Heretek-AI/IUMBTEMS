#!/usr/bin/env python3
"""Dossier-contract + derived-status regressions.

Reproduced live (#1 retest on 0.7.10, brainstorm mode): the loader required
`beta_dossier.json`, the shared brainstorm prompt only ever named the
alpha-compatible dossier, so Beta emitted `brainstorm_dossier.json` and the run
aborted — while the scope manifest (written by the agent) claimed
`DOSSIERS_READY`. These tests pin both halves: an explicit role contract plus a
tolerant loader, and status derived from artifacts rather than stored booleans.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.research_swarm import SwarmRunner  # noqa: E402
from runner.state_machine import ResearchStateMachine, ScopeStatus  # noqa: E402


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


class TestRoleOutputContract(unittest.TestCase):
    def _runner(self, base: Path, mode: str = "brainstorm") -> SwarmRunner:
        return SwarmRunner(base_dir=base, mock_mode=True, mode=mode)

    def test_prompt_names_role_dossier_and_bans_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = self._runner(base)
            scope = {"scope_id": "s1", "title": "t", "objective": "o"}

            alpha = runner._scope_prompt("Alpha", scope, "s1")
            beta = runner._scope_prompt("Beta", scope, "s1")

            self.assertIn(
                str(runner.state_machine.get_scope_dir("s1") / "alpha_dossier.json"),
                alpha,
            )
            self.assertIn(
                str(runner.state_machine.get_scope_dir("s1") / "beta_dossier.json"),
                beta,
            )
            self.assertNotIn("beta_dossier.json", alpha)
            for text in (alpha, beta):
                self.assertIn("manifest.json", text)
                self.assertIn("runner-owned", text)


class TestTolerantLoader(unittest.TestCase):
    def test_alias_is_loaded_and_normalized(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="brainstorm")
            scope_dir = runner.state_machine.get_scope_dir("s1")
            _write_json(
                scope_dir / "brainstorm_dossier.json", {"scope_id": "s1", "claims": []}
            )

            data = runner._load_agent_dossier(
                scope_dir / "beta_dossier.json",
                "s1",
                "beta",
                None,
                aliases=("brainstorm_dossier.json",),
            )
            self.assertEqual(data["scope_id"], "s1")
            self.assertEqual(data["renamed_from"], "brainstorm_dossier.json")
            self.assertTrue((scope_dir / "beta_dossier.json").exists())

    def test_manifest_outputs_are_consulted(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="brainstorm")
            scope_dir = runner.state_machine.get_scope_dir("s1")
            _write_json(scope_dir / "weird_name.json", {"scope_id": "s1", "claims": []})
            _write_json(
                scope_dir / "manifest.json",
                {"scope_id": "s1", "outputs": ["weird_name.json"]},
            )

            data = runner._load_agent_dossier(
                scope_dir / "beta_dossier.json", "s1", "beta", None
            )
            self.assertEqual(data["scope_id"], "s1")
            self.assertTrue((scope_dir / "beta_dossier.json").exists())

    def test_non_dossier_json_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="brainstorm")
            scope_dir = runner.state_machine.get_scope_dir("s1")
            # domain_model.json has no scope_id and must never be taken as a dossier.
            _write_json(scope_dir / "manifest.json", {"outputs": ["domain_model.json"]})
            _write_json(scope_dir / "domain_model.json", {"entities": ["a"]})

            with self.assertRaises(FileNotFoundError):
                runner._load_agent_dossier(
                    scope_dir / "beta_dossier.json", "s1", "beta", None
                )


class TestDerivedStatus(unittest.TestCase):
    def test_forged_manifest_cannot_report_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            sm = ResearchStateMachine(base_dir=base)
            sm.init_session("x")
            sm.set_scopes([{"scope_id": "s1", "title": "t", "objective": "o"}])
            scope_dir = sm.get_scope_dir("s1")

            # Agent pretends both dossiers exist.
            _write_json(
                scope_dir / "manifest.json",
                {
                    "scope_id": "s1",
                    "status": ScopeStatus.DOSSIERS_READY.value,
                    "alpha_completed": True,
                    "beta_completed": True,
                },
            )
            sm.reconcile_scope_status("s1")
            sm_after = sm.load_scope_manifest("s1")
            self.assertFalse(sm_after["alpha_completed"])
            self.assertFalse(sm_after["beta_completed"])
            self.assertNotEqual(sm_after["status"], ScopeStatus.DOSSIERS_READY.value)

    def test_status_derives_from_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            sm = ResearchStateMachine(base_dir=base)
            sm.init_session("x")
            sm.set_scopes([{"scope_id": "s1", "title": "t", "objective": "o"}])
            scope_dir = sm.get_scope_dir("s1")

            sm.record_agent_completion("s1", "alpha", {"scope_id": "s1", "claims": []})
            self.assertEqual(
                sm.load_scope_manifest("s1")["status"], ScopeStatus.ALPHA_COMPLETE.value
            )

            sm.record_agent_completion("s1", "beta", {"scope_id": "s1", "claims": []})
            after = sm.load_scope_manifest("s1")
            self.assertEqual(after["status"], ScopeStatus.DOSSIERS_READY.value)
            self.assertTrue(after["alpha_completed"] and after["beta_completed"])

            # audit completion survives reconciliation
            after["audit_completed"] = True
            sm.save_scope_manifest("s1", after)
            self.assertEqual(
                sm.reconcile_scope_status("s1")["status"], ScopeStatus.COMPLETE.value
            )
            self.assertTrue(scope_dir.exists())


class TestScopedAlternateScan(unittest.TestCase):
    def test_only_same_scope_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            alt = project / "alt"
            base = project / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")

            # Different scope holds the same filename.
            _write_json(
                alt / ".research" / "scratchpads" / "scope_other" / "beta_dossier.json",
                {"scope_id": "scope_other"},
            )
            with mock.patch.dict(os.environ, {"PWD": str(alt)}, clear=False):
                self.assertIsNone(
                    runner._locate_dossier_elsewhere("scope_mine", "beta_dossier.json")
                )

            # Same scope in the alternate workspace is reported.
            target = (
                alt / ".research" / "scratchpads" / "scope_mine" / "beta_dossier.json"
            )
            _write_json(target, {"scope_id": "scope_mine"})
            with mock.patch.dict(os.environ, {"PWD": str(alt)}, clear=False):
                self.assertEqual(
                    runner._locate_dossier_elsewhere("scope_mine", "beta_dossier.json"),
                    target,
                )


if __name__ == "__main__":
    unittest.main()
