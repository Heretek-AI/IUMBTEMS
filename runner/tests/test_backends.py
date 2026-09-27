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
            self.assertIn("oss-scout", cmd)

    def test_research_beta_maps_to_beta_redteam(self):
        with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
            r = self._runner(mode="research")
            self.assertIn("beta-redteam", r.build_agent_cmd("obj", role="beta"))
            self.assertIn("alpha-thesis", r.build_agent_cmd("obj", role="alpha"))

    def test_explicit_override_beats_host_env(self):
        with mock.patch.dict(os.environ, {"IUMBTEMS_HOST": "opencode"}):
            r = self._runner(agent_overrides={"alpha": {"backend": ["claude", "-p"]}})
            cmd = r.build_agent_cmd("obj", role="alpha")
            self.assertEqual(cmd[:2], ["claude", "-p"])


class TestOpencodeOutputParsing(unittest.TestCase):
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
