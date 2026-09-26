#!/usr/bin/env python3
"""Tests for the Stream E model-diverse adversary fleet seam.

The seam is config-first (per-agent backend/model), CLI-overridable, with env
fallback. Mock mode must NEVER build or spawn these commands.
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.research_swarm import SwarmRunner  # noqa: E402


class TestFleetSeam(unittest.TestCase):
    def test_default_backend_is_claude_with_no_model(self):
        runner = SwarmRunner(mock_mode=True, base_dir=Path("/tmp/no-such-research-dir"))
        cmd = runner.build_agent_cmd("prompt", role="alpha")
        self.assertEqual(cmd[0:2], ["claude", "-p"])
        self.assertNotIn("--model", cmd)
        self.assertIn("prompt", cmd)

    def test_model_config_adds_model_flag(self):
        runner = SwarmRunner(
            mock_mode=True,
            base_dir=Path("/tmp/no-such-research-dir"),
            agent_overrides={"alpha": {"model": "claude-opus-5"}},
        )
        cmd = runner.build_agent_cmd("prompt", role="alpha")
        self.assertIn("--model", cmd)
        self.assertEqual(cmd[cmd.index("--model") + 1], "claude-opus-5")

    def test_beta_backend_command_list(self):
        """Cross-FAMILY means non-Claude processes; backend is a cmd list."""
        runner = SwarmRunner(
            mock_mode=True,
            base_dir=Path("/tmp/no-such-research-dir"),
            agent_overrides={"beta": {"backend": ["ollama", "run", "qwen3"], "model": None}},
        )
        cmd = runner.build_agent_cmd("prompt", role="beta")
        self.assertEqual(cmd[:3], ["ollama", "run", "qwen3"])
        self.assertNotIn("--model", cmd)

    def test_roles_resolve_independently(self):
        """Asymmetry is the point: alpha and beta may use different families."""
        runner = SwarmRunner(
            mock_mode=True,
            base_dir=Path("/tmp/no-such-research-dir"),
            agent_overrides={
                "alpha": {"model": "claude-opus-5"},
                "beta": {"backend": ["codex", "exec"], "model": "gpt-5"},
            },
        )
        cmd_a = runner.build_agent_cmd("p", role="alpha")
        cmd_b = runner.build_agent_cmd("p", role="beta")
        self.assertEqual(cmd_a[0:2], ["claude", "-p"])
        self.assertIn("--model", cmd_a)
        self.assertEqual(cmd_b[:2], ["codex", "exec"])
        self.assertIn("--model", cmd_b)
        self.assertEqual(cmd_b[cmd_b.index("--model") + 1], "gpt-5")

    def test_env_fallback(self):
        with mock.patch.dict(
            os.environ,
            {"IUMBTEMS_MODEL_ALPHA": "env-model", "IUMBTEMS_BACKEND_BETA": "gemini -p"},
            clear=False,
        ):
            runner = SwarmRunner(mock_mode=True, base_dir=Path("/tmp/no-such-research-dir"))
            cmd_a = runner.build_agent_cmd("p", role="alpha")
            cmd_b = runner.build_agent_cmd("p", role="beta")
            self.assertIn("--model", cmd_a)
            self.assertEqual(cmd_a[cmd_a.index("--model") + 1], "env-model")
            self.assertEqual(cmd_b[:2], ["gemini", "-p"])

    def test_cli_overrides_beat_config(self):
        with mock.patch.dict(os.environ, {"IUMBTEMS_MODEL_ALPHA": "env-model"}, clear=False):
            runner = SwarmRunner(
                mock_mode=True,
                base_dir=Path("/tmp/no-such-research-dir"),
                agent_overrides={"alpha": {"model": "cli-model"}},
            )
            cmd = runner.build_agent_cmd("p", role="alpha")
            self.assertEqual(cmd[cmd.index("--model") + 1], "cli-model")

    def test_mock_mode_never_spawns(self):
        """mock_mode short-circuits before cmd construction."""
        runner = SwarmRunner(
            mock_mode=True,
            base_dir=Path("/tmp/no-such-research-dir"),
            agent_overrides={"alpha": {"model": "should-not-be-used"}},
        )
        with mock.patch("subprocess.run") as spawn:
            out = runner.run_claude_process("Orchestrator: build manifest.json")
            spawn.assert_not_called()
            # Canned orchestrator response is scope-decomposition JSON.
            self.assertIn("scopes", out)

    def test_system_prompt_appended_when_present(self):
        runner = SwarmRunner(mock_mode=True, base_dir=Path("/tmp/no-such-research-dir"))
        existing = PROJECT_ROOT / "prompts" / "agent_alpha_thesis.md"
        cmd = runner.build_agent_cmd("p", system_prompt_file=existing, role="alpha")
        self.assertIn("--system-prompt", cmd)
        self.assertEqual(cmd[cmd.index("--system-prompt") + 1], str(existing))


if __name__ == "__main__":
    unittest.main()
