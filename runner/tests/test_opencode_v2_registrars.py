#!/usr/bin/env python3
"""Tests for OpenCode V2 agent/skill registration and command agent switching.

Live gap (ses_f1b924bdaffe): the /factory command declared `agent: manager`,
but no agent profiles existed (config snippet never installed) so every step
ran as the generic `build` agent, and skills were undiscoverable — the agent
ran `find / -name factory.py` to learn its own mechanics. These tests pin the
plugin-side fix: profiles and skills are registered through the V2 domains, and
the command switches the session agent.

Regression (0.7.6, opencode v2.0.18): the mock below used to hand the plugin an
`{add}` agent editor. The real V2 `AgentEditor` has NO `add()` — only
`list/get/default/update/remove`, where `update()` upserts. The plugin's
`draft.add(...)` threw `draft.add is not a function` and the host disabled the
whole plugin. The mock now models the real editor so that defect cannot pass.
"""

import json
import subprocess
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# Faithful V2 AgentEditor: `update(id, fn)` upserts, seeding a new entry from
# Agent.Info.default(id) (mode primary, allow-list) + global rules, exactly as
# the opencode v2.0.18 agent registry does. No `add`.
AGENT_EDITOR_JS = """
function makeAgentEditor(reg) {
  const store = new Map();
  return {
    store,
    editor: {
      list: () => [...store.values()],
      get: (id) => store.get(id),
      default: (id) => { reg.defaultAgent = id; },
      update: (id, fn) => {
        reg.agentUpdates.push(id);
        let agent = store.get(id);
        if (!agent) {
          agent = {
            id, name: id,
            request: {settings: {}, headers: {}, body: {}},
            mode: 'primary', hidden: false,
            permissions: [{action: '*', resource: '*', effect: 'allow'}],
          };
          store.set(id, agent);
        }
        fn(agent);
        agent.id = id;
      },
      remove: (id) => { store.delete(id); },
    },
  };
}
function seedAgent(box, id) {
  box.store.set(id, {
    id, name: id,
    request: {settings: {}, headers: {}, body: {}},
    mode: 'primary', hidden: false,
    permissions: [{action: '*', resource: '*', effect: 'allow'}],
  });
}
"""

V2_HOST = (
    AGENT_EDITOR_JS
    + """
const reg = {skills: [], commands: [], tools: [], prompts: [], switches: [], agentUpdates: [], defaultAgent: undefined};
const agentBox = makeAgentEditor(reg);
const host = {
  options: {},
  location: {directory: '/home/john/Projects/STC'},
  command: {list: async()=>({data:[]}), transform: async(fn)=>{fn({add:(x)=>{reg.commands.push(x);}}); return {dispose:()=>{}};}, reload: async()=>{}},
  tool: {transform: async(fn)=>{fn({add:(t)=>{reg.tools.push(t);}}); return {dispose:()=>{}};}, reload: async()=>{}},
  agent: {
    list: async()=>({data: [...agentBox.store.values()].map((a)=>({id: a.id, name: a.name}))}),
    transform: async(fn)=>{fn(agentBox.editor); return {dispose:()=>{}};},
    reload: async()=>{}
  },
  skill: {list: async()=>({data:[]}), transform: async(fn)=>{fn({add:(s)=>{reg.skills.push(s);}}); return {dispose:()=>{}};}, reload: async()=>{}},
  session: {
    prompt: async(p)=>{reg.prompts.push(p); return {};},
    switchAgent: async(a)=>{reg.switches.push(a); return {};}
  }
};
const agents = () => [...agentBox.store.values()];
"""
)


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


class TestV2Registration(unittest.TestCase):
    def test_agents_and_skills_registered(self):
        res = run_node(
            V2_HOST
            + """
            import plugin from "./plugins/opencode/index.js";
            await plugin.setup(host);
            const manager = agents().find(a => a.id === 'manager');
            const qa = agents().find(a => a.id === 'qa-a');
            const factory = reg.skills.find(s => s.id === 'factory');
            console.log(JSON.stringify({
              agentIds: agents().map(a => a.id).sort(),
              managerMode: manager?.mode,
              managerSystem: Boolean(manager?.system),
              managerPermissions: manager?.permissions?.length || 0,
              managerDeniesEdit: (manager?.permissions || []).some(p => p.action === 'edit' && p.effect === 'deny'),
              qaMode: qa?.mode,
              qaDeniesEdit: (qa?.permissions || []).some(p => p.action === 'edit' && p.effect === 'deny'),
              skillIds: reg.skills.map(s => s.id).sort(),
              factoryHasContent: Boolean(factory?.content?.includes('Factory')),
              factoryPath: factory?.path,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        for aid in (
            "manager",
            "programmer",
            "qa-a",
            "qa-b",
            "brainstormer",
            "darkharvester",
        ):
            self.assertIn(aid, d["agentIds"])
        self.assertEqual(d["managerMode"], "primary")
        self.assertTrue(d["managerSystem"])
        self.assertTrue(d["managerDeniesEdit"], "manager must not edit code")
        self.assertEqual(d["qaMode"], "subagent")
        self.assertTrue(d["qaDeniesEdit"], "qa must not edit code")
        self.assertIn("factory", d["skillIds"])
        self.assertIn("darkharvest", d["skillIds"])
        self.assertTrue(d["factoryHasContent"])
        self.assertTrue(d["factoryPath"].endswith("skills/factory/SKILL.md"))

    def test_agent_editor_never_calls_add(self):
        """Pin the exact 0.7.6 failure: AgentEditor has no `add`."""
        res = run_node(
            """
            const reg = {agentUpdates: []};
            const editor = {
              list: () => [],
              get: () => undefined,
              default: () => {},
              update: (id, fn) => {
                reg.agentUpdates.push(id);
                fn({id, permissions: []});
              },
              remove: () => {},
              // intentionally NO add
            };
            const host = {
              options: {}, location: {directory: '/tmp'},
              command: {list: async()=>({data:[]}), transform: async(fn)=>{fn({add:()=>{}}); return {dispose:()=>{}};}, reload: async()=>{}},
              tool: {transform: async()=>({dispose:()=>{}}), reload: async()=>{}},
              agent: {list: async()=>({data:[]}), transform: async(fn)=>{fn(editor); return {dispose:()=>{}};}, reload: async()=>{}},
              skill: {list: async()=>({data:[]}), transform: async(fn)=>{fn({add:()=>{}}); return {dispose:()=>{}};}, reload: async()=>{}},
              session: {prompt: async()=>({})}
            };
            import plugin from "./plugins/opencode/index.js";
            await plugin.setup(host);
            console.log(JSON.stringify({agentUpdates: reg.agentUpdates}));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertIn("manager", d["agentUpdates"])
        self.assertIn("qa-b", d["agentUpdates"])

    def test_command_switches_session_agent(self):
        res = run_node(
            V2_HOST
            + """
            import plugin from "./plugins/opencode/index.js";
            await plugin.setup(host);
            const factory = reg.commands.find(c => c.name === 'factory');
            await factory.execute({sessionID: 'ses_test', prompt: {text: 'Cockpit beta'}, delivery: 'steer'});
            console.log(JSON.stringify({
              switches: reg.switches,
              promptAgentKey: Object.prototype.hasOwnProperty.call(reg.prompts[0] || {}, 'agent'),
              promptHasArena: reg.prompts[0]?.text?.includes('Cockpit beta'),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertTrue(d["switches"], "switchAgent was never called")
        self.assertEqual(d["switches"][0]["agent"], "manager")
        # V2 SessionPromptInput has no `agent` field; pinning is switchAgent's job.
        self.assertFalse(d["promptAgentKey"])
        self.assertTrue(d["promptHasArena"])

    def test_preexisting_agent_and_skill_preserved(self):
        res = run_node(
            AGENT_EDITOR_JS
            + """
            const reg = {agentUpdates: [], skills: []};
            const agentBox = makeAgentEditor(reg);
            seedAgent(agentBox, 'manager'); // user-defined manager wins
            const host = {
              options: {}, location: {directory: '/tmp'},
              command: {list: async()=>({data:[]}), transform: async(fn)=>{fn({add:()=>{}}); return {dispose:()=>{}};}, reload: async()=>{}},
              tool: {transform: async()=>({dispose:()=>{}}), reload: async()=>{}},
              agent: {
                list: async()=>({data: [...agentBox.store.values()].map((a)=>({id: a.id}))}),
                transform: async(fn)=>{fn(agentBox.editor); return {dispose:()=>{}};},
                reload: async()=>{}
              },
              skill: {
                list: async()=>({data:[{id:'factory'}]}),
                transform: async(fn)=>{fn({add:(s)=>{reg.skills.push(s.id);}}); return {dispose:()=>{}};},
                reload: async()=>{}
              },
              session: {prompt: async()=>({})}
            };
            import plugin from "./plugins/opencode/index.js";
            await plugin.setup(host);
            console.log(JSON.stringify({agentUpdates: reg.agentUpdates, skills: reg.skills}));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertNotIn("manager", d["agentUpdates"], "user-defined manager must win")
        self.assertNotIn("factory", d["skills"], "user-defined factory skill must win")
        self.assertIn("qa-a", d["agentUpdates"])

    def test_graceful_without_agent_skill_domains(self):
        res = run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const host = {
              options: {}, location: {directory: '/tmp'},
              tool: {transform: async()=>({dispose:()=>{}}), reload: async()=>{}},
              session: {prompt: async()=>({})}
            };
            const cleanup = await plugin.setup(host);
            console.log(JSON.stringify({cleanupFn: typeof cleanup}));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(last_json_object(res.stdout)["cleanupFn"], "function")


class TestConfigValidatorParity(unittest.TestCase):
    """B4: the shared fixture corpus yields 100% identical verdicts in JS/Python."""

    FIXTURE = (
        PROJECT_ROOT / "runner" / "tests" / "fixtures" / "config_validation_cases.json"
    )

    def _js_verdicts(self, cases):
        import tempfile

        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(cases, f)
            tmp = f.name
        try:
            res = run_node(
                f"""
                import fs from "node:fs";
                import {{ validateConfig }} from "./plugins/opencode/config-io.js";
                const cases = JSON.parse(fs.readFileSync({tmp!r}, "utf-8"));
                const out = cases.map((c) => {{
                  const problems = validateConfig(c.config);
                  return {{name: c.name, valid: problems.length === 0, problems}};
                }});
                console.log(JSON.stringify({{results: out}}));
                """
            )
        finally:
            Path(tmp).unlink(missing_ok=True)
        self.assertEqual(res.returncode, 0, f"js validator run failed: {res.stderr}")
        return {r["name"]: r for r in last_json_object(res.stdout)["results"]}

    def test_js_python_verdict_parity_100_percent(self):
        from runner.schema_validate import validate
        from runner.schemas import CONFIG

        cases = json.loads(self.FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 0, "parity corpus must not be empty")
        # The R7 additions (minLength/pattern) must be in the corpus, or B4
        # parity would silently skip the newest validator subset.
        names = {c["name"] for c in cases}
        self.assertIn("vert_domain_pack_empty", names)
        self.assertIn("vert_searxng_url_missing_scheme", names)

        by_name = self._js_verdicts(cases)
        matches = 0
        for case in cases:
            with self.subTest(case=case["name"]):
                py_problems = validate(case["config"], CONFIG)
                py_valid = not py_problems
                js = by_name[case["name"]]
                self.assertEqual(
                    js["valid"],
                    py_valid,
                    f"{case['name']}: js={js} py={py_problems}",
                )
                self.assertEqual(
                    js["valid"],
                    case["valid"],
                    f"{case['name']}: both validators disagree with the fixture",
                )
                if not case["valid"] and case.get("expect"):
                    self.assertTrue(
                        any(case["expect"] in p for p in js["problems"]),
                        f"{case['name']}: {case['expect']!r} not in {js['problems']}",
                    )
                    self.assertTrue(
                        any(case["expect"] in p for p in py_problems),
                        f"{case['name']}: {case['expect']!r} not in {py_problems}",
                    )
                matches += js["valid"] == py_valid
        self.assertEqual(matches, len(cases), "parity must be 100%")

    def test_js_fallback_defaults_match_canonical(self):
        """The schema-unreadable fallback must equal CONFIG_DEFAULTS."""
        from runner.schemas import CONFIG_DEFAULTS

        res = run_node(
            """
            import { FALLBACK_DEFAULTS } from "./plugins/opencode/config-io.js";
            console.log(JSON.stringify({defaults: FALLBACK_DEFAULTS}));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(last_json_object(res.stdout)["defaults"], CONFIG_DEFAULTS)


class TestConfigToolCatalogSurface(unittest.TestCase):
    """B4: the plugin TOOL_CATALOG advertises the full canonical surface."""

    CONTROL_ARGS = {"base_dir", "show", "expected_hash", "expectedHash"}
    KEYWORDS = ("type", "enum", "minimum", "maximum", "minLength", "pattern")

    def _advertised(self):
        res = run_node(
            """
            import { TOOL_CATALOG } from "./plugins/opencode/index.js";
            const entry = TOOL_CATALOG.find((t) => t.name === "iumbtems_config");
            console.log(JSON.stringify({input: entry.input}));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        return last_json_object(res.stdout)["input"]

    def _compare(self, canonical, advertised, prefix, problems):
        for key, sub in (canonical.get("properties") or {}).items():
            adv = (advertised.get("properties") or {}).get(key)
            if adv is None:
                problems.append(f"missing advertised key: {prefix}{key}")
                continue
            for keyword in self.KEYWORDS:
                if keyword in sub and sub.get(keyword) != adv.get(keyword):
                    problems.append(
                        f"{prefix}{key}: {keyword} {sub.get(keyword)!r} != "
                        f"{adv.get(keyword)!r}"
                    )
            if isinstance(sub.get("properties"), dict):
                self._compare(sub, adv, f"{prefix}{key}.", problems)

    def test_plugin_catalog_covers_canonical_surface(self):
        artifact = json.loads(
            (PROJECT_ROOT / "schemas" / "config.schema.json").read_text(
                encoding="utf-8"
            )
        )
        advertised = self._advertised()
        problems = []
        self._compare(artifact, advertised, "", problems)
        self.assertEqual(problems, [])
        advertised_keys = set(advertised["properties"]) - self.CONTROL_ARGS
        self.assertEqual(advertised_keys, set(artifact["properties"]))
        # Phase 03 owns mcp_servers: the persisted toggle map is in the schema
        # AND the ad (applied via ctx.mcp.transform; catalog file untouched).
        self.assertIn("mcp_servers", advertised["properties"])
        self.assertIn("mcp_servers", artifact["properties"])
        self.assertEqual(advertised["properties"]["mcp_servers"]["type"], "object")
        # R4: both expected-hash spellings are advertised and documented.
        self.assertIn("expected_hash", advertised["properties"])
        self.assertIn("expectedHash", advertised["properties"])
        self.assertIn(
            "expected_hash",
            advertised["properties"]["expectedHash"]["description"],
        )


class TestWizardSlashRegistration(unittest.TestCase):
    """B1: `swarm-config` slash + palette entries on the mock host."""

    SLASH_SETUP = """
            import { registerWizardSlashCommand, setupTui } from "./plugins/opencode/tui.js";
            import { OPENCODE_COMMANDS } from "./plugins/opencode/index.js";
    """

    def test_slash_registers_and_opens_wizard(self):
        res = run_node(
            self.SLASH_SETUP
            + """
            const added = [];
            const host = {
              options: {}, directory: "/tmp/oc-wizard-slash",
              command: {
                list: async () => ({data: []}),
                transform: async (fn) => { fn({add: (d) => added.push(d)}); return {dispose: () => {}}; },
                reload: async () => {}
              },
              ui: { toast: { show: () => {} } },
              keymap: { layer: () => {} },
            };
            await registerWizardSlashCommand(host);
            // A pre-existing swarm-config wins (same dedupe rule as index.js).
            const added2 = [];
            const host2 = {
              options: {},
              command: {
                list: async () => ({data: [{name: "swarm-config"}]}),
                transform: async (fn) => { fn({add: (d) => added2.push(d)}); return {dispose: () => {}}; },
                reload: async () => {}
              },
              ui: {},
            };
            await registerWizardSlashCommand(host2);
            // Bare TUI api without the command domain: nothing to register.
            const bare = await registerWizardSlashCommand({ui: {}});
            console.log(JSON.stringify({
              added: added.map((a) => a.name),
              exec: typeof (added[0] && added[0].execute),
              skipped: added2.length,
              bare,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"slash test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["added"], ["swarm-config"])
        self.assertEqual(data["exec"], "function")
        self.assertEqual(data["skipped"], 0)
        self.assertIsNone(data["bare"])

    def test_palette_entries_and_panel_feature_detect(self):
        res = run_node(
            self.SLASH_SETUP
            + """
            import { openSettingsPanel } from "./plugins/opencode/tui.js";
            let factory = null;
            const host = {
              theme: {}, directory: "/tmp/oc-wizard-palette",
              ui: {
                slot: () => () => {},
                toast: { show: () => {} },
              },
              keymap: { layer: (fn) => { factory = fn; } },
            };
            setupTui(host);
            const renders = [];
            // Re-render the app slot to capture the keymap spec.
            const slots = [];
            const host2 = {
              theme: {}, directory: "/tmp/oc-wizard-palette",
              ui: { slot: (arg) => { slots.push(arg); return () => {}; }, toast: { show: () => {} } },
              keymap: { layer: (fn) => { factory = fn; } },
            };
            setupTui(host2);
            slots.find((r) => r && r.append === "app").render();
            const spec = factory();
            const ids = spec.commands.map((c) => c.id);
            // Panel feature-detect both ways (no workspace needed).
            const toasts = [];
            const noPanel = await openSettingsPanel(
              { directory: "/tmp/oc-wizard-empty-nonexistent", ui: { toast: { show: (t) => toasts.push(t) } } },
              "/tmp/oc-wizard-empty-nonexistent", { env: {} }
            );
            const panels = [];
            const withPanel = await openSettingsPanel(
              { directory: "/tmp/oc-wizard-empty-nonexistent", ui: { panel: async (p) => { panels.push(p); } } },
              "/tmp/oc-wizard-empty-nonexistent", { env: {} }
            );
            console.log(JSON.stringify({
              ids,
              palette: spec.commands.filter((c) => c.palette).length,
              noPanel: { ok: noPanel.ok, degraded: noPanel.degraded, toasts: toasts.length },
              withPanel: { ok: withPanel.ok, degraded: withPanel.degraded, panels: panels.length },
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"palette test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertIn("iumbtems.swarm-config", data["ids"])
        self.assertIn("iumbtems.swarm-settings", data["ids"])
        self.assertTrue(data["palette"] >= 2)
        self.assertTrue(data["noPanel"]["ok"])
        self.assertTrue(data["noPanel"]["degraded"])
        self.assertGreater(data["noPanel"]["toasts"], 0)
        self.assertTrue(data["withPanel"]["ok"])
        self.assertFalse(data["withPanel"]["degraded"])
        self.assertEqual(data["withPanel"]["panels"], 1)


# ---------------------------------------------------------------------------
# Phase 03 (opencode-settings-menu): `iumbtems.settings` RPC domain, storage
# mirror, MCP toggles, temperature hook + the bounded S3 spike harness.
#
# The mock host below models the v2 API shapes verified against
# @opencode/plugin@2.0.18 + https://opencode.ai/v2/docs/build/plugins/rpc:
# `ctx.rpc.register(Def, handlers)` returning `{dispose, events.emit}`,
# `ctx.storage` get/set/remove/scan, `ctx.mcp.transform` with an
# editor over `[name, config]` tuples, and `session.hook(name, fn)`.
# ---------------------------------------------------------------------------

PHASE3_HOST = """
import plugin, {
  SettingsRpc, SETTINGS_RPC_ID, SETTINGS_STORAGE_KEY,
  createSettingsHandlers, registerSettingsRpc,
  resolveMcpToggles, readPersistedMcpToggles, loadControllableMcpServers,
  registerMcpToggles,
  temperatureForRole, applyTemperatureToContext, registerTemperatureHook,
} from "./plugins/opencode/index.js";

function makePhase3Host(root, opts = {}) {
  const emits = [];
  const handlers = {};
  let def = null;
  const storageMap = new Map();
  const mcpServers = new Map(Object.entries(opts.mcpSeed || {
    iumbtems: {}, searxng: {}, "brave-search": {}, firecrawl: {}, "custom-evil": {},
  }));
  const hookCalls = [];
  const host = {
    options: {},
    location: { directory: root },
    rpc: {
      register: async (d, h) => {
        def = d;
        Object.assign(handlers, h);
        return {
          dispose: async () => {},
          events: { emit: async (name, data) => { emits.push({ name, data }); } },
        };
      },
    },
    storage: {
      get: async (k) => storageMap.get(k),
      set: async (k, v) => { storageMap.set(k, v); },
      remove: async (k) => { storageMap.delete(k); },
      scan: async ({ prefix }) => ({
        entries: [...storageMap.entries()]
          .filter(([k]) => String(k).startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
    mcp: {
      transform: async (fn) => {
        const editor = {
          list: () => [...mcpServers.entries()],
          get: (n) => mcpServers.get(n),
          set: (n, c) => { mcpServers.set(n, c); },
          update: (n, fn2) => { const c = mcpServers.get(n); if (c) fn2(c); },
          remove: (n) => { mcpServers.delete(n); },
        };
        fn(editor);
        return { dispose: async () => {} };
      },
      reload: async () => { host._reloads = (host._reloads || 0) + 1; },
    },
    session: {
      prompt: async () => ({}),
      hook: async (name, fn) => { hookCalls.push({ name, fn }); return { dispose: async () => {} }; },
    },
    command: {
      list: async () => ({ data: [] }),
      transform: async () => ({ dispose: () => {} }),
      reload: async () => {},
    },
    tool: { transform: async () => ({ dispose: () => {} }), reload: async () => {} },
    agent: {
      list: async () => ({ data: [] }),
      transform: async () => ({ dispose: () => {} }),
      reload: async () => {},
    },
    skill: {
      list: async () => ({ data: [] }),
      transform: async () => ({ dispose: () => {} }),
      reload: async () => {},
    },
  };
  return { host, emits, handlers, storageMap, mcpServers, hookCalls, getDef: () => def };
}

// In-memory stub of the canonical Python surface (`callMcp`) with the
// phase-01/02 hash-guard semantics: full/prefix match proceeds, mismatch is
// `stale` with a fresh snapshot, conflicting spellings are an error.
function makeStubMcp(state) {
  const calls = [];
  const impl = async (tool, args = {}) => {
    calls.push({ tool, args });
    if (tool !== "iumbtems_config") {
      return { content: JSON.stringify({ status: "error" }), status: "error" };
    }
    const keys = Object.keys(args || {});
    const readOnly = keys.every((k) =>
      ["base_dir", "show", "expected_hash", "expectedHash"].includes(k));
    if (readOnly) {
      return {
        content: JSON.stringify({
          status: "current", config: { ...state.config }, migrated: false,
        }),
        status: "success",
      };
    }
    const snake = args.expected_hash;
    const camel = args.expectedHash;
    if (snake !== undefined && camel !== undefined && String(snake) !== String(camel)) {
      return {
        content: JSON.stringify({
          status: "error", code: "CONFLICTING_EXPECTED_HASH", written: false,
        }),
        status: "success",
      };
    }
    const expected = snake !== undefined ? snake : camel;
    if (expected !== undefined && expected !== null &&
        !(state.hash || "").startsWith(String(expected))) {
      return {
        content: JSON.stringify({
          status: "stale", written: false,
          expected_hash: String(expected),
          current_hash: state.hash,
          config: { ...state.config },
        }),
        status: "success",
      };
    }
    const updates = { ...(args || {}) };
    for (const k of ["base_dir", "show", "expected_hash", "expectedHash"]) delete updates[k];
    Object.assign(state.config, updates);
    state.writes = (state.writes || 0) + 1;
    state.hash = `hash${state.writes}`;
    return {
      content: JSON.stringify({
        status: "updated", config: { ...state.config }, hash: state.hash,
      }),
      status: "success",
    };
  };
  impl.calls = calls;
  return impl;
}

// Real-host `context.error(type, message, data)` shape: throw a typed error.
function rpcCtx() {
  return {
    signal: null,
    error: (type, message, data) => {
      const e = new Error(message);
      e.type = type;
      e.data = data;
      throw e;
    },
  };
}
"""


class TestSettingsRpcDomain(unittest.TestCase):
    """C1: the `iumbtems.settings` domain registers; get/set/validate run."""

    def test_definition_shape_matches_v2_rpc_pattern(self):
        res = run_node(
            PHASE3_HOST
            + """
            const methods = Object.keys(SettingsRpc.methods).sort();
            const errorNames = Object.keys(SettingsRpc.methods.set.errors || {});
            console.log(JSON.stringify({
              id: SettingsRpc.id,
              rpcId: SETTINGS_RPC_ID,
              methods,
              getIn: SettingsRpc.methods.get.input,
              getOut: SettingsRpc.methods.get.output,
              setOutRequired: SettingsRpc.methods.set.output.required,
              events: Object.keys(SettingsRpc.events),
              changedRequired: SettingsRpc.events.changed.schema.required,
              changedType: SettingsRpc.events.changed.schema.type,
              errorNames,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["id"], "iumbtems.settings")
        self.assertEqual(d["rpcId"], "iumbtems.settings")
        self.assertEqual(d["methods"], ["get", "set", "validate"])
        # JSON-Schema I/O per the v2 RPC pattern; event data is an object.
        self.assertEqual(d["getIn"]["type"], "object")
        # R1: `get` carries the on-disk `raw` alongside the effective `config`.
        self.assertEqual(d["getOut"]["type"], "object")
        self.assertIn("raw", d["getOut"]["properties"])
        self.assertIn("config", d["getOut"]["required"])
        self.assertIn("config", d["setOutRequired"])
        self.assertIn("hash", d["setOutRequired"])
        self.assertEqual(d["events"], ["changed"])
        self.assertIn("hash", d["changedRequired"])
        self.assertEqual(d["changedType"], "object")
        # `rpc.*` error names are reserved by OpenCode and must not be used.
        self.assertFalse([n for n in d["errorNames"] if n.startswith("rpc.")])
        self.assertIn("stale", d["errorNames"])

    def test_setup_registers_rpc_domain(self):
        res = run_node(
            PHASE3_HOST
            + """
            const box = makePhase3Host("/tmp/oc-rpc-setup");
            await plugin.setup(box.host);
            const def = box.getDef();
            console.log(JSON.stringify({
              defId: def && def.id,
              handlerNames: Object.keys(box.handlers).sort(),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["defId"], "iumbtems.settings")
        self.assertEqual(d["handlerNames"], ["get", "set", "validate"])

    def test_setup_without_rpc_domain_still_works(self):
        res = run_node(
            PHASE3_HOST
            + """
            const box = makePhase3Host("/tmp/oc-rpc-bare");
            delete box.host.rpc;
            delete box.host.storage;
            delete box.host.mcp;
            delete box.host.session.hook;
            const cleanup = await plugin.setup(box.host);
            console.log(JSON.stringify({ cleanupFn: typeof cleanup }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(last_json_object(res.stdout)["cleanupFn"], "function")

    def test_get_set_validate_round_trip(self):
        res = run_node(
            PHASE3_HOST
            + """
            const box = makePhase3Host("/tmp/oc-rpc-roundtrip");
            const state = { config: { mode: "research", max_iterations: 2 }, hash: "abc123def4567890", writes: 0 };
            const callMcp = makeStubMcp(state);
            const emitted = [];
            const handlers = createSettingsHandlers({
              root: "/tmp/oc-rpc-roundtrip",
              callMcpImpl: callMcp,
              storage: box.host.storage,
              emitChanged: async (data) => { emitted.push(data); },
              reloadMcp: async () => { await box.host.mcp.reload(); },
            });
            const ctx = rpcCtx();
            const got = await handlers.get({}, ctx);
            const validated = await handlers.validate({ updates: { max_iterations: 9 } });
            const validatedOk = await handlers.validate({ updates: { mode: "audit" } });
            const written = await handlers.set({ updates: { mode: "audit" } }, ctx);
            const mirror = await box.host.storage.get(SETTINGS_STORAGE_KEY);
            console.log(JSON.stringify({
              gotMode: got.config.mode,
              gotHash: got.hash,
              invalid: validated.valid,
              invalidProblems: validated.problems.length,
              validOk: validatedOk.valid,
              writtenMode: written.config.mode,
              writtenHash: written.hash,
              emits: emitted,
              reloads: box.host._reloads || 0,
              mirrorMode: mirror && mirror.config && mirror.config.mode,
              mirrorHash: mirror && mirror.hash,
              mirrorHasUpdated: Boolean(mirror && mirror.updated),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["gotMode"], "research")
        # No config file on disk in the stubbed workspace: hash is null.
        self.assertIsNone(d["gotHash"])
        self.assertFalse(d["invalid"])
        self.assertGreater(d["invalidProblems"], 0)
        self.assertTrue(d["validOk"])
        self.assertEqual(d["writtenMode"], "audit")
        # `changed` emitted exactly once per successful write.
        self.assertEqual(len(d["emits"]), 1)
        self.assertEqual(d["emits"][0]["hash"], d["writtenHash"])
        self.assertIn("mode", d["emits"][0]["keys"])
        self.assertEqual(d["reloads"], 1)
        # Storage mirror holds the last effective config + hash.
        self.assertEqual(d["mirrorMode"], "audit")
        self.assertEqual(d["mirrorHash"], d["writtenHash"])
        self.assertTrue(d["mirrorHasUpdated"])

    def test_rpc_writes_through_canonical_python_surface(self):
        # No stub: the default callMcp spawns runner/mcp_server.py for real,
        # proving the single-writer discipline holds end to end.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            res = run_node(
                PHASE3_HOST
                + f"""
                const handlers = createSettingsHandlers({{ root: {tmp!r} }});
                const ctx = rpcCtx();
                const before = await handlers.get(ctx);
                const written = await handlers.set({{ updates: {{ mode: "audit" }} }}, ctx);
                const after = await handlers.get(ctx);
                console.log(JSON.stringify({{
                  beforeMode: before.config.mode,
                  writtenMode: written.config.mode,
                  hashLen: String(written.hash || "").length,
                  afterMode: after.config.mode,
                }}));
                """
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            self.assertEqual(d["beforeMode"], "research")
            self.assertEqual(d["writtenMode"], "audit")
            self.assertEqual(d["hashLen"], 64)
            self.assertEqual(d["afterMode"], "audit")


class TestSettingsRpcGuards(unittest.TestCase):
    """C3: stale/conflicting/malformed guards reject with no write."""

    def test_stale_expected_hash_returns_structured_error(self):
        res = run_node(
            PHASE3_HOST
            + """
            const box = makePhase3Host("/tmp/oc-rpc-stale");
            const state = { config: { mode: "audit" }, hash: "abcdef1234567890", writes: 0 };
            const callMcp = makeStubMcp(state);
            const emitted = [];
            const handlers = createSettingsHandlers({
              root: "/tmp/oc-rpc-stale",
              callMcpImpl: callMcp,
              storage: box.host.storage,
              emitChanged: async (data) => { emitted.push(data); },
            });
            const ctx = rpcCtx();
            let failure = null;
            try {
              await handlers.set({ updates: { mode: "research" }, expected_hash: "deadbeef00" }, ctx);
            } catch (e) { failure = { type: e.type, data: e.data }; }
            const mirror = await box.host.storage.get(SETTINGS_STORAGE_KEY);
            console.log(JSON.stringify({
              failureType: failure && failure.type,
              currentHash: failure && failure.data && failure.data.current_hash,
              freshMode: failure && failure.data && failure.data.config && failure.data.config.mode,
              writtenFlag: failure && failure.data && failure.data.written,
              writes: state.writes,
              emits: emitted.length,
              mirror: mirror === undefined ? null : mirror,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["failureType"], "stale")
        self.assertEqual(d["currentHash"], "abcdef1234567890")
        self.assertEqual(d["freshMode"], "audit")
        self.assertFalse(d["writtenFlag"])
        self.assertEqual(d["writes"], 0)
        self.assertEqual(d["emits"], 0)
        self.assertIsNone(d["mirror"])

    def test_conflicting_spellings_rejected_without_call(self):
        res = run_node(
            PHASE3_HOST
            + """
            const box = makePhase3Host("/tmp/oc-rpc-conflict");
            const state = { config: { mode: "audit" }, hash: "abcdef1234567890", writes: 0 };
            const callMcp = makeStubMcp(state);
            const handlers = createSettingsHandlers({
              root: "/tmp/oc-rpc-conflict", callMcpImpl: callMcp,
            });
            const ctx = rpcCtx();
            let failure = null;
            try {
              await handlers.set(
                { updates: { mode: "research" }, expected_hash: "abcdef1234567890", expectedHash: "00000000" },
                ctx
              );
            } catch (e) { failure = { type: e.type, message: e.message }; }
            console.log(JSON.stringify({
              failureType: failure && failure.type,
              calls: callMcp.calls.length,
              writes: state.writes,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["failureType"], "conflict")
        self.assertEqual(d["calls"], 0)
        self.assertEqual(d["writes"], 0)

    def test_malformed_guard_rejected_without_call(self):
        res = run_node(
            PHASE3_HOST
            + """
            const box = makePhase3Host("/tmp/oc-rpc-malformed");
            const state = { config: {}, hash: "abcdef1234567890", writes: 0 };
            const callMcp = makeStubMcp(state);
            const handlers = createSettingsHandlers({
              root: "/tmp/oc-rpc-malformed", callMcpImpl: callMcp,
            });
            const ctx = rpcCtx();
            const types = [];
            for (const guard of ["abcd", "xyz-not-hex", "12"]) {
              try {
                await handlers.set({ updates: { mode: "research" }, expectedHash: guard }, ctx);
                types.push("accepted:" + guard);
              } catch (e) { types.push(e.type); }
            }
            // Equal spellings carrying the live hash proceed.
            const ok = await handlers.set(
              { updates: { mode: "research" }, expected_hash: "abcdef1234567890", expectedHash: "abcdef1234567890" },
              ctx
            );
            console.log(JSON.stringify({ types, okMode: ok.config.mode, calls: callMcp.calls.length }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["types"], ["invalid", "invalid", "invalid"])
        self.assertEqual(d["okMode"], "research")
        # Only the accepted write reached the canonical surface.
        self.assertEqual(d["calls"], 1)


class TestMcpToggleReconcile(unittest.TestCase):
    """C5: `ctx.mcp.transform` applies `disabled`; the catalog is untouched."""

    def test_controllable_set_matches_catalog(self):
        res = run_node(
            PHASE3_HOST
            + """
            import fs from "node:fs";
            import path from "node:path";
            const catalog = JSON.parse(
              fs.readFileSync("config/mcp-research-servers.json", "utf-8")
            );
            console.log(JSON.stringify({
              controllable: loadControllableMcpServers().sort(),
              catalogKeys: Object.keys(catalog.mcpServers || {}).sort(),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["controllable"], d["catalogKeys"])
        self.assertIn("iumbtems", d["controllable"])

    def test_resolve_toggles_triple_gate(self):
        res = run_node(
            PHASE3_HOST
            + """
            const toggles = resolveMcpToggles(
              { searxng: false, iumbtems: true, "custom-evil": false, nope: false, bad: "x" },
              ["iumbtems", "searxng", "custom-evil"],
              ["iumbtems", "searxng", "brave-search", "firecrawl"]
            );
            console.log(JSON.stringify({ toggles }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        toggles = last_json_object(res.stdout)["toggles"]
        # searxng disables; iumbtems:true reconciles to disabled:false;
        # custom-evil is not controllable, nope is not in the registry,
        # bad is not a boolean.
        self.assertEqual(
            toggles,
            [
                {"name": "searxng", "disabled": True},
                {"name": "iumbtems", "disabled": False},
            ],
        )

    def test_transform_applies_disabled_from_persisted_map(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            research = Path(tmp) / ".research"
            research.mkdir()
            research.joinpath("config.json").write_text(
                json.dumps({"mcp_servers": {"searxng": False}}),
                encoding="utf-8",
            )
            res = run_node(
                PHASE3_HOST
                + f"""
                const box = makePhase3Host({tmp!r});
                const reg = await registerMcpToggles(box.host, {{ root: {tmp!r} }});
                const servers = Object.fromEntries(box.mcpServers);
                console.log(JSON.stringify({{
                  registered: Boolean(reg),
                  searxngDisabled: servers.searxng && servers.searxng.disabled,
                  iumbtemsKeys: Object.keys(servers.iumbtems || {{}}),
                  evilKeys: Object.keys(servers["custom-evil"] || {{}}),
                }}));
                """
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            self.assertTrue(d["registered"])
            self.assertTrue(d["searxngDisabled"])
            self.assertEqual(d["iumbtemsKeys"], [])
            self.assertEqual(d["evilKeys"], [])

    def test_catalog_file_byte_identical(self):
        catalog = PROJECT_ROOT / "config" / "mcp-research-servers.json"
        before = catalog.read_bytes()
        res = run_node(
            PHASE3_HOST
            + """
            const box = makePhase3Host("/tmp/oc-mcp-catalog");
            await plugin.setup(box.host);
            console.log(JSON.stringify({ ok: true }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(catalog.read_bytes(), before)

    def test_mcp_domain_absent_is_graceful(self):
        res = run_node(
            PHASE3_HOST
            + """
            const box = makePhase3Host("/tmp/oc-mcp-bare");
            delete box.host.mcp;
            const reg = await registerMcpToggles(box.host, { root: "/tmp/oc-mcp-bare" });
            console.log(JSON.stringify({ reg }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIsNone(last_json_object(res.stdout)["reg"])


class TestTemperatureHook(unittest.TestCase):
    """C6 (wired half): the context hook keys off `event.agent`."""

    HOOK_FIRE = """
            const box = makePhase3Host("/tmp/oc-temp");
            const reg = await registerTemperatureHook(box.host, { env: {
              IUMBTEMS_TEMPERATURE_ALPHA: "0.2",
              IUMBTEMS_TEMPERATURE_BETA: "not-a-number",
            }});
            const hook = box.hookCalls.find((h) => h.name === "context");
    """

    def test_hook_registered_and_keyed_off_event_agent(self):
        res = run_node(
            PHASE3_HOST
            + self.HOOK_FIRE
            + """
            // The role comes from `event.agent` (type-guaranteed SessionContext),
            // never from the IUMBTEMS_AGENT_ROLE env var: a hostile env naming
            // beta must not move an alpha request.
            process.env.IUMBTEMS_AGENT_ROLE = "beta";
            const alpha = { agent: "alpha", options: {} };
            const beta = { agent: "beta", options: {} };
            const noAgent = { options: {} };
            hook.fn(alpha);
            hook.fn(beta);
            hook.fn(noAgent);
            console.log(JSON.stringify({
              registered: Boolean(reg),
              hookName: hook && hook.name,
              alphaTemp: alpha.options.temperature,
              betaHasTemp: Object.prototype.hasOwnProperty.call(beta.options, "temperature"),
              noAgentHasTemp: Object.prototype.hasOwnProperty.call(noAgent.options, "temperature"),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertTrue(d["registered"])
        self.assertEqual(d["hookName"], "context")
        self.assertEqual(d["alphaTemp"], 0.2)
        self.assertFalse(d["betaHasTemp"])
        self.assertFalse(d["noAgentHasTemp"])

    def test_temperature_bounds(self):
        res = run_node(
            PHASE3_HOST
            + """
            const env = {
              IUMBTEMS_TEMPERATURE_ALPHA: "0.2",
              IUMBTEMS_TEMPERATURE_BETA: "high",
              IUMBTEMS_TEMPERATURE_GAMMA: "5",
              IUMBTEMS_TEMPERATURE_DELTA: "",
            };
            const generic = { IUMBTEMS_TEMPERATURE: "0.7" };
            console.log(JSON.stringify({
              alpha: temperatureForRole("alpha", env) ?? null,
              beta: temperatureForRole("beta", env) ?? null,
              gamma: temperatureForRole("gamma", env) ?? null,
              delta: temperatureForRole("delta", env) ?? null,
              missing: temperatureForRole("zeta", env) ?? null,
              empty: temperatureForRole("", env) ?? null,
              genericAlpha: temperatureForRole("alpha", generic) ?? null,
              applied: applyTemperatureToContext({ agent: "alpha", options: {} }, env),
              skipped: applyTemperatureToContext({ options: {} }, env),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["alpha"], 0.2)
        self.assertIsNone(d["beta"])
        self.assertIsNone(d["gamma"])
        self.assertIsNone(d["delta"])
        self.assertIsNone(d["missing"])
        self.assertIsNone(d["empty"])
        self.assertEqual(d["genericAlpha"], 0.7)
        self.assertTrue(d["applied"])
        self.assertFalse(d["skipped"])

    def test_hook_domain_absent_is_graceful(self):
        res = run_node(
            PHASE3_HOST
            + """
            const reg = await registerTemperatureHook({}, {});
            console.log(JSON.stringify({ reg }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIsNone(last_json_object(res.stdout)["reg"])


class TestS3SpikeHarness(unittest.TestCase):
    """C6 (spike): `IUMBTEMS_AGENT_ROLE` reaches the spawned child env.

    Bounded by the phase brief: local stub harness only — no model spend, no
    network. The dated outcome is recorded in the phase receipt: the runner
    env leg and the in-host hook leg are verified below; whether a live
    `opencode run` child loads the project plugin and honors the hook is
    NEGATIVE_KNOWLEDGE (unobservable without spending a model call).
    """

    def test_role_exported_to_child_env(self):
        import os
        from unittest import mock

        from runner.research_swarm import _config_child_env

        with mock.patch.dict(os.environ, {}, clear=True):
            env = _config_child_env(
                Path("/tmp/proj/.research"), "/tmp/proj", {}, role="alpha"
            )
            self.assertEqual(env["IUMBTEMS_AGENT_ROLE"], "alpha")
            beta = _config_child_env(
                Path("/tmp/proj/.research"), "/tmp/proj", {}, role="beta"
            )
            self.assertEqual(beta["IUMBTEMS_AGENT_ROLE"], "beta")
            # Absent/empty role exports nothing (byte-identical default path).
            for blank in (None, ""):
                plain = _config_child_env(
                    Path("/tmp/proj/.research"), "/tmp/proj", {}, role=blank
                )
                self.assertNotIn("IUMBTEMS_AGENT_ROLE", plain)
            # The pre-existing channels are unchanged by the new parameter.
            self.assertEqual(env["PWD"], "/tmp/proj")
            self.assertEqual(env["IUMBTEMS_RESEARCH_DIR"], "/tmp/proj/.research")

    def test_spawn_wiring_carries_role(self):
        import json as _json
        import os
        import tempfile
        from unittest import mock

        from runner.research_swarm import SwarmRunner

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True, exist_ok=True)
            (base / "config.json").write_text(
                _json.dumps({"searxng_url": "http://searx.local:8888"}),
                encoding="utf-8",
            )
            runner = SwarmRunner(base_dir=base, mock_mode=False, mode="research")
            fake = mock.Mock()
            fake.stdout = "ok"
            with mock.patch.dict(os.environ, {}, clear=True):
                with mock.patch("subprocess.run", return_value=fake) as run_mock:
                    runner.run_claude_process("objective text", role="beta")
            kwargs = run_mock.call_args.kwargs
            self.assertEqual(kwargs["env"]["IUMBTEMS_AGENT_ROLE"], "beta")
            # Default callers (no role) keep the historical shape.
            with mock.patch.dict(os.environ, {}, clear=True):
                with mock.patch("subprocess.run", return_value=fake) as run_mock:
                    runner.run_claude_process("objective text")
            kwargs = run_mock.call_args.kwargs
            self.assertEqual(kwargs["env"]["IUMBTEMS_AGENT_ROLE"], "alpha")

    def test_stub_child_observes_role_in_its_env(self):
        # OS-level leg: a stub child spawned with the produced env observes
        # IUMBTEMS_AGENT_ROLE. No model, no network — pure env plumbing.
        import os
        import subprocess
        import sys
        import tempfile
        from unittest import mock

        from runner.research_swarm import _config_child_env

        with tempfile.TemporaryDirectory() as tmp:
            probe = Path(tmp) / "role_probe.py"
            probe.write_text(
                "import os, sys; sys.stdout.write(os.environ.get("
                "'IUMBTEMS_AGENT_ROLE', '<absent>'))",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {}, clear=True):
                env = _config_child_env(Path(tmp) / ".research", tmp, {}, role="beta")
                out = subprocess.run(
                    [sys.executable, str(probe)],
                    capture_output=True,
                    text=True,
                    env=env,
                )
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(out.stdout, "beta")


class TestFallbackMirrorConvergence(unittest.TestCase):
    """Phase-03 R1: fallback-write -> RPC-get-fresh + mirror-converged.

    The degraded path honestly stays degraded, but the mirror must not lie
    permanently: every server-mediated read refreshes it to disk truth
    (refresh-on-read; no new protocol). The stub below is file-backed so the
    single-read snapshot (phase-03 R5) exercises real disk bytes end to end.
    """

    FILE_BACKED = """
    const __fs = await import("node:fs");
    const __crypto = await import("node:crypto");
    const __path = await import("node:path");
    const fs = __fs.default || __fs;
    const fspath = __path.default || __path;
    const shaFile = (f) => __crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    // File-backed stub of the canonical surface: show reads the real file,
    // set guards + writes the real file. The handler's single-read snapshot
    // therefore sees the same bytes a production fallback write leaves.
    function makeFileBackedMcp(cfgFile) {
      const calls = [];
      const impl = async (tool, args = {}) => {
        calls.push(args);
        const read = () => JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
        const keys = Object.keys(args || {});
        const readOnly = keys.every((k) =>
          ["base_dir", "show", "expected_hash", "expectedHash"].includes(k));
        if (readOnly) {
          return {
            content: JSON.stringify({ status: "current", config: read(), migrated: false }),
            status: "success",
          };
        }
        const exp = args.expected_hash !== undefined ? args.expected_hash : args.expectedHash;
        const cur = shaFile(cfgFile);
        if (exp !== undefined && exp !== null && !cur.startsWith(String(exp))) {
          return {
            content: JSON.stringify({
              status: "stale", written: false,
              expected_hash: String(exp), current_hash: cur, config: read(),
            }),
            status: "success",
          };
        }
        const updates = { ...(args || {}) };
        for (const k of ["base_dir", "show", "expected_hash", "expectedHash"]) delete updates[k];
        const next = { ...read(), ...updates };
        fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2));
        return {
          content: JSON.stringify({ status: "updated", config: next, hash: shaFile(cfgFile) }),
          status: "success",
        };
      };
      impl.calls = calls;
      return impl;
    }
    """

    def test_fallback_write_then_get_refreshes_mirror(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            research = Path(tmp) / ".research"
            research.mkdir()
            cfg = research / "config.json"
            cfg.write_text(json.dumps({"mode": "research"}), encoding="utf-8")
            res = run_node(
                PHASE3_HOST
                + self.FILE_BACKED
                + f"""
                const cfgFile = {str(cfg)!r};
                const box = makePhase3Host({tmp!r});
                const callMcp = makeFileBackedMcp(cfgFile);
                const emitted = [];
                const handlers = createSettingsHandlers({{
                  root: {tmp!r},
                  callMcpImpl: callMcp,
                  storage: box.host.storage,
                  emitChanged: async (data) => {{ emitted.push(data); }},
                }});
                const ctx = rpcCtx();
                // 1. RPC-leg write: mirror holds the written snapshot.
                await handlers.set({{ updates: {{ mode: "audit" }} }}, ctx);
                const afterSet = await box.host.storage.get(SETTINGS_STORAGE_KEY);
                // 2. Fallback-leg write: direct-fs, bypassing RPC and the mirror
                // (exactly what the degraded TUI path does via config-io.js).
                fs.writeFileSync(cfgFile, JSON.stringify({{ mode: "scout" }}, null, 2));
                const staleMirror = await box.host.storage.get(SETTINGS_STORAGE_KEY);
                // 3. Next server-mediated read: disk truth + converged mirror.
                const got = await handlers.get({{}}, ctx);
                const converged = await box.host.storage.get(SETTINGS_STORAGE_KEY);
                console.log(JSON.stringify({{
                  mirrorAfterSet: afterSet && afterSet.config.mode,
                  mirrorWasStale: staleMirror && staleMirror.config.mode,
                  gotMode: got.config.mode,
                  gotHash: got.hash,
                  diskHash: shaFile(cfgFile),
                  mirrorMode: converged && converged.config.mode,
                  mirrorHash: converged && converged.hash,
                  extraEmits: emitted.length,
                }}));
                """
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            self.assertEqual(d["mirrorAfterSet"], "audit")
            # The test is not vacuous: the mirror genuinely lagged disk.
            self.assertEqual(d["mirrorWasStale"], "audit")
            # The read returns disk truth and the mirror converges to it.
            self.assertEqual(d["gotMode"], "scout")
            self.assertEqual(d["gotHash"], d["diskHash"])
            self.assertEqual(d["mirrorMode"], "scout")
            self.assertEqual(d["mirrorHash"], d["diskHash"])
            # Convergence emits nothing: `changed` fires on writes, not reads.
            self.assertEqual(d["extraEmits"], 1)


class TestSingleReadSnapshot(unittest.TestCase):
    """Phase-03 R5: no era mixing — config, hash, and mirror are one snapshot.

    Torn-race repro (qa-b section E shape): the Python payload is built from
    era-A bytes while the disk is mutated to era-B mid-call. The handler must
    return a coherent pair from a single disk read — an era-A config with an
    era-B hash must be impossible.
    """

    def test_torn_race_cannot_mix_eras(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            research = Path(tmp) / ".research"
            research.mkdir()
            cfg = research / "config.json"
            era_a = {"mode": "scout"}
            era_b = {"mode": "audit"}
            cfg.write_text(json.dumps(era_a), encoding="utf-8")
            res = run_node(
                PHASE3_HOST
                + f"""
                import {{ createHash }} from "node:crypto";
                import fs from "node:fs";
                const cfgFile = {str(cfg)!r};
                const shaBytes = (b) => createHash("sha256").update(b).digest("hex");
                const bytesA = fs.readFileSync(cfgFile);
                const box = makePhase3Host({tmp!r});
                // Payload built from era-A bytes; disk mutated to era-B while
                // the "Python surface" is in flight.
                const callMcp = async () => {{
                  await new Promise((r) => setTimeout(r, 15));
                  fs.writeFileSync(cfgFile, JSON.stringify({json.dumps(era_b)}, null, 2));
                  return {{
                    content: JSON.stringify({{
                      status: "current",
                      config: JSON.parse(String(bytesA)),
                      migrated: false,
                    }}),
                    status: "success",
                  }};
                }};
                const handlers = createSettingsHandlers({{
                  root: {tmp!r},
                  callMcpImpl: callMcp,
                  storage: box.host.storage,
                }});
                const got = await handlers.get({{}}, rpcCtx());
                const mirror = await box.host.storage.get(SETTINGS_STORAGE_KEY);
                const bytesB = fs.readFileSync(cfgFile);
                console.log(JSON.stringify({{
                  gotMode: got.config.mode,
                  gotHash: got.hash,
                  shaA: shaBytes(bytesA),
                  shaB: shaBytes(bytesB),
                  mirrorMode: mirror && mirror.config.mode,
                  mirrorHash: mirror && mirror.hash,
                }}));
                """
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            # Coherence: the pair matches exactly one era — never scout+shaB.
            coherent = (d["gotMode"], d["gotHash"]) in (
                ("scout", d["shaA"]),
                ("audit", d["shaB"]),
            )
            self.assertTrue(
                coherent,
                f"era mixing: mode={d['gotMode']} hash matches neither era",
            )
            self.assertFalse(
                d["gotMode"] == "scout" and d["gotHash"] == d["shaB"],
                "era-A config with era-B hash",
            )
            # The mirror converges to the same coherent pair.
            self.assertEqual(d["mirrorMode"], d["gotMode"])
            self.assertEqual(d["mirrorHash"], d["gotHash"])

    def test_get_payload_carries_raw_and_effective_from_one_read(self):
        """R1: `get` carries the on-disk `raw` alongside the merged effective
        `config`, and the hash covers the same bytes (single-read preserved)."""
        import hashlib
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            research = Path(tmp) / ".research"
            research.mkdir()
            cfg = research / "config.json"
            on_disk = {"mode": "scout"}
            cfg.write_text(json.dumps(on_disk), encoding="utf-8")
            res = run_node(
                PHASE3_HOST
                + f"""
                const box = makePhase3Host({tmp!r});
                const stub = async () => ({{
                  content: JSON.stringify({{ status: "current", config: {{}}, migrated: false }}),
                  status: "success",
                }});
                const handlers = createSettingsHandlers({{
                  root: {tmp!r},
                  callMcpImpl: stub,
                  storage: box.host.storage,
                }});
                const got = await handlers.get({{}}, rpcCtx());
                console.log(JSON.stringify({{
                  raw: got.raw,
                  effectiveMode: got.config.mode,
                  effectiveHasDefaults: ("search_engine" in got.config) && ("max_iterations" in got.config),
                  rawHasSearchEngine: Boolean(got.raw && ("search_engine" in got.raw)),
                  hash: got.hash,
                }}));
                """
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            # `raw` is exactly the on-disk file config (not the merged result).
            self.assertEqual(d["raw"], on_disk)
            self.assertFalse(d["rawHasSearchEngine"])
            # `config` is the merged effective config.
            self.assertEqual(d["effectiveMode"], "scout")
            self.assertTrue(d["effectiveHasDefaults"])
            # Single-read: the hash is of the same bytes `raw` was parsed from.
            self.assertEqual(d["hash"], hashlib.sha256(cfg.read_bytes()).hexdigest())


class TestRpcGetSanitizedError(unittest.TestCase):
    """Phase-03 R4b: `get` spawn failures are structured, fail-closed errors."""

    def test_spawn_enoent_never_leaks_internals(self):
        res = run_node(
            PHASE3_HOST
            + """
            const box = makePhase3Host("/tmp/oc-r4b-enoent");
            const throwing = async () => {
              const err = new Error("spawn python3 ENOENT");
              err.code = "ENOENT";
              throw err;
            };
            const garbage = async () => ({ content: "garbage{{{not json", status: "error" });
            const results = [];
            for (const impl of [throwing, garbage]) {
              const handlers = createSettingsHandlers({
                root: "/tmp/oc-r4b-enoent",
                callMcpImpl: impl,
                storage: box.host.storage,
              });
              try {
                await handlers.get({}, rpcCtx());
                results.push({ threw: false });
              } catch (e) {
                results.push({
                  threw: true,
                  code: e.code || null,
                  leaksEnoent: String(e.message).includes("ENOENT"),
                  leaksRaw: String(e.message).includes("garbage"),
                });
              }
            }
            const mirror = await box.host.storage.get(SETTINGS_STORAGE_KEY);
            console.log(JSON.stringify({
              results,
              mirror: mirror === undefined ? null : mirror,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        for r in d["results"]:
            self.assertTrue(r["threw"])
            self.assertEqual(r["code"], "SETTINGS_RPC_UNAVAILABLE")
            self.assertFalse(r["leaksEnoent"])
            self.assertFalse(r["leaksRaw"])
        # Fail-closed: nothing was mirrored on a failed read.
        self.assertIsNone(d["mirror"])


class TestSetLegSanitizedErrors(unittest.TestCase):
    """Phase-03 R7/R9: `set` failure payloads carry no tracebacks/paths.

    R9 de-circularization: the fixtures and the expected sanitized strings are
    INDEPENDENT of the sanitizer's implementation — there is no shared regex
    here. The fixtures are real interpreter stderr (any POSIX root),
    Windows-drive and UNC paths, a `File "…", line N` frame, and a clean schema
    message; the mixed list proves PER-ITEM sanitization (the pre-R9
    all-or-nothing `list.every` would collapse the whole list to one reason).
    """

    FIXED = (
        "Config write rejected: canonical config surface returned an "
        "unreadable failure."
    )
    CLEAN = "mode: value 'nope' not in enum ['research', 'audit']"

    def test_set_failure_payload_sweep(self):
        res = run_node(
            PHASE3_HOST
            + r"""
            const box = makePhase3Host("/tmp/oc-r9-sweep");
            const fixtures = {
              posixStderr: "python3: can't open file '/workspace/nope/runner/mcp_server.py': [Errno 2] No such file or directory",
              windowsDrive: "C:\\Users\\x\\AppData\\Local\\Temp\\iumbtems\\config.json",
              uncShare: "\\\\fileserver\\share\\iumbtems\\config.json",
              fileLine: '  File "/srv/app/runner/mcp_server.py", line 42, in _handle_config',
              cleanEnum: "mode: value 'nope' not in enum ['research', 'audit']",
            };
            const call = async (impl) => {
              const handlers = createSettingsHandlers({
                root: "/tmp/oc-r9-sweep",
                callMcpImpl: impl,
                storage: box.host.storage,
              });
              try {
                await handlers.set({ updates: { mode: "scout" } }, rpcCtx());
                return { threw: false };
              } catch (e) {
                const data = e.data || e.rpcData || {};
                return { threw: true, type: e.type || e.rpcType || null, written: data.written, errors: data.errors || null };
              }
            };
            const listImpl = (items) => async () => ({
              content: JSON.stringify({ status: "error", code: "CONFIG_VALIDATION_FAILED", written: false, errors: items }),
              status: "success",
            });
            const rawImpl = (text) => async () => ({ content: text, status: "error" });
            const out = {};
            out.posixStderr = await call(listImpl([fixtures.posixStderr]));
            out.windowsDrive = await call(listImpl([fixtures.windowsDrive]));
            out.uncShare = await call(listImpl([fixtures.uncShare]));
            out.fileLine = await call(listImpl([fixtures.fileLine]));
            out.cleanEnum = await call(listImpl([fixtures.cleanEnum]));
            out.mixed = await call(listImpl([fixtures.cleanEnum, fixtures.posixStderr]));
            out.rawStderr = await call(rawImpl(fixtures.posixStderr));
            console.log(JSON.stringify(out));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        # Every leaking fixture (JSON error list or raw non-JSON stderr) is
        # replaced by the fixed reason, and nothing is written.
        for name in (
            "posixStderr",
            "windowsDrive",
            "uncShare",
            "fileLine",
            "rawStderr",
        ):
            self.assertTrue(d[name]["threw"], name)
            self.assertEqual(d[name]["type"], "invalid", name)
            self.assertFalse(d[name]["written"], name)
            self.assertEqual(d[name]["errors"], [self.FIXED], name)
        # A clean schema message passes through untouched (no over-sanitization).
        self.assertTrue(d["cleanEnum"]["threw"])
        self.assertEqual(d["cleanEnum"]["errors"], [self.CLEAN])
        # PER-ITEM: the clean entry survives while only the leaking entry is
        # replaced (the pre-R9 list.every would have returned just [FIXED]).
        self.assertEqual(d["mixed"]["errors"], [self.CLEAN, self.FIXED])


if __name__ == "__main__":
    unittest.main()
