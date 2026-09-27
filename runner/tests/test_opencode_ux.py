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

    def test_empty_arg_guards(self):
        res = run_node(
            """
            import { OPENCODE_COMMANDS } from "./plugins/opencode/index.js";
            const guarded = OPENCODE_COMMANDS.filter(c => /empty/i.test(c.template) && /ask the user/i.test(c.template)).map(c => c.name);
            const withUsage = OPENCODE_COMMANDS.filter(c => !!c.usage).map(c => c.name);
            console.log(JSON.stringify({guarded, withUsage, total: OPENCODE_COMMANDS.length}));
            """
        )
        self.assertEqual(res.returncode, 0, f"guard test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        for c in ["swarm", "scout", "audit"]:
            self.assertIn(c, data["guarded"])
        self.assertEqual(len(data["withUsage"]), data["total"])

    def test_async_execute_resolves(self):
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const shell = await plugin.server();
            let ticked = false;
            const timer = setInterval(() => { ticked = true; }, 5);
            const r = await shell.tool.iumbtems_config.execute({});
            clearInterval(timer);
            console.log(JSON.stringify({status: r.status, hasContent: typeof r.content === "string" && r.content.length > 0, loopAlive: ticked}));
            """
        )
        self.assertEqual(res.returncode, 0, f"async execute test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["status"], "success")
        self.assertTrue(data["hasContent"])
        self.assertTrue(data["loopAlive"])

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
            # Skills merged as absolute repo paths (relative entries repaired).
            skill_paths = cfg.get("skills", {}).get("paths", [])
            self.assertTrue(skill_paths)
            for sp in skill_paths:
                self.assertTrue(Path(sp).is_absolute(), f"relative skill path: {sp}")
            self.assertIn(str(PROJECT_ROOT / "skills" / "grilling"), skill_paths)
            self.assertFalse(any(not Path(sp).is_absolute() for sp in skill_paths))
            # Second run changes nothing.
            before = oc_path.read_bytes()
            second = self._run_install(home)
            self.assertEqual(second.returncode, 0, f"reinstall failed: {second.stderr}")
            self.assertEqual(oc_path.read_bytes(), before)


class TestOpenCodeTui(unittest.TestCase):
    def test_module_load_and_setup(self):
        res = run_node(
            """
            import plugin, { readSwarmStatus, setupTui } from "./plugins/opencode/tui.js";
            const calls = [];
            const mock = {
              theme: {}, directory: "/tmp/oc-tui-empty",
              ui: { slot: (...a) => { calls.push(a.length); return () => {}; }, toast: { show: () => {} }, router: { current: () => ({type: "other"}) } },
              keymap: { layer: () => {} }
            };
            const cleanup = setupTui(mock);
            const empty = readSwarmStatus("/tmp/oc-tui-empty");
            console.log(JSON.stringify({id: plugin.id, hasTui: !!plugin.tui, setupFn: typeof plugin.setup, slots: calls, cleanup: typeof cleanup, emptyWorkspace: empty.workspace}));
            """
        )
        self.assertEqual(res.returncode, 0, f"tui load test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["id"], "heretek.iumbtems.epistemic-swarm.tui")
        self.assertTrue(data["hasTui"])
        self.assertEqual(data["setupFn"], "function")
        self.assertEqual(data["slots"], [1, 1])
        self.assertEqual(data["cleanup"], "function")
        self.assertFalse(data["emptyWorkspace"])

    def test_status_snapshot_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            research = root / ".research"
            (research / "ledger").mkdir(parents=True)
            research.joinpath("config.json").write_text(
                json.dumps(
                    {
                        "mode": "research",
                        "search_engine": "duckduckgo",
                        "max_iterations": 2,
                    }
                ),
                encoding="utf-8",
            )
            research.joinpath("final_synthesis.md").write_text(
                "# synthesis\n", encoding="utf-8"
            )
            research.joinpath("frontier.json").write_text(
                json.dumps({"nodes": [{"status": "open"}, {"status": "settled"}]}),
                encoding="utf-8",
            )
            research.joinpath("ledger", "claim_status.json").write_text(
                json.dumps(
                    [
                        {
                            "scope_id": "s",
                            "claim_id": "a",
                            "from_status": "UNVERIFIED",
                            "to_status": "VERIFIED",
                            "reason": "",
                            "at": "t1",
                        },
                        {
                            "scope_id": "s",
                            "claim_id": "a",
                            "from_status": "VERIFIED",
                            "to_status": "STALE",
                            "reason": "retracted",
                            "at": "t2",
                        },
                        {
                            "scope_id": "s",
                            "claim_id": "b",
                            "from_status": "VERIFIED",
                            "to_status": "SUSPECT",
                            "reason": "",
                            "at": "t3",
                        },
                    ]
                ),
                encoding="utf-8",
            )
            research.joinpath("requeue.json").write_text(
                json.dumps([{"scope_id": "s1"}, {"scope_id": "s2"}]), encoding="utf-8"
            )
            res = run_node(
                f"""
                import {{ readSwarmStatus }} from "./plugins/opencode/tui.js";
                console.log(JSON.stringify(readSwarmStatus({str(root)!r})));
                """
            )
            self.assertEqual(res.returncode, 0, f"snapshot test failed: {res.stderr}")
            data = last_json_object(res.stdout)
            self.assertTrue(data["workspace"])
            self.assertEqual(data["mode"], "research")
            self.assertEqual(data["searchEngine"], "duckduckgo")
            self.assertEqual(len(data["reports"]), 1)
            self.assertEqual(data["frontierOpen"], 1)
            self.assertEqual(data["stale"], 1)
            self.assertEqual(data["suspect"], 1)
            self.assertEqual(data["requeued"], 2)

    def test_palette_entries_for_all_commands(self):
        res = run_node(
            """
            import { setupTui } from "./plugins/opencode/tui.js";
            import { OPENCODE_COMMANDS } from "./plugins/opencode/index.js";
            const renders = [];
            let factory = null;
            const toasts = [];
            const mock = {
              theme: {}, directory: process.cwd(),
              ui: { slot: (arg) => { renders.push(arg); return () => {}; }, toast: { show: (t) => toasts.push(t) }, router: { current: () => ({type: "other"}) } },
              keymap: { layer: (fn) => { factory = fn; } }
            };
            setupTui(mock);
            const appSlot = renders.find(r => r && r.append === "app");
            if (!appSlot) throw new Error("app slot not registered");
            appSlot.render();
            const spec = factory();
            const palette = spec.commands.filter(c => c.palette);
            for (const c of palette) c.run();
            console.log(JSON.stringify({
              total: spec.commands.length,
              palette: palette.length,
              groups: [...new Set(palette.map(c => c.group))],
              toasts: toasts.length,
              expected: OPENCODE_COMMANDS.length + 1
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"palette test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["total"], data["expected"])
        self.assertEqual(data["palette"], data["expected"])
        self.assertEqual(data["groups"], ["IUMBTEMS"])
        self.assertEqual(data["toasts"], data["expected"])


class TestOpenCodeLifecycle(unittest.TestCase):
    @staticmethod
    def _fixture(tmp):
        root = Path(tmp)
        research = root / ".research"
        (research / "ledger").mkdir(parents=True)
        research.joinpath("config.json").write_text(
            json.dumps(
                {"mode": "audit", "search_engine": "brave", "max_iterations": 3}
            ),
            encoding="utf-8",
        )
        research.joinpath("ledger", "claim_status.json").write_text(
            json.dumps(
                [
                    {
                        "scope_id": "s",
                        "claim_id": "x1",
                        "from_status": "VERIFIED",
                        "to_status": "STALE",
                        "reason": "retracted",
                        "at": "t1",
                    },
                ]
            ),
            encoding="utf-8",
        )
        research.joinpath("requeue.json").write_text(
            json.dumps([{"scope_id": "s9"}]), encoding="utf-8"
        )
        return str(root)

    def test_idle_detection(self):
        res = run_node(
            """
            import { isIdleEvent } from "./plugins/opencode/index.js";
            console.log(JSON.stringify({
              idle: isIdleEvent({type: "session.idle"}),
              statusIdle: isIdleEvent({type: "session.status", properties: {status: {type: "idle"}}}),
              busy: isIdleEvent({type: "session.status", properties: {status: {type: "busy"}}}),
              other: isIdleEvent({type: "message.updated"}),
              empty: isIdleEvent(null)
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"idle test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["idle"])
        self.assertTrue(data["statusIdle"])
        self.assertFalse(data["busy"])
        self.assertFalse(data["other"])
        self.assertFalse(data["empty"])

    def test_compaction_hook_pushes_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._fixture(tmp)
            res = run_node(
                f"""
                import plugin from "./plugins/opencode/index.js";
                const shell = await plugin.server();
                const hook = shell["experimental.session.compacting"];
                const out = {{context: []}};
                await hook({{directory: {root!r}}}, out);
                const empty = {{context: []}};
                await hook({{directory: "/tmp/oc-lifecycle-empty"}}, empty);
                console.log(JSON.stringify({{hook: typeof hook, pushed: out.context.length, text: out.context[0] || "", skipped: empty.context.length}}));
                """
            )
            self.assertEqual(res.returncode, 0, f"compaction test failed: {res.stderr}")
            data = last_json_object(res.stdout)
            self.assertEqual(data["hook"], "function")
            self.assertEqual(data["pushed"], 1)
            self.assertIn("mode=audit", data["text"])
            self.assertIn("x1", data["text"])
            self.assertIn("s9", data["text"])
            self.assertEqual(data["skipped"], 0)

    def test_nudge_once_per_ledger_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._fixture(tmp)
            res = run_node(
                f"""
                import {{ handleIdleEvent }} from "./plugins/opencode/index.js";
                const prompts = [];
                const host = {{session: {{prompt: async (p) => {{ prompts.push(p); return {{}}; }}}}}};
                const state = {{}};
                const evt = {{type: "session.idle", properties: {{sessionID: "ses_1"}}}};
                const first = handleIdleEvent(host, {root!r}, state, evt);
                await new Promise(r => setTimeout(r, 20));
                const second = handleIdleEvent(host, {root!r}, state, evt);
                const busy = handleIdleEvent(host, {root!r}, state, {{type: "message.updated"}});
                console.log(JSON.stringify({{first, second, busy, prompts: prompts.length, sid: prompts[0]?.sessionID || null}}));
                """
            )
            self.assertEqual(res.returncode, 0, f"nudge test failed: {res.stderr}")
            data = last_json_object(res.stdout)
            self.assertTrue(data["first"])
            self.assertFalse(data["second"])
            self.assertFalse(data["busy"])
            self.assertEqual(data["prompts"], 1)
            self.assertEqual(data["sid"], "ses_1")


class TestOpenCodeV2Transforms(unittest.TestCase):
    """V2 host (setup ctx transforms): commands + tools via owning domains."""

    V2_SETUP = """
            import plugin from "./plugins/opencode/index.js";
            const addedCommands = [];
            const addedTools = [];
            const prompts = [];
            const host = {
              options: {},
              command: {
                list: async () => ({data: [{name: "goal"}]}),
                transform: async (fn) => { fn({add: (d) => addedCommands.push(d)}); return () => {}; }
              },
              tool: {
                transform: async (fn) => { fn({add: (t) => addedTools.push(t)}); return () => {}; }
              },
              session: { prompt: async (p) => { prompts.push(p); return {}; } }
            };
            const ret = await plugin.setup(host);
            %s
    """

    def test_v2_registers_commands_and_tools(self):
        res = run_node(
            self.V2_SETUP
            % """
            console.log(JSON.stringify({
              cleanupFn: typeof ret === "function",
              commands: addedCommands.map(c => c.name),
              cmdExec: typeof addedCommands.find(c => c.name === "swarm").execute,
              tools: addedTools.map(t => t.name),
              toolExec: typeof addedTools.find(t => t.name === "iumbtems_config").execute
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"v2 transform test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["cleanupFn"])
        for c in [
            "swarm",
            "grill",
            "swarm-config",
            "audit",
            "scout",
            "brainstorming",
            "brainstorm",
        ]:
            self.assertIn(c, data["commands"])
        self.assertNotIn("goal", data["commands"])
        self.assertEqual(data["cmdExec"], "function")
        self.assertEqual(len(data["tools"]), 13)
        self.assertIn("iumbtems_brainstorm", data["tools"])
        self.assertEqual(data["toolExec"], "function")

    def test_v2_command_execute_forwards_prompt(self):
        res = run_node(
            self.V2_SETUP
            % """
            const swarm = addedCommands.find(c => c.name === "swarm");
            await swarm.execute({sessionID: "ses_9", prompt: {text: "probe objective"}, delivery: "steer"});
            console.log(JSON.stringify({prompts}));
            """
        )
        self.assertEqual(res.returncode, 0, f"v2 execute test failed: {res.stderr}")
        data = last_json_object(res.stdout)["prompts"]
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["sessionID"], "ses_9")
        self.assertIn("probe objective", data[0]["text"])
        self.assertNotIn("$ARGUMENTS", data[0]["text"])
        self.assertEqual(data[0]["delivery"], "steer")

    def test_v2_tool_execute_returns_content(self):
        res = run_node(
            self.V2_SETUP
            % """
            const cfg = addedTools.find(t => t.name === "iumbtems_config");
            const r = await cfg.execute({}, {});
            console.log(JSON.stringify({keys: Object.keys(r), status: r.status, hasContent: typeof r.content === "string"}));
            """
        )
        self.assertEqual(res.returncode, 0, f"v2 tool test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["keys"], ["content"])
        self.assertTrue(data["hasContent"])

    def test_setup_without_v2_domains_still_works(self):
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const ret = await plugin.setup({});
            ret();
            ret();
            console.log(JSON.stringify({cleanupFn: typeof ret === "function"}));
            """
        )
        self.assertEqual(res.returncode, 0, f"bare setup test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["cleanupFn"])

    def test_options_applied_to_location_dir_after_transforms(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            res = run_node(
                f"""
                import plugin from "./plugins/opencode/index.js";
                const added = [];
                const host = {{
                  options: {{mode: "audit"}},
                  location: {{directory: {tmp!r}}},
                  command: {{
                    list: async () => ({{data: []}}),
                    transform: async (fn) => {{ fn({{add: (d) => added.push(d.name)}}); }}
                  }},
                  tool: {{transform: async () => {{}}}}
                }};
                await plugin.setup(host);
                console.log(JSON.stringify({{commands: added}}));
                """
            )
            self.assertEqual(res.returncode, 0, f"options test failed: {res.stderr}")
            data = last_json_object(res.stdout)
            # Transforms registered despite the slow MCP options write.
            self.assertIn("swarm", data["commands"])
            cfg = json.loads(
                Path(tmp, ".research", "config.json").read_text(encoding="utf-8")
            )
            self.assertEqual(cfg.get("mode"), "audit")

    def test_setup_cleanup_aborts_nudge_streams(self):
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const seen = [];
            const host = {
              options: {},
              location: {directory: "/tmp/oc-nudge-cleanup"},
              event: {subscribe: (opts) => { seen.push(opts && opts.signal); return {[Symbol.asyncIterator]() { return {next: async () => ({done: true})}; }}; }},
              session: {prompt: async () => ({})}
            };
            const cleanup = await plugin.setup(host);
            const before = seen.length;
            cleanup();
            console.log(JSON.stringify({subscribed: before > 0, cleanupFn: typeof cleanup === "function", aborted: seen.length > 0 && seen[0].aborted === true}));
            """
        )
        self.assertEqual(res.returncode, 0, f"cleanup test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["subscribed"])
        self.assertTrue(data["cleanupFn"])
        self.assertTrue(data["aborted"])


if __name__ == "__main__":
    unittest.main()
