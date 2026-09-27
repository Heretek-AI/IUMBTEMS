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
    "darkharvest",
    "factory",
    "domainexpansion",
]

EXPECTED_AGENTS = [
    "code-auditor",
    "oss-scout",
    "alpha-thesis",
    "beta-redteam",
    "epistemic-auditor",
    "brainstormer",
    "darkharvester",
    "manager",
    "programmer",
    "qa-a",
    "qa-b",
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


# Shared V2 mock: captures the tool map produced by `tool.transform` without a
# real host. The old tests drove `plugin.server()` — a V1 hook that no longer
# exists — so every tool assertion has to go through the V2 domain instead.
V2_TOOL_SETUP = """
            import plugin from "./plugins/opencode/index.js";
            const toolMap = {};
            const host = {
              options: {},
              command: {
                list: async () => ({data: []}),
                transform: async () => ({dispose: () => {}}),
                reload: async () => {}
              },
              tool: {
                transform: async (fn) => {
                  fn({add: (t) => { toolMap[t.name] = t; }});
                  return {dispose: () => {}};
                },
                reload: async () => {}
              },
              session: { prompt: async () => ({}) }
            };
            await plugin.setup(host);
"""


class TestOpenCodeCommandCatalog(unittest.TestCase):
    def test_catalog_shape_and_registration(self):
        # V2 only: the V1 `server()` config hook wrote the deprecated `command`
        # key and registered nothing on a v2 host. The declarative catalog is
        # now exposed as `commandCatalog()` (V2 key: `commands`); live hosts
        # register through `command.transform` — covered in
        # TestOpenCodeV2Transforms.
        res = run_node(
            """
            import { OPENCODE_COMMANDS, commandCatalog } from "./plugins/opencode/index.js";
            const catalog = commandCatalog();
            console.log(JSON.stringify({
              catalog: OPENCODE_COMMANDS.map(c => ({name: c.name, hasDesc: !!c.description, hasArgs: c.template.includes("$ARGUMENTS")})),
              registered: Object.keys(catalog),
              templates: Object.fromEntries(Object.entries(catalog).map(([k, v]) => [k, !!v.description && !!v.template]))
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

    def test_catalog_uses_v2_commands_key(self):
        """`command` is the deprecated V1 key and is ignored by a V2 host."""
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            console.log(JSON.stringify({
              hasServer: typeof plugin.server,
              hasSetup: typeof plugin.setup,
              hasConfigHook: false
            }));
            """
        )
        self.assertEqual(
            res.returncode, 0, f"entrypoint shape test failed: {res.stderr}"
        )
        data = last_json_object(res.stdout)
        # V1 `server()` is gone: a v2 host never calls it, and keeping it meant
        # the real registration path had to guess which host it was talking to.
        self.assertNotEqual(data["hasServer"], "function")
        self.assertEqual(data["hasSetup"], "function")

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
        # V2 tool results are `{content}` only (the V1 map added a `status`
        # field, which the V2 domain does not have).
        res = run_node(
            V2_TOOL_SETUP
            + """
            let ticked = false;
            const timer = setInterval(() => { ticked = true; }, 5);
            const r = await toolMap.iumbtems_config.execute({});
            clearInterval(timer);
            console.log(JSON.stringify({
              hasContent: typeof r.content === "string" && r.content.length > 0,
              shapeOk: Object.keys(r).sort().join(",") === "content",
              loopAlive: ticked
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"async execute test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["hasContent"])
        self.assertTrue(data["shapeOk"])
        self.assertTrue(data["loopAlive"])

    def test_v2_skips_preexisting_command_names(self):
        """Names already present at setup time are respected, not overwritten.

        This is the dedupe half of the replay fix: the skip set must be a
        snapshot taken at setup, not a set that grows across transform replays.
        """
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const added = [];
            const host = {
              options: {},
              command: {
                list: async () => ({data: [{name: "swarm"}]}),
                transform: async (fn) => { fn({add: (d) => added.push(d)}); return {dispose: () => {}}; },
                reload: async () => {}
              },
              tool: { transform: async () => ({dispose: () => {}}) },
              session: { prompt: async () => ({}) }
            };
            await plugin.setup(host);
            console.log(JSON.stringify({names: added.map(c => c.name)}));
            """
        )
        self.assertEqual(
            res.returncode, 0, f"preexisting-name test failed: {res.stderr}"
        )
        data = last_json_object(res.stdout)
        # `swarm` was already registered by the user, so we add the other six.
        self.assertNotIn("swarm", data["names"])
        self.assertEqual(len(data["names"]), len(EXPECTED_COMMANDS) - 1)

    def test_tool_map_shape(self):
        res = run_node(
            V2_TOOL_SETUP
            + """
            import { IUMBTEMS_TOOL_NAMES } from "./plugins/opencode/index.js";
            const entries = Object.entries(toolMap);
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
        self.assertEqual(len(data["keys"]), 15)
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
            # V1 `plugin` migrated to V2 `plugins` in object form; the trailing
            # bare options object is folded in and user options are preserved.
            self.assertNotIn("plugin", cfg)
            self.assertFalse(
                any(isinstance(p, list) for p in cfg["plugins"]),
                f"V2 plugins must not use tuple form: {cfg['plugins']}",
            )
            ours = [
                p
                for p in cfg["plugins"]
                if isinstance(p, dict)
                and p.get("package") == "@heretek-ai/epistemic-swarm"
            ]
            self.assertEqual(len(ours), 1)
            self.assertEqual(
                ours[0]["options"],
                {
                    "search_engine": "duckduckgo",
                    "max_iterations": 10,
                    "mode": "research",
                },
            )
            self.assertIn("@prevalentware/opencode-goal-plugin", cfg["plugins"])
            # Agents merged from the snippet under the V2 plural key.
            for agent in EXPECTED_AGENTS:
                self.assertIn(agent, cfg.get("agents", {}))
            # MCP server absolute under V2 mcp.servers (no legacy top-level key).
            self.assertNotIn("iumbtems", cfg["mcp"])
            cmd = cfg["mcp"]["servers"]["iumbtems"]["command"]
            self.assertTrue(Path(cmd[-1]).is_absolute())
            self.assertEqual(cmd[-1], str(PROJECT_ROOT / "runner" / "mcp_server.py"))
            # Skills merged as a V2 list of absolute repo paths.
            skill_paths = cfg.get("skills")
            self.assertIsInstance(skill_paths, list)
            self.assertTrue(skill_paths)
            for sp in skill_paths:
                self.assertTrue(Path(sp).is_absolute(), f"relative skill path: {sp}")
            self.assertIn(str(PROJECT_ROOT / "skills" / "grilling"), skill_paths)
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
        # V2 shape: `session.hook("compaction", fn)` pushes a text part onto
        # `event.system`. The old `experimental.session.compacting` hook lived
        # in the V1 `server()` factory and was dead code on a V2 host.
        with tempfile.TemporaryDirectory() as tmp:
            root = self._fixture(tmp)
            res = run_node(
                f"""
                import plugin from "./plugins/opencode/index.js";
                let handler = null;
                const host = {{
                  options: {{}},
                  location: {{directory: {root!r}}},
                  command: {{list: async () => ({{data: []}}), transform: async () => ({{dispose: async () => {{}}}}), reload: async () => {{}}}},
                  tool: {{transform: async () => ({{dispose: async () => {{}}}}), reload: async () => {{}}}},
                  session: {{
                    prompt: async () => ({{}}),
                    hook: async (name, fn) => {{ if (name === "compaction") handler = fn; return {{dispose: async () => {{}}}}; }}
                  }}
                }};
                await plugin.setup(host);
                const out = {{system: [], directory: {root!r}}};
                if (handler) await handler(out);
                const empty = {{system: [], directory: "/tmp/oc-lifecycle-empty-nonexistent"}};
                if (handler) await handler(empty);
                console.log(JSON.stringify({{
                  hook: typeof handler,
                  pushed: out.system.length,
                  text: (out.system[0] && out.system[0].text) || "",
                  skipped: empty.system.length
                }}));
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
            "darkharvest",
            "factory",
            "domainexpansion",
        ]:
            self.assertIn(c, data["commands"])
        self.assertNotIn("goal", data["commands"])
        self.assertEqual(data["cmdExec"], "function")
        self.assertEqual(len(data["tools"]), 15)
        self.assertIn("iumbtems_brainstorm", data["tools"])
        self.assertIn("iumbtems_darkharvest", data["tools"])
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

    # ------------------------------------------------------------------
    # Regression tests for the vanishing-slash-commands defect.
    #
    # The host REPLAYS a command transform callback on every registry rebuild.
    # The old code kept one `existing` Set closed over from setup and mutated it
    # inside the callback, so replay 2 saw every name as "already added" and
    # registered nothing — commands appeared at startup and vanished seconds
    # later. The mock used to invoke the callback exactly once, so the suite was
    # structurally blind to it.
    # ------------------------------------------------------------------

    REPLAY_SETUP = """
            import plugin from "./plugins/opencode/index.js";
            const passes = [];
            let captured = null;
            const host = {
              options: {},
              command: {
                // Emulate a host whose registry is rebuilt from base config on
                // each pass: our commands are NOT pre-existing at setup time,
                // and are wiped before every replay.
                list: async () => ({data: [{name: "goal"}]}),
                transform: async (fn) => { captured = fn; return {dispose: () => {}}; },
                reload: async () => {}
              },
              tool: {
                transform: async () => ({dispose: () => {}}),
                reload: async () => {}
              },
              session: { prompt: async () => ({}) }
            };
            const cleanup = await plugin.setup(host);
            for (let i = 0; i < 3; i++) {
              const draftAdds = [];
              captured({add: (d) => draftAdds.push(d)});
              passes.push(draftAdds.map((d) => d.name));
            }
"""

    def test_v2_command_transform_is_replay_safe(self):
        """Every replay must re-add all commands. This is the vanish bug."""
        res = run_node(
            self.REPLAY_SETUP
            + """
            console.log(JSON.stringify({passes}));
            """
        )
        self.assertEqual(res.returncode, 0, f"replay test failed: {res.stderr}")
        passes = last_json_object(res.stdout)["passes"]
        self.assertEqual(len(passes), 3)
        for i, added in enumerate(passes):
            self.assertEqual(
                len(added),
                len(EXPECTED_COMMANDS),
                f"transform pass {i} added {len(added)} commands, expected "
                f"{len(EXPECTED_COMMANDS)} — a replay must not skip our names "
                f"({added})",
            )
            for c in EXPECTED_COMMANDS:
                self.assertIn(c, added)

    def test_v2_setup_return_is_a_function(self):
        """Returning a plain object aborts host reload: `de is not a function`."""
        res = run_node(
            REPLAY_SINGLE
            + """
            console.log(JSON.stringify({type: typeof cleanup}));
            """
        )
        self.assertEqual(res.returncode, 0, f"setup-return test failed: {res.stderr}")
        self.assertEqual(last_json_object(res.stdout)["type"], "function")

    def test_v2_cleanup_disposes_registrations(self):
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const disposed = [];
            const mk = (label) => ({dispose: async () => { disposed.push(label); }});
            const host = {
              options: {},
              command: {
                list: async () => ({data: []}),
                transform: async () => mk("command"),
                reload: async () => {}
              },
              tool: {
                transform: async () => mk("tool"),
                reload: async () => {}
              },
              session: {
                prompt: async () => ({}),
                hook: async () => mk("compaction")
              }
            };
            const cleanup = await plugin.setup(host);
            await cleanup();
            console.log(JSON.stringify({disposed}));
            """
        )
        self.assertEqual(res.returncode, 0, f"dispose test failed: {res.stderr}")
        disposed = last_json_object(res.stdout)["disposed"]
        # Every transform/hook handle must be disposed on teardown, otherwise a
        # stale registration can make command.list() report names with no live
        # handler — which is what makes the skip-check fire on the next setup.
        self.assertIn("command", disposed)
        self.assertIn("tool", disposed)
        self.assertIn("compaction", disposed)

    def test_v2_repeated_setup_cycles_register_both_times(self):
        """setup -> cleanup -> setup must re-register (the reload path)."""
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const perSetup = [];
            for (let cycle = 0; cycle < 2; cycle++) {
              const added = [];
              let captured = null;
              const host = {
                options: {},
                command: {
                  list: async () => ({data: []}),
                  transform: async (fn) => { captured = fn; return {dispose: async () => {}}; },
                  reload: async () => {}
                },
                tool: { transform: async () => ({dispose: async () => {}}), reload: async () => {} },
                session: { prompt: async () => ({}) }
              };
              const cleanup = await plugin.setup(host);
              captured({add: (d) => added.push(d.name)});
              perSetup.push(added);
              await cleanup();
            }
            console.log(JSON.stringify({perSetup}));
            """
        )
        self.assertEqual(res.returncode, 0, f"setup-cycle test failed: {res.stderr}")
        per_setup = last_json_object(res.stdout)["perSetup"]
        self.assertEqual(len(per_setup), 2)
        for i, added in enumerate(per_setup):
            self.assertEqual(
                len(added),
                len(EXPECTED_COMMANDS),
                f"setup cycle {i} registered {len(added)} commands",
            )

    def test_v2_compaction_hook_preserves_state(self):
        """The V1 `experimental.session.compacting` hook was dead code on V2.

        Uses a real fixture workspace: `buildCompactionContext` returns null
        without `.research/config.json`, and pointing at `process.cwd()` made
        this pass only where a developer happened to have one.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rd = root / ".research"
            rd.mkdir()
            (rd / "config.json").write_text(
                json.dumps(
                    {
                        "mode": "audit",
                        "search_engine": "duckduckgo",
                        "max_iterations": 2,
                    }
                ),
                encoding="utf-8",
            )
            res = run_node(
                f"""
                import plugin from "./plugins/opencode/index.js";
                let hookName = null;
                let handler = null;
                const host = {{
                  options: {{}},
                  location: {{directory: {str(root)!r}}},
                  command: {{list: async () => ({{data: []}}), transform: async () => ({{dispose: async () => {{}}}}), reload: async () => {{}}}},
                  tool: {{transform: async () => ({{dispose: async () => {{}}}}), reload: async () => {{}}}},
                  session: {{
                    prompt: async () => ({{}}),
                    hook: async (name, fn) => {{ hookName = name; handler = fn; return {{dispose: async () => {{}}}}; }}
                  }}
                }};
                await plugin.setup(host);
                const event = {{system: [], directory: {str(root)!r}}};
                if (handler) await handler(event);
                const emptyEvent = {{system: [], directory: "/tmp/oc-v2-compaction-empty-nonexistent"}};
                if (handler) await handler(emptyEvent);
                console.log(JSON.stringify({{
                  hookName,
                  parts: event.system.map((p) => ({{type: p.type, text: p.text || ""}})),
                  emptySkipped: emptyEvent.system.length
                }}));
                """
            )
            self.assertEqual(
                res.returncode, 0, f"compaction hook test failed: {res.stderr}"
            )
            data = last_json_object(res.stdout)
            self.assertEqual(data["hookName"], "compaction")
            self.assertEqual(
                data["emptySkipped"], 0, "empty workspace must not push state"
            )
            self.assertTrue(
                data["parts"]
                and data["parts"][0]["type"] == "text"
                and "mode=audit" in data["parts"][0]["text"],
                f"compaction hook did not push state onto event.system: {data}",
            )

    def test_v2_logs_never_throw_and_surface_errors(self):
        """Bare `catch {}` made failures invisible under --log-level all."""
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const logged = [];
            const origError = console.error;
            console.error = (...a) => { logged.push(a.join(" ")); };
            const host = {
              options: {},
              command: {
                list: async () => { throw new Error("registry unavailable"); },
                transform: async (fn) => { fn({add: () => {}}); return {dispose: async () => {}}; },
                reload: async () => {}
              },
              tool: {transform: async () => ({dispose: async () => {}}), reload: async () => {}},
              session: {prompt: async () => ({})}
            };
            const cleanup = await plugin.setup(host);
            await cleanup();
            console.error = origError;
            console.log(JSON.stringify({
              logged,
              mentionsFailure: logged.some((l) => /command\\.list|registry unavailable/.test(l))
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"logging test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(
            data["mentionsFailure"],
            f"a swallowed error must be logged, not dropped: {data['logged']}",
        )


# One-shot REPLAY_SETUP equivalent that also yields the cleanup function.
REPLAY_SINGLE = """
            import plugin from "./plugins/opencode/index.js";
            const host = {
              options: {},
              command: {
                list: async () => ({data: []}),
                transform: async () => ({dispose: async () => {}}),
                reload: async () => {}
              },
              tool: {transform: async () => ({dispose: async () => {}}), reload: async () => {}},
              session: {prompt: async () => ({})}
            };
            const cleanup = await plugin.setup(host);
"""


if __name__ == "__main__":
    unittest.main()
