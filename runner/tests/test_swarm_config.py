#!/usr/bin/env python3
"""Config-merge and agent-spawn regressions.

Covers two live failures observed on an OpenCode host running the installed
package against an operator project:

1. A pre-0.7.6 config persisted `agents.<role>.backend = ["claude", "-p"]`.
   The shallow merge in `load_config` preserved it and it out-ranked the
   host-native default, so an OpenCode host silently spawned Claude.
2. Agents were spawned with `cwd=PROJECT_ROOT` (the installed package) while
   evidence lives in the project's `.research/`, so prompt-mandated relative
   writes landed inside node_modules and were denied.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.research_swarm import (  # noqa: E402
    PROJECT_ROOT as PACKAGE_ROOT,
    SwarmRunner,
    _agent_cwd,
)
from skills.swarm_config.configure import (  # noqa: E402
    DEFAULT_CONFIG,
    heal_config,
    load_config,
    migrate_legacy_agent_backends,
    save_config,
)


def _write_config(base_dir: Path, payload: dict) -> Path:
    base_dir.mkdir(parents=True, exist_ok=True)
    cfg_file = base_dir / "config.json"
    cfg_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return cfg_file


class TestLegacyAgentPinMigration(unittest.TestCase):
    def test_legacy_pin_is_dropped_when_backend_is_auto(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            _write_config(
                base,
                {
                    "backend": "auto",
                    "agents": {
                        "alpha": {"backend": ["claude", "-p"], "model": None},
                        "beta": {"backend": ["claude", "-p"], "model": None},
                    },
                },
            )
            cfg = load_config(str(base))
            self.assertIsNone(cfg["agents"]["alpha"]["backend"])
            self.assertIsNone(cfg["agents"]["beta"]["backend"])

    def test_legacy_pin_no_longer_forces_claude_on_opencode_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            _write_config(
                base,
                {
                    "backend": "auto",
                    "agents": {
                        "alpha": {"backend": ["claude", "-p"], "model": None},
                        "beta": {"backend": ["claude", "-p"], "model": None},
                    },
                },
            )
            with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
                runner = SwarmRunner(base_dir=base, mock_mode=True, mode="darkharvest")
                cmd = runner.build_agent_cmd("objective", role="alpha")
            self.assertEqual(cmd[:2], ["opencode", "run"])

    def test_explicit_claude_choice_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            _write_config(
                base,
                {
                    "backend": "claude",
                    "agents": {
                        "alpha": {"backend": ["claude", "-p"], "model": None},
                        "beta": {"backend": ["claude", "-p"], "model": None},
                    },
                },
            )
            with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
                runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
                with redirect_stderr(io.StringIO()):
                    cmd = runner.build_agent_cmd("objective", role="alpha")
            self.assertEqual(cmd[:2], ["claude", "-p"])

    def test_backend_opencode_top_level_drops_legacy_pin(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            _write_config(
                base,
                {
                    "backend": "opencode",
                    "agents": {
                        "alpha": {"backend": ["claude", "-p"], "model": None},
                    },
                },
            )
            cfg = load_config(str(base))
            self.assertIsNone(cfg["agents"]["alpha"]["backend"])

    def test_migration_helper_reports_change(self):
        cfg = {
            "backend": "auto",
            "agents": {"alpha": {"backend": ["claude", "-p"]}},
        }
        self.assertTrue(migrate_legacy_agent_backends(cfg))
        self.assertFalse(migrate_legacy_agent_backends(cfg))

    def test_heal_config_persists_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            cfg_file = _write_config(
                base,
                {
                    "backend": "auto",
                    "agents": {"alpha": {"backend": ["claude", "-p"], "model": None}},
                },
            )
            self.assertTrue(heal_config(str(base)))
            on_disk = json.loads(cfg_file.read_text(encoding="utf-8"))
            self.assertIsNone(on_disk["agents"]["alpha"]["backend"])
            # Second pass has nothing left to migrate.
            self.assertFalse(heal_config(str(base)))


class TestConfigMergeSemantics(unittest.TestCase):
    def test_partial_agents_block_does_not_clobber_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            _write_config(base, {"agents": {"alpha": {"model": "some-model"}}})
            cfg = load_config(str(base))
            self.assertEqual(cfg["agents"]["alpha"]["model"], "some-model")
            self.assertIsNone(cfg["agents"]["alpha"]["backend"])
            # Beta was absent from the file and keeps its defaults.
            self.assertIsNone(cfg["agents"]["beta"]["backend"])

    def test_loaded_config_does_not_alias_default_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            cfg = load_config(str(base))
            cfg["agents"]["alpha"]["backend"] = "MUTATED"
            cfg["license_whitelist"].append("MUTATED")
            self.assertIsNone(DEFAULT_CONFIG["agents"]["alpha"]["backend"])
            self.assertNotIn("MUTATED", DEFAULT_CONFIG["license_whitelist"])

    def test_malformed_agents_block_is_tolerated(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            _write_config(base, {"agents": None})
            cfg = load_config(str(base))
            self.assertIsNone(cfg["agents"]["alpha"]["backend"])

            _write_config(base, {"agents": {"alpha": None}})
            cfg = load_config(str(base))
            self.assertIsNone(cfg["agents"]["alpha"])
            self.assertIsNone(cfg["agents"]["beta"]["backend"])

    def test_non_object_config_falls_back_to_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True, exist_ok=True)
            (base / "config.json").write_text("[1, 2, 3]", encoding="utf-8")
            with redirect_stderr(io.StringIO()):
                cfg = load_config(str(base))
            self.assertEqual(cfg["search_engine"], "duckduckgo")

    def test_save_load_roundtrip_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            save_config(load_config(str(base)), str(base))
            first = load_config(str(base))
            save_config(first, str(base))
            self.assertEqual(first, load_config(str(base)))


class TestAgentSpawnWorkingDirectory(unittest.TestCase):
    def test_project_root_is_evidence_dir_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
            self.assertEqual(
                runner.project_root, Path(os.path.realpath(str(base))).parent
            )

    def test_agent_cwd_defaults_to_project_root(self):
        project = Path("/tmp/some-project")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_agent_cwd(project), str(project))

    def test_agent_cwd_package_override(self):
        with mock.patch.dict(os.environ, {"IUMBTEMS_AGENT_CWD": "package"}):
            self.assertEqual(_agent_cwd(Path("/tmp/x")), str(PACKAGE_ROOT))

    def test_agent_cwd_absolute_override(self):
        with mock.patch.dict(os.environ, {"IUMBTEMS_AGENT_CWD": "/custom/dir"}):
            self.assertEqual(_agent_cwd(Path("/tmp/x")), "/custom/dir")

    def test_scope_prompt_names_absolute_scratchpad(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="darkharvest")
            prompt = runner._scope_prompt("Alpha", {"scope_id": "s1"}, "s1")
            expected = str(runner.state_machine.get_scope_dir("s1"))
            self.assertIn(expected, prompt)
            self.assertTrue(Path(expected).is_absolute())

    def test_spawn_uses_project_root_not_package_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=False, mode="research")
            fake = mock.Mock()
            fake.stdout = "ok"
            with mock.patch.dict(os.environ, {}, clear=True):
                with mock.patch("subprocess.run", return_value=fake) as run_mock:
                    runner.run_claude_process("objective text")
            kwargs = run_mock.call_args.kwargs
            self.assertEqual(kwargs["cwd"], str(runner.project_root))
            self.assertNotEqual(kwargs["cwd"], str(PACKAGE_ROOT))
            self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
            # `opencode run` follows $PWD, which subprocess.run(cwd=...) does not
            # update — keep them identical.
            self.assertEqual(kwargs["env"]["PWD"], kwargs["cwd"])


class TestBackendHostMismatchWarning(unittest.TestCase):
    def test_warns_when_pin_contradicts_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            _write_config(
                base,
                {
                    "backend": "claude",
                    "agents": {"alpha": {"backend": ["claude", "-p"]}},
                },
            )
            with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
                runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
                buf = io.StringIO()
                with redirect_stderr(buf):
                    runner.build_agent_cmd("objective", role="alpha")
            self.assertIn("IUMBTEMS_HOST", buf.getvalue())
            self.assertIn("alpha", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
