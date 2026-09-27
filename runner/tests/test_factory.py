#!/usr/bin/env python3
"""Tests for the factory loop: run-state helper, QA retry bounds, plugin surface."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def run_node(code):
    return subprocess.run(
        ["node", "--input-type=module", "-e", code],
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
    )


def last_json_object(stdout):
    lines = [l.strip() for l in stdout.strip().split("\n") if l.strip().startswith("{")]
    return json.loads(lines[-1])


class TestFactoryHelper(unittest.TestCase):
    def test_qa_retry_escalates_after_three(self):
        import shutil

        with tempfile.TemporaryDirectory() as tmp:
            # Redirect factory state + roadmap into tmp via cwd-independent paths:
            # factory.py anchors to PROJECT_ROOT, so sandbox by copying is
            # overkill — exercise the pure bound logic through CLI on a run
            # name, then clean up the created dirs.
            run = "test-escalation-run"
            try:
                subprocess.run(
                    [
                        sys.executable,
                        "skills/factory/scripts/factory.py",
                        "init",
                        "--run",
                        run,
                    ],
                    check=True,
                    capture_output=True,
                    cwd=str(PROJECT_ROOT),
                )
                subprocess.run(
                    [
                        sys.executable,
                        "skills/factory/scripts/factory.py",
                        "phase-add",
                        "--run",
                        run,
                        "--phase",
                        "01-x",
                        "--goal",
                        "g",
                        "--accept",
                        "a",
                    ],
                    check=True,
                    capture_output=True,
                    cwd=str(PROJECT_ROOT),
                )
                codes = []
                for _ in range(3):
                    r = subprocess.run(
                        [
                            sys.executable,
                            "skills/factory/scripts/factory.py",
                            "qa-record",
                            "--run",
                            run,
                            "--phase",
                            "01-x",
                            "--seat",
                            "qa-a",
                            "--verdict",
                            "fail",
                            "--reason",
                            "t",
                        ],
                        capture_output=True,
                        cwd=str(PROJECT_ROOT),
                    )
                    codes.append(r.returncode)
                self.assertEqual(codes, [0, 0, 2])  # 3rd failure escalates
                state = json.loads(
                    (PROJECT_ROOT / ".factory" / run / "state.json").read_text()
                )
                self.assertEqual(state["phases"]["01-x"]["status"], "escalated")
            finally:
                shutil.rmtree(PROJECT_ROOT / ".factory" / run, ignore_errors=True)
                shutil.rmtree(PROJECT_ROOT / ".roadmap" / "01-x", ignore_errors=True)

    def test_expansion_respects_stop_file(self):
        import shutil

        run = "test-expansion-run"
        try:
            subprocess.run(
                [
                    sys.executable,
                    "skills/factory/scripts/factory.py",
                    "init",
                    "--run",
                    run,
                ],
                check=True,
                capture_output=True,
                cwd=str(PROJECT_ROOT),
            )
            subprocess.run(
                [
                    sys.executable,
                    "skills/factory/scripts/factory.py",
                    "stop",
                    "--run",
                    run,
                ],
                check=True,
                capture_output=True,
                cwd=str(PROJECT_ROOT),
            )
            r = subprocess.run(
                [
                    sys.executable,
                    "skills/factory/scripts/factory.py",
                    "expansion",
                    "--run",
                    run,
                    "--loops",
                    "10",
                ],
                capture_output=True,
                text=True,
                cwd=str(PROJECT_ROOT),
            )
            self.assertEqual(r.returncode, 0)
            self.assertIn("halting after 0/10", r.stdout)
        finally:
            shutil.rmtree(PROJECT_ROOT / ".factory" / run, ignore_errors=True)

    def test_skill_and_commands_exist(self):
        self.assertTrue((PROJECT_ROOT / "skills" / "factory" / "SKILL.md").exists())
        self.assertTrue(
            (PROJECT_ROOT / "skills" / "factory" / "scripts" / "factory.py").exists()
        )
        self.assertTrue((PROJECT_ROOT / ".omp" / "commands" / "factory.md").exists())
        self.assertTrue(
            (PROJECT_ROOT / ".omp" / "commands" / "domainexpansion.md").exists()
        )
        self.assertTrue(
            (PROJECT_ROOT / "plugins" / "gemini" / "commands" / "factory.toml").exists()
        )
        with open(PROJECT_ROOT / "package.json") as f:
            pkg = json.load(f)
        self.assertIn("./skills/factory", pkg["pi"]["skills"])
        self.assertIn("./skills/factory", pkg["omp"]["skills"])

    def test_snippet_factory_roster(self):
        with open(PROJECT_ROOT / "config" / "opencode-snippet.json") as f:
            snippet = json.load(f)
        for agent in ("manager", "programmer", "qa-a", "qa-b"):
            self.assertIn(agent, snippet["agent"])
        manager = snippet["agent"]["manager"]
        self.assertEqual(manager["mode"], "primary")
        task = manager["permission"]["task"]
        self.assertEqual(task["*"], "deny")
        for allowed in ("programmer", "qa-a", "qa-b", "brainstormer", "darkharvester"):
            self.assertEqual(task[allowed], "allow")
        self.assertEqual(snippet["agent"]["qa-a"]["permission"]["edit"], "deny")
        self.assertEqual(snippet["agent"]["qa-b"]["permission"]["edit"], "deny")

    def test_factory_commands_carry_agent_subtask(self):
        res = run_node(
            """
            import { OPENCODE_COMMANDS, commandCatalog } from "./plugins/opencode/index.js";
            const catalog = commandCatalog();
            console.log(JSON.stringify({
              factory: catalog.factory, expansion: catalog.domainexpansion
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        data = last_json_object(res.stdout)
        self.assertEqual(data["factory"]["agent"], "manager")
        self.assertIn("$ARGUMENTS", data["factory"]["template"])
        self.assertEqual(data["expansion"]["agent"], "manager")


if __name__ == "__main__":
    unittest.main()
