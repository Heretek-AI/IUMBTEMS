#!/usr/bin/env python3
"""Tests for host-native agent backends (parity spec section 8).

Claude Code spawns `claude -p`; OpenCode spawns `opencode run`. Default
follows the host; explicit flags/env/config always win.
"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.research_swarm import (  # noqa: E402
    _backend_family,
    _build_opencode_cmd,
    _default_backend_cmd,
    _extract_opencode_text,
    SwarmRunner,
)


class TestBackendDefaults(unittest.TestCase):
    def test_explicit_config_host_wins(self):
        self.assertEqual(_default_backend_cmd("opencode"), ["opencode", "run"])
        self.assertEqual(_default_backend_cmd("claude"), ["claude", "-p"])

    def test_env_host_hint(self):
        with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
            self.assertEqual(_default_backend_cmd(None), ["opencode", "run"])
        with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "claude"}):
            self.assertEqual(_default_backend_cmd(None), ["claude", "-p"])

    def test_legacy_default_when_nothing_selects_opencode(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch("shutil.which", return_value=None):
                self.assertEqual(_default_backend_cmd(None), ["claude", "-p"])

    def test_probe_falls_back_to_opencode_when_claude_absent(self):
        with mock.patch.dict(os.environ, {}, clear=True):

            def which(name):
                return "/usr/bin/opencode" if name == "opencode" else None

            with mock.patch("shutil.which", side_effect=which):
                self.assertEqual(_default_backend_cmd(None), ["opencode", "run"])


class TestOpencodeArgv(unittest.TestCase):
    def test_shape_has_no_claude_flags(self):
        cmd = _build_opencode_cmd(
            ["opencode", "run"], "do research", "anthropic/claude-x", "alpha-thesis"
        )
        self.assertEqual(cmd[0:2], ["opencode", "run"])
        self.assertIn("do research", cmd)
        self.assertIn("--agent", cmd)
        self.assertIn("alpha-thesis", cmd)
        self.assertIn("-m", cmd)
        self.assertIn("anthropic/claude-x", cmd)
        self.assertIn("--format", cmd)
        self.assertIn("json", cmd)
        self.assertNotIn("--tools", cmd)
        self.assertNotIn("--system-prompt", cmd)
        self.assertFalse(any(a.startswith("--model") for a in cmd))

    def test_minimal_shape(self):
        self.assertEqual(
            _build_opencode_cmd(["opencode", "run"], "p", None, None),
            ["opencode", "run", "p", "--format", "json"],
        )

    def test_family_detection(self):
        self.assertEqual(_backend_family(["opencode", "run"]), "opencode")
        self.assertEqual(_backend_family(["claude", "-p"]), "claude")
        self.assertEqual(_backend_family(["/usr/bin/opencode", "run"]), "opencode")


class TestRunnerBackendWiring(unittest.TestCase):
    def _runner(self, **kw):
        import tempfile

        tmp = tempfile.mkdtemp()
        return SwarmRunner(
            base_dir=Path(tmp), mock_mode=True, mode=kw.pop("mode", "research"), **kw
        )

    def test_claude_shape_preserved_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch("shutil.which", return_value=None):
                r = self._runner()
                cmd = r.build_agent_cmd("obj")
                self.assertEqual(cmd[:3], ["claude", "-p", "obj"])
                self.assertIn("--tools", cmd)

    def test_opencode_shape_via_host_env(self):
        with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
            r = self._runner(mode="scout")
            cmd = r.build_agent_cmd("obj")
            self.assertEqual(cmd[:2], ["opencode", "run"])
            # No --agent by default: named agents fail hard unless the user
            # installed the profile ("Agent not found", observed live).
            self.assertNotIn("--agent", cmd)
            self.assertIn("--format", cmd)

    def test_explicit_opencode_agent_config_opt_in(self):
        with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
            r = self._runner(agent_overrides=None)
            r.config["opencode_agent"] = "brainstormer"
            cmd = r.build_agent_cmd("obj")
            self.assertIn("--agent", cmd)
            self.assertIn("brainstormer", cmd)

    def test_system_prompt_inlined_for_opencode(self):
        import tempfile as _tf

        with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
            r = self._runner(mode="research")
            spf = Path(_tf.mkdtemp()) / "sys.md"
            spf.write_text("SYSTEM PROMPT BODY", encoding="utf-8")
            cmd = r.build_agent_cmd("obj", system_prompt_file=spf)
            self.assertIn("SYSTEM PROMPT BODY", cmd[2])
            self.assertNotIn("--system-prompt", cmd)

    def test_explicit_override_beats_host_env(self):
        with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
            r = self._runner(agent_overrides={"alpha": {"backend": ["claude", "-p"]}})
            cmd = r.build_agent_cmd("obj", role="alpha")
            self.assertEqual(cmd[:2], ["claude", "-p"])


class TestOpencodeOutputParsing(unittest.TestCase):
    def test_extracts_real_part_text_events(self):
        """Live shape: {"type":"text","part":{"type":"text","text":"..."}}."""
        raw = "\n".join(
            [
                '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"type":"step-start"}}',
                '{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p1","type":"text","text":"pong"}}',
                '{"type":"text","timestamp":3,"sessionID":"s","part":{"id":"p2","type":"text","text":"second"}}',
            ]
        )
        self.assertEqual(_extract_opencode_text(raw), "pong\nsecond")

    def test_extracts_text_events(self):
        raw = "\n".join(
            [
                '{"type":"session","id":"s1"}',
                '{"type":"message","text":"first finding"}',
                '{"type":"message","text":"second finding"}',
                '{"type":"tool_call","tool":"read"}',
            ]
        )
        self.assertEqual(_extract_opencode_text(raw), "first finding\nsecond finding")

    def test_falls_back_to_raw(self):
        self.assertEqual(_extract_opencode_text("plain text out"), "plain text out")
        self.assertEqual(_extract_opencode_text(""), "")

    def test_ignores_malformed_lines(self):
        raw = '{not json\n{"type":"result","result":"verdict: clean-room"}'
        self.assertEqual(_extract_opencode_text(raw), "verdict: clean-room")


class TestSpawnHardening(unittest.TestCase):
    def test_stdin_is_devnull_for_backend_spawns(self):
        """Regression: held-open stdin pipe made `opencode run` hang forever."""
        import tempfile
        from runner.research_swarm import SwarmRunner

        r = SwarmRunner(
            base_dir=Path(tempfile.mkdtemp()), mock_mode=False, mode="research"
        )
        fake = mock.Mock()
        fake.stdout = "ok"
        with mock.patch("subprocess.run", return_value=fake) as run_mock:
            r.run_claude_process("objective text")
        kwargs = run_mock.call_args.kwargs
        self.assertEqual(kwargs.get("stdin"), subprocess.DEVNULL)
        self.assertEqual(kwargs.get("shell"), False)


class TestDossierStdoutFallback(unittest.TestCase):
    def _runner(self):
        import tempfile
        from runner.research_swarm import SwarmRunner

        tmp = tempfile.mkdtemp()
        r = SwarmRunner(base_dir=Path(tmp), mock_mode=False, mode="research")
        r.state_machine.init_session("fallback probe")
        r.state_machine.set_scopes(
            [
                {
                    "scope_id": "scope_01_probe",
                    "title": "Probe",
                    "objective": "probe objective",
                    "dependencies": [],
                    "affirmative_targets": [],
                    "adversarial_targets": [],
                }
            ]
        )
        return r

    def test_recovers_dossier_from_stdout(self):
        from runner.research_swarm import SwarmRunner

        r = self._runner()
        payload = json.dumps(
            {
                "agent": "Agent Alpha (Thesis)",
                "scope_id": "scope_01_probe",
                "affirmative_claims": [],
            }
        )
        transcript = "Some chatter\n```json\n" + payload + "\n```\nDone."
        with mock.patch.object(
            SwarmRunner, "run_claude_process", return_value=transcript
        ):
            scope = {
                "scope_id": "scope_01_probe",
                "title": "Probe",
                "objective": "probe objective",
                "dependencies": [],
                "affirmative_targets": [],
                "adversarial_targets": [],
            }
            r.run_agent_alpha(scope)
        dossier_path = (
            r.state_machine.get_scope_dir("scope_01_probe") / "alpha_dossier.json"
        )
        self.assertTrue(dossier_path.is_file())
        saved = json.loads(dossier_path.read_text())
        self.assertTrue(saved.get("recovered_from_stdout"))

    def test_raises_when_no_file_and_no_json(self):
        from runner.research_swarm import SwarmRunner

        r = self._runner()
        with mock.patch.object(
            SwarmRunner, "run_claude_process", return_value="just some prose, no json"
        ):
            scope = {
                "scope_id": "scope_01_probe",
                "title": "Probe",
                "objective": "probe objective",
                "dependencies": [],
                "affirmative_targets": [],
                "adversarial_targets": [],
            }
            with self.assertRaises(FileNotFoundError):
                r.run_agent_beta(scope)


class TestProjectDirResolution(unittest.TestCase):
    def test_explicit_base_dir_wins(self):
        from runner.mcp_server import _resolve_base_dir

        with mock.patch.dict(os.environ, {"IUMBTEMS_PROJECT_DIR": "/tmp"}):
            p = _resolve_base_dir({"base_dir": "/tmp/custom"})
            self.assertEqual(p, Path("/tmp/custom"))

    def test_project_dir_preferred_over_cwd(self):
        import tempfile
        from runner.mcp_server import _resolve_base_dir

        project = tempfile.mkdtemp()
        with mock.patch.dict(os.environ, {"IUMBTEMS_PROJECT_DIR": project}):
            p = _resolve_base_dir({})
            self.assertEqual(
                p, Path(os.path.realpath(os.path.join(project, ".research")))
            )

    def test_missing_project_dir_falls_back_to_cwd(self):
        from runner.mcp_server import _resolve_base_dir

        with mock.patch.dict(os.environ, {"IUMBTEMS_PROJECT_DIR": "/no/such/dir"}):
            p = _resolve_base_dir({})
            self.assertEqual(p, Path(os.path.realpath(".research")))


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


class TestOpencodePluginBackend(unittest.TestCase):
    def test_backend_input_mirrored_on_swarm_tools(self):
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const toolMap = {};
            const host = {
              options: {},
              command: {list: async () => ({data: []}), transform: async () => ({dispose: () => {}}), reload: async () => {}},
              tool: {transform: async (fn) => { fn({add: (t) => { toolMap[t.name] = t; }}); return {dispose: () => {}}; }, reload: async () => {}},
              session: {prompt: async () => ({})}
            };
            await plugin.setup(host);
            const names = ["iumbtems_swarm_research","iumbtems_code_audit","iumbtems_oss_scout","iumbtems_brainstorm","iumbtems_darkharvest"];
            console.log(JSON.stringify(Object.fromEntries(names.map(n => [n, toolMap[n]?.input?.properties?.backend?.enum || null]))));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        data = last_json_object(res.stdout)
        self.assertEqual(len(data), 5)
        for name, enum in data.items():
            self.assertEqual(enum, ["auto", "claude", "opencode"], name)


if __name__ == "__main__":
    unittest.main()
