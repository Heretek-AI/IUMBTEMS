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


if __name__ == "__main__":
    unittest.main()
