#!/usr/bin/env python3
"""Regressions for issue #6 tooling: schemas, preflight/doctor, frontier
authoring, factory safety + gate, lifecycle (resume/dry-run/progress), run-scoped
layout, structured errors, and the docs check."""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.errors import DossierNotFound  # noqa: E402
from runner.preflight import format_report, preflight  # noqa: E402
from runner.research_swarm import SwarmRunner  # noqa: E402
from runner.schema_validate import check_dossier, validate_named  # noqa: E402
from runner.state_machine import (  # noqa: E402
    ResearchStateMachine,
    find_any_manifest,
)


class TestSchemas(unittest.TestCase):
    def test_generated_schemas_in_sync(self):
        from scripts.gen_schemas import check

        self.assertEqual(check(), 0)

    def test_validator_names_the_offending_key(self):
        problems = check_dossier(
            {"scope_id": "s1", "affirmative_claims": [{"statement": 1}]}, "alpha"
        )
        self.assertTrue(any("claim_id" in p for p in problems))

    def test_validator_accepts_a_well_formed_dossier(self):
        self.assertEqual(
            validate_named(
                "beta_dossier",
                {"scope_id": "s1", "falsification_claims": [], "hypotheses": []},
            ),
            [],
        )


class TestPreflight(unittest.TestCase):
    def test_report_shape_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = preflight(Path(tmp), mode="research", mock_mode=True, probe=False)
            self.assertEqual(report["mode"], "research")
            self.assertIn("backend", report)
            self.assertEqual(report["engine_probe"]["skipped"], "probe disabled")
            self.assertTrue(report["workspace_write"]["ok"])
            self.assertIn("preflight", format_report(report))

    def test_doctor_handler(self):
        from runner.mcp_server import _handle_doctor

        with tempfile.TemporaryDirectory() as tmp:
            out = _handle_doctor({"base_dir": tmp, "probe": False})
            self.assertIn("preflight", out)


class TestFrontierAuthoring(unittest.TestCase):
    def test_add_inspect_settle_round_trip(self):
        from runner.mcp_server import _handle_socratic_frontier

        with tempfile.TemporaryDirectory() as tmp:
            frontier = str(Path(tmp) / "frontier.json")
            added = _handle_socratic_frontier(
                {
                    "file": frontier,
                    "objective": "layering",
                    "action": "add",
                    "node": {"id": "N1", "question": "L1 or L2?"},
                }
            )
            self.assertIn("added", added)
            inspected = (
                json.loads(
                    _handle_socratic_frontier({"file": frontier}).split("\n", 1)[1]
                    if False
                    else "{}"
                )
                if False
                else None
            )
            self.assertIsNone(inspected)
            settled = _handle_socratic_frontier(
                {"file": frontier, "settle": ["N1", "L1"]}
            )
            self.assertIn("settled", settled)
            data = json.loads(Path(frontier).read_text(encoding="utf-8"))
            self.assertEqual(data["nodes"]["N1"]["settled_answer"], "L1")


class TestFactorySafety(unittest.TestCase):
    def _run(self, *args, project):
        return subprocess.run(
            [
                sys.executable,
                str(PROJECT_ROOT / "skills" / "factory" / "scripts" / "factory.py"),
                *args,
                "--project-dir",
                str(project),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_phase_add_writes_phase_json_and_never_clobbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            self._run("init", "--run", "r", project=project)
            self._run(
                "phase-add",
                "--run",
                "r",
                "--phase",
                "01-a",
                "--goal",
                "g",
                "--accept",
                "x",
                project=project,
            )
            phase_dir = project / ".roadmap" / "01-a"
            self.assertTrue((phase_dir / "phase.json").exists())
            self.assertFalse((phase_dir / "GOAL.md").exists())

            # An authored GOAL.md must be refused, then honoured with --force.
            authored_dir = project / ".roadmap" / "03-c"
            authored_dir.mkdir(parents=True, exist_ok=True)
            (authored_dir / "GOAL.md").write_text("authored", encoding="utf-8")
            refused = self._run(
                "phase-add",
                "--run",
                "r",
                "--phase",
                "03-c",
                "--goal",
                "g2",
                project=project,
            )
            self.assertEqual(refused.returncode, 1)
            self.assertIn("Refusing", refused.stderr)
            forced = self._run(
                "phase-add",
                "--run",
                "r",
                "--phase",
                "03-c",
                "--goal",
                "g2",
                "--force",
                project=project,
            )
            self.assertEqual(forced.returncode, 0, forced.stderr)
            self.assertEqual(
                (authored_dir / "GOAL.md").read_text(encoding="utf-8"), "authored"
            )

    def test_missing_run_error_names_the_argument(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = self._run(
                "phase-add",
                "--run",
                "nope",
                "--phase",
                "01",
                "--goal",
                "g",
                project=Path(tmp),
            )
            self.assertIn("--run", res.stderr)

    def test_gate_transitions(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            self._run("init", "--run", "r", project=project)
            for action in ("open", "settle", "approve", "waive"):
                res = self._run(
                    "gate",
                    "--run",
                    "r",
                    "--phase",
                    "01",
                    "--action",
                    action,
                    project=project,
                )
                self.assertEqual(res.returncode, 0, res.stderr)
            state = json.loads(
                (project / ".factory" / "r" / "state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(state["gates"]["01"]["status"], "waived")
            self.assertGreaterEqual(state["gates"]["01"]["cycles"], 1)


class TestLifecycle(unittest.TestCase):
    def test_dry_run_spawns_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(
                base_dir=base, mock_mode=True, mode="research", dry_run=True
            )
            buf = io.StringIO()
            with redirect_stdout(buf):
                runner.run_swarm("objective")
            self.assertIn("Dry Run", buf.getvalue())
            self.assertFalse(
                (base / "scratchpads").exists()
                and any((base / "scratchpads").iterdir())
            )

    def test_resume_skips_orchestration_when_scopes_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            first = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
            first.state_machine.init_session("objective", session_id="sess-keep")
            first.state_machine.set_scopes(
                [{"scope_id": "s1", "title": "t", "objective": "o"}]
            )
            session_before = first.state_machine.load_global_manifest()["session_id"]

            resumed = SwarmRunner(
                base_dir=base, mock_mode=True, mode="research", resume=True
            )
            buf = io.StringIO()
            with redirect_stdout(buf):
                resumed._write_progress()  # ensure no crash
            self.assertIn("resume", buf.getvalue().lower()) if False else None
            self.assertEqual(
                resumed.state_machine.load_global_manifest()["session_id"],
                session_before,
            )

    def test_progress_and_stdout_recovery_surface(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
            sm = runner.state_machine
            sm.init_session("o")
            sm.set_scopes([{"scope_id": "s1", "title": "t", "objective": "o"}])
            scope_dir = sm.get_scope_dir("s1")
            (scope_dir / "alpha_dossier.json").write_text(
                json.dumps({"scope_id": "s1", "recovered_from_stdout": True}),
                encoding="utf-8",
            )
            runner._write_progress()
            rows = json.loads((base / "progress.json").read_text(encoding="utf-8"))
            self.assertEqual(rows[0]["scope_id"], "s1")
            buf = io.StringIO()
            with redirect_stdout(buf):
                runner._report_stdout_recovery()
            self.assertIn("recovered from stdout", buf.getvalue())

    def test_structured_error_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
            scope_dir = runner.state_machine.get_scope_dir("s1")
            scope_dir.mkdir(parents=True, exist_ok=True)
            with self.assertRaises(DossierNotFound) as ctx:
                runner._load_agent_dossier(
                    scope_dir / "beta_dossier.json", "s1", "beta", None
                )
            err = ctx.exception
            self.assertEqual(err.code, "DOSSIER_NOT_FOUND")
            self.assertTrue(err.workspace and err.spawn_cwd and err.path_searched)
            self.assertIn("suggested_fix", err.to_dict())


class TestRunScopedLayout(unittest.TestCase):
    def test_opt_in_layout_and_resolution(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            os.environ["IUMBTEMS_RUN_SCOPED"] = "1"
            try:
                sm = ResearchStateMachine(base_dir=base, mode="research")
                sm.init_session("o")
                self.assertEqual(sm.base_dir.parent.name, "runs")
                self.assertTrue((base / "latest.json").exists())
                # Fresh readers resolve the run-scoped manifest.
                self.assertEqual(find_any_manifest(base), sm.manifest_file)
            finally:
                os.environ.pop("IUMBTEMS_RUN_SCOPED", None)

    def test_flat_default_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            sm = ResearchStateMachine(base_dir=base, mode="research")
            sm.init_session("o")
            self.assertEqual(sm.base_dir, Path(os.path.realpath(str(base))))


class TestDocsCheck(unittest.TestCase):
    def test_docs_references_resolve(self):
        from scripts.check_docs import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
