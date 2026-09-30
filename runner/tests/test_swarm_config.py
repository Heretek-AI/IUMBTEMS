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
import time
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
    ConfigHashError,
    ConfigStaleError,
    ConfigValidationError,
    _FALLBACK_DEFAULT_CONFIG,
    config_hash,
    heal_config,
    load_config,
    merge_config,
    migrate_legacy_agent_backends,
    save_config,
)


def _write_config(base_dir: Path, payload: dict) -> Path:
    base_dir.mkdir(parents=True, exist_ok=True)
    cfg_file = base_dir / "config.json"
    cfg_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return cfg_file


class TestFallbackDrift(unittest.TestCase):
    """Phase-03 R2: the standalone fallback literal tracks the canonical defaults.

    Replaces the old comment-only "drift guard" (which named a test that never
    existed): this is the real test. `_FALLBACK_DEFAULT_CONFIG` is the
    standalone path of `DEFAULT_CONFIG`, so any key added to
    `runner.schemas.CONFIG_DEFAULTS` without updating the literal fails here.
    """

    def test_fallback_literal_matches_canonical_defaults(self):
        from runner.schemas import CONFIG_DEFAULTS

        self.assertEqual(_FALLBACK_DEFAULT_CONFIG, CONFIG_DEFAULTS)

    def test_fallback_literal_covers_every_schema_key(self):
        from runner.schemas import CONFIG

        self.assertEqual(set(_FALLBACK_DEFAULT_CONFIG), set(CONFIG["properties"]))


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

    def test_heal_config_refuses_to_persist_schema_rejected_values(self):
        """R1 repro: a file with an invalid value must never be healed/written.

        `{"max_iterations": 99, agents.alpha.backend == ["claude","-p"]}` used to
        be rewritten by `heal_config(validate=False)`, legitimising the 99 and
        feeding it to SwarmRunner. It must now stay in memory only.
        """
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            cfg_file = _write_config(
                base,
                {
                    "max_iterations": 99,
                    "agents": {"alpha": {"backend": ["claude", "-p"]}},
                },
            )
            before = cfg_file.read_bytes()
            buf = io.StringIO()
            with redirect_stderr(buf):
                healed = heal_config(str(base))
            self.assertFalse(healed)
            self.assertEqual(cfg_file.read_bytes(), before)
            self.assertIn("max_iterations", buf.getvalue())

            # The in-memory migration still protects this process ...
            cfg = load_config(str(base))
            self.assertIsNone(cfg["agents"]["alpha"]["backend"])
            self.assertEqual(cfg["max_iterations"], 99)
            # ... and the invalid value survives on disk until fixed.
            on_disk = json.loads(cfg_file.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["max_iterations"], 99)

    def test_heal_config_persists_once_invalid_value_is_fixed(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            cfg_file = _write_config(
                base,
                {
                    "max_iterations": 99,
                    "agents": {"alpha": {"backend": ["claude", "-p"]}},
                },
            )
            # The typed path (MCP/CLI): effective config + the corrected value.
            candidate = merge_config(load_config(str(base)), {"max_iterations": 2})
            save_config(candidate, str(base))
            on_disk = json.loads(cfg_file.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["max_iterations"], 2)
            self.assertIsNone(on_disk["agents"]["alpha"]["backend"])


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


class TestSingleWriter(unittest.TestCase):
    """`save_config`: atomic, locked, validated, unknown-key preserving."""

    def test_crash_between_temp_write_and_rename_keeps_original(self):
        # F9 (recorded limitation): this proves the in-process failure path
        # (patched os.replace) leaves the original byte-identical and cleans up
        # the temp file. A real SIGKILL between write and rename can still leave
        # a `config.json.*.tmp` behind — inherent to temp+rename; the config
        # itself is never torn.
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            original = json.dumps({"search_engine": "brave", "custom_key": 1})
            cfg_file = _write_config(base, json.loads(original))
            before = cfg_file.read_bytes()
            with mock.patch("os.replace", side_effect=OSError("simulated crash")):
                with self.assertRaises(OSError):
                    save_config({"mode": "audit"}, str(base))
            self.assertEqual(cfg_file.read_bytes(), before)
            self.assertEqual(load_config(str(base))["mode"], "research")
            # The failed write must not leave temp litter behind.
            self.assertEqual(list(base.glob("config.json.*.tmp")), [])

    def test_unknown_keys_on_disk_survive_a_partial_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(
                base,
                {
                    "search_engine": "brave",
                    "custom_key": {"nested": [1, 2]},
                    "agents": {"beta": {"model": "keep-me"}},
                    "websearch": {"provider": "searxng"},
                },
            )
            save_config({"mode": "audit"}, str(base))
            data = json.loads(cfg_file.read_text(encoding="utf-8"))
            self.assertEqual(data["custom_key"], {"nested": [1, 2]})
            self.assertEqual(data["websearch"], {"provider": "searxng"})
            self.assertEqual(data["agents"]["beta"]["model"], "keep-me")
            self.assertEqual(data["mode"], "audit")
            self.assertEqual(data["search_engine"], "brave")

    def test_nested_unknown_keys_merge_instead_of_clobber(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(
                base, {"agents": {"beta": {"model": "keep-me", "extra": 1}}}
            )
            save_config({"agents": {"alpha": {"model": "new"}}}, str(base))
            data = json.loads(cfg_file.read_text(encoding="utf-8"))
            self.assertEqual(data["agents"]["beta"]["model"], "keep-me")
            self.assertEqual(data["agents"]["alpha"]["model"], "new")

    def test_expected_hash_mismatch_rejects_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            _write_config(base, {"mode": "research"})
            stale_hash = config_hash(str(base))
            # A concurrent writer lands a newer version.
            cfg_file = _write_config(base, {"mode": "scout"})
            before = cfg_file.read_bytes()

            with self.assertRaises(ConfigStaleError) as ctx:
                save_config({"mode": "audit"}, str(base), expected_hash=stale_hash)
            self.assertEqual(cfg_file.read_bytes(), before)
            details = ctx.exception.details
            self.assertEqual(details["expected_hash"], stale_hash)
            self.assertEqual(details["current_hash"], config_hash(str(base)))
            self.assertEqual(details["config"]["mode"], "scout")
            self.assertFalse(details["written"])
            self.assertEqual(ctx.exception.code, "CONFIG_STALE")
            # R5: the stale payload carries no absolute workspace path.
            self.assertNotIn("path", details)

    def test_expected_hash_prefix_match_proceeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            _write_config(base, {"mode": "research"})
            prefix = config_hash(str(base))[:8]
            save_config({"mode": "audit"}, str(base), expected_hash=prefix)
            self.assertEqual(load_config(str(base))["mode"], "audit")

    def test_expected_hash_requires_at_least_eight_hex(self):
        """R4: a 4-hex guard is too collision-prone and is rejected outright."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(base, {"mode": "research"})
            before = cfg_file.read_bytes()
            for bad in ("abcd", "abc", "deadbeefz", "zzzzzzzz", "12 34"):
                with self.subTest(expected_hash=bad):
                    with self.assertRaises(ConfigHashError) as ctx:
                        save_config({"mode": "audit"}, str(base), expected_hash=bad)
                    self.assertEqual(ctx.exception.code, "CONFIG_INVALID_EXPECTED_HASH")
                    self.assertEqual(cfg_file.read_bytes(), before)
            # 64-hex, 8-hex, and uppercase spellings proceed.
            live = config_hash(str(base))
            save_config({"mode": "audit"}, str(base), expected_hash=live.upper())
            self.assertEqual(load_config(str(base))["mode"], "audit")
            # None / empty string mean "no guard" (documented).
            save_config({"mode": "scout"}, str(base), expected_hash="")
            self.assertEqual(load_config(str(base))["mode"], "scout")

    def test_expected_hash_rejects_before_any_directory_side_effect(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "fresh"
            with self.assertRaises(ConfigHashError):
                save_config({"mode": "audit"}, str(base), expected_hash="beef")
            self.assertFalse(base.exists())

    def test_expected_hash_for_absent_file_is_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            base.mkdir(parents=True, exist_ok=True)
            with self.assertRaises(ConfigStaleError):
                save_config({"mode": "audit"}, str(base), expected_hash="a" * 8)
            self.assertFalse((base / "config.json").exists())

    def test_invalid_config_is_rejected_without_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            with self.assertRaises(ConfigValidationError) as ctx:
                save_config({"max_iterations": 99}, str(base))
            self.assertFalse((base / "config.json").exists())
            self.assertTrue(any("maximum" in e for e in ctx.exception.errors))
            self.assertEqual(
                ctx.exception.to_dict()["code"], "CONFIG_VALIDATION_FAILED"
            )

    def test_non_object_config_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            with self.assertRaises(ConfigValidationError):
                save_config([1, 2, 3], str(base))
            self.assertFalse((base / "config.json").exists())

    def test_concurrent_writers_never_tear_or_lose_keys(self):
        script = (
            "import json, sys, time\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "from skills.swarm_config.configure import save_config\n"
            "base, name = sys.argv[2], sys.argv[3]\n"
            "for i in range(20):\n"
            "    save_config({'search_engine': 'brave', 'probe_' + name: i}, base)\n"
            "    time.sleep(0.002)\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(base, {"mode": "research"})
            procs = [
                subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        script,
                        str(PROJECT_ROOT),
                        str(base),
                        name,
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                for name in ("a", "b")
            ]
            # While the writers race, every observable state must be complete JSON.
            deadline = time.time() + 30
            while any(p.poll() is None for p in procs):
                self.assertLess(time.time(), deadline, "writers did not finish")
                json.loads(cfg_file.read_text(encoding="utf-8"))
            for proc in procs:
                _, err = proc.communicate()
                self.assertEqual(proc.returncode, 0, err)
            data = json.loads(cfg_file.read_text(encoding="utf-8"))
            self.assertEqual(data["probe_a"], 19)
            self.assertEqual(data["probe_b"], 19)
            self.assertEqual(list(base.glob("config.json.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
