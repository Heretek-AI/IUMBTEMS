#!/usr/bin/env python3
"""Tests for the OpenCode v2 end-user UX surface (goal Phase A).

Covers the slash-command catalog, the server object-form contract, and
install.sh OpenCode handling (idempotency + bare-object repair).
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

EXPECTED_COMMANDS = [
    "swarm",
    "grill",
    "swarm-config",
    "audit",
    "scout",
    "brainstorming",
    "brainstorm",
]


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


class TestOpenCodeCommandCatalog(unittest.TestCase):
    def test_catalog_shape_and_registration(self):
        res = run_node(
            """
            import plugin, { OPENCODE_COMMANDS, registerOpenCodeCommands } from "./plugins/opencode/index.js";
            const shell = await plugin.server();
            const cfg = {};
            shell.config(cfg);
            console.log(JSON.stringify({
              catalog: OPENCODE_COMMANDS.map(c => ({name: c.name, hasDesc: !!c.description, hasArgs: c.template.includes("$ARGUMENTS")})),
              registered: Object.keys(cfg.command || {}),
              templates: Object.fromEntries(Object.entries(cfg.command || {}).map(([k, v]) => [k, !!v.description && !!v.template]))
            }));
            """
        )
        self.assertEqual(
            res.returncode, 0, f"command catalog test failed: {res.stderr}"
        )
        data = last_json_object(res.stdout)
        names = [c["name"] for c in data["catalog"]]
        for c in EXPECTED_COMMANDS:
            self.assertIn(c, names)
        for entry in data["catalog"]:
            self.assertTrue(
                entry["hasDesc"], f"command lacks description: {entry['name']}"
            )
            self.assertTrue(
                entry["hasArgs"], f"template lacks $ARGUMENTS: {entry['name']}"
            )
        for c in EXPECTED_COMMANDS:
            self.assertIn(c, data["registered"])
            self.assertTrue(data["templates"][c])

    def test_registration_never_overwrites(self):
        res = run_node(
            """
            import { registerOpenCodeCommands } from "./plugins/opencode/index.js";
            const cfg = {command: {swarm: {description: "mine", template: "mine"}}};
            registerOpenCodeCommands(cfg);
            console.log(JSON.stringify({swarm: cfg.command.swarm, count: Object.keys(cfg.command).length}));
            """
        )
        self.assertEqual(res.returncode, 0, f"no-overwrite test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["swarm"], {"description": "mine", "template": "mine"})
        self.assertEqual(data["count"], len(EXPECTED_COMMANDS))

    def test_tool_map_shape(self):
        res = run_node(
            """
            import plugin, { IUMBTEMS_TOOL_NAMES } from "./plugins/opencode/index.js";
            const shell = await plugin.server();
            const entries = Object.entries(shell.tool);
            console.log(JSON.stringify({
              keys: entries.map(([k]) => k),
              canonical: IUMBTEMS_TOOL_NAMES,
              ok: entries.map(([k, t]) => (!!t.description && !!t.input && typeof t.execute === "function" && t.options && t.options.codemode === false))
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"tool map test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(sorted(data["keys"]), sorted(data["canonical"]))
        self.assertEqual(len(data["keys"]), 13)
        self.assertTrue(all(data["ok"]))


class TestInstallOpenCode(unittest.TestCase):
    def _run_install(self, home):
        env = dict(os.environ, HOME=str(home))
        return subprocess.run(
            ["bash", str(PROJECT_ROOT / "install.sh")],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            env=env,
        )

    def _seed_malformed(self, home):
        oc = home / ".config" / "opencode"
        oc.mkdir(parents=True, exist_ok=True)
        # Exact malformation seen in the wild: bare options object after the string.
        oc.joinpath("opencode.json").write_text(
            json.dumps(
                {
                    "$schema": "https://opencode.ai/config.json",
                    "plugin": [
                        "@prevalentware/opencode-goal-plugin",
                        "@heretek-ai/epistemic-swarm",
                        {
                            "search_engine": "duckduckgo",
                            "max_iterations": 10,
                            "mode": "research",
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )

    def test_idempotent_and_repairs_bare_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self._seed_malformed(home)
            first = self._run_install(home)
            self.assertEqual(first.returncode, 0, f"install failed: {first.stderr}")
            oc_path = home / ".config" / "opencode" / "opencode.json"
            cfg = json.loads(oc_path.read_text(encoding="utf-8"))
            # Bare object repaired into tuple form, preserving user options.
            tuples = [
                p
                for p in cfg["plugin"]
                if isinstance(p, list) and p and p[0] == "@heretek-ai/epistemic-swarm"
            ]
            self.assertEqual(len(tuples), 1)
            self.assertEqual(
                tuples[0][1],
                {
                    "search_engine": "duckduckgo",
                    "max_iterations": 10,
                    "mode": "research",
                },
            )
            self.assertFalse(any(isinstance(p, dict) for p in cfg["plugin"]))
            # Agents merged from the snippet, MCP server absolute.
            for agent in [
                "code-auditor",
                "oss-scout",
                "alpha-thesis",
                "beta-redteam",
                "epistemic-auditor",
                "brainstormer",
            ]:
                self.assertIn(agent, cfg.get("agent", {}))
            self.assertIn("iumbtems", cfg.get("mcp", {}))
            cmd = cfg["mcp"]["iumbtems"]["command"]
            self.assertTrue(Path(cmd[-1]).is_absolute())
            self.assertEqual(cmd[-1], str(PROJECT_ROOT / "runner" / "mcp_server.py"))
            # Second run changes nothing.
            before = oc_path.read_bytes()
            second = self._run_install(home)
            self.assertEqual(second.returncode, 0, f"reinstall failed: {second.stderr}")
            self.assertEqual(oc_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
