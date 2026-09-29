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
        # Phase 03 owns mcp_servers: it must stay out of the schema AND the ad.
        self.assertNotIn("mcp_servers", advertised["properties"])
        self.assertNotIn("mcp_servers", artifact["properties"])
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


if __name__ == "__main__":
    unittest.main()
