#!/usr/bin/env python3
"""Tests for OpenCode V2 agent/skill registration and command agent switching.

Live gap (ses_f1b924bdaffe): the /factory command declared `agent: manager`,
but no agent profiles existed (config snippet never installed) so every step
ran as the generic `build` agent, and skills were undiscoverable — the agent
ran `find / -name factory.py` to learn its own mechanics. These tests pin the
plugin-side fix: profiles and skills are registered through the V2 domains, and
the command switches the session agent.
"""

import json
import subprocess
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

V2_HOST = """
const reg = {agents: [], skills: [], commands: [], tools: [], prompts: [], switches: []};
const host = {
  options: {},
  location: {directory: '/home/john/Projects/STC'},
  command: {list: async()=>({data:[]}), transform: async(fn)=>{fn({add:(x)=>{reg.commands.push(x);}}); return {dispose:()=>{}};}, reload: async()=>{}},
  tool: {transform: async(fn)=>{fn({add:(t)=>{reg.tools.push(t);}}); return {dispose:()=>{}};}, reload: async()=>{}},
  agent: {list: async()=>({data:[]}), transform: async(fn)=>{fn({add:(a)=>{reg.agents.push(a);}}); return {dispose:()=>{}};}, reload: async()=>{}},
  skill: {list: async()=>({data:[]}), transform: async(fn)=>{fn({add:(s)=>{reg.skills.push(s);}}); return {dispose:()=>{}};}, reload: async()=>{}},
  session: {
    prompt: async(p)=>{reg.prompts.push(p); return {};},
    switchAgent: async(a)=>{reg.switches.push(a); return {};}
  }
};
"""


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
            const manager = reg.agents.find(a => a.id === 'manager');
            const qa = reg.agents.find(a => a.id === 'qa-a');
            const factory = reg.skills.find(s => s.id === 'factory');
            console.log(JSON.stringify({
              agentIds: reg.agents.map(a => a.id).sort(),
              managerMode: manager?.mode,
              managerSystem: Boolean(manager?.system),
              managerPermissions: manager?.permissions?.length || 0,
              managerDeniesEdit: (manager?.permissions || []).some(p => p.action === 'edit' && p.effect === 'deny'),
              qaMode: qa?.mode,
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
        self.assertIn("factory", d["skillIds"])
        self.assertIn("darkharvest", d["skillIds"])
        self.assertTrue(d["factoryHasContent"])
        self.assertTrue(d["factoryPath"].endswith("skills/factory/SKILL.md"))

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
              promptAgent: reg.prompts[0]?.agent,
              promptHasArena: reg.prompts[0]?.text?.includes('Cockpit beta'),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertTrue(d["switches"], "switchAgent was never called")
        self.assertEqual(d["promptAgent"], "manager")
        self.assertTrue(d["promptHasArena"])

    def test_preexisting_agent_and_skill_preserved(self):
        res = run_node(
            """
            const agents = [], skills = [];
            const host = {
              options: {}, location: {directory: '/tmp'},
              command: {list: async()=>({data:[]}), transform: async(fn)=>{fn({add:()=>{}}); return {dispose:()=>{}};}, reload: async()=>{}},
              tool: {transform: async()=>({dispose:()=>{}}), reload: async()=>{}},
              agent: {
                list: async()=>({data:[{id:'manager'}]}),
                transform: async(fn)=>{fn({add:(a)=>{agents.push(a.id);}}); return {dispose:()=>{}};},
                reload: async()=>{}
              },
              skill: {
                list: async()=>({data:[{id:'factory'}]}),
                transform: async(fn)=>{fn({add:(s)=>{skills.push(s.id);}}); return {dispose:()=>{}};},
                reload: async()=>{}
              },
              session: {prompt: async()=>({})}
            };
            import plugin from "./plugins/opencode/index.js";
            await plugin.setup(host);
            console.log(JSON.stringify({agents, skills}));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertNotIn("manager", d["agents"], "user-defined manager must win")
        self.assertNotIn("factory", d["skills"], "user-defined factory skill must win")
        self.assertIn("qa-a", d["agents"])

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
