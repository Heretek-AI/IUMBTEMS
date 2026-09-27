#!/usr/bin/env python3
"""Tests for Claude Code plugin surfaces: manifests, agents, modular sync, evals.

Per https://code.claude.com/docs/en/plugins/create (manifest + layout),
/components (skills/agents/hooks/MCP), and /plugin-evals (suite layout).
Behavioral eval runs are billable and stay in CI (plugin-evals.yml); here we
assert suite structure only.
"""

import json
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(PROJECT_ROOT))

MODULAR = {
    "socratic-grilling": "grilling",
    "research-cache": "research_cache",
    "darkharvest": "darkharvest",
    "factory": "factory",
}


def parse_frontmatter(path):
    text = Path(path).read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    end = text.find("---", 3)
    if end < 0:
        return {}
    data = {}
    for line in text[3:end].strip().splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            data[k.strip()] = v.strip()
    return data


class TestClaudeManifests(unittest.TestCase):
    def test_root_manifest_lists_all_nine_skills(self):
        manifest = json.loads(
            (PROJECT_ROOT / ".claude-plugin" / "plugin.json").read_text()
        )
        self.assertEqual(manifest["name"], "epistemic-swarm")
        for skill in (
            "grilling",
            "research_cache",
            "epistemic_search",
            "swarm_config",
            "code_audit",
            "oss_scout",
            "brainstorming",
            "darkharvest",
            "factory",
        ):
            self.assertIn(f"./skills/{skill}", manifest["skills"])

    def test_marketplace_entries_resolve(self):
        marketplace = json.loads(
            (PROJECT_ROOT / ".claude-plugin" / "marketplace.json").read_text()
        )
        names = [p["name"] for p in marketplace["plugins"]]
        for name in (
            "epistemic-swarm",
            "socratic-grilling",
            "research-cache",
            "darkharvest",
            "factory",
        ):
            self.assertIn(name, names)
        for plugin in marketplace["plugins"]:
            if plugin["name"] == "epistemic-swarm":
                continue
            plugin_json = (
                PROJECT_ROOT
                / plugin["source"].lstrip("./")
                / ".claude-plugin"
                / "plugin.json"
            )
            self.assertTrue(plugin_json.is_file(), f"missing {plugin_json}")
            data = json.loads(plugin_json.read_text())
            self.assertEqual(data["name"], plugin["name"])

    def test_modular_skills_in_sync(self):
        for mod, skill in MODULAR.items():
            src = PROJECT_ROOT / "skills" / skill
            dst = PROJECT_ROOT / "plugins" / mod / "skills" / skill
            self.assertTrue((dst / "SKILL.md").is_file(), f"missing {dst}")
            src_files = {
                p.relative_to(src)
                for p in src.rglob("*")
                if p.is_file() and "__pycache__" not in p.parts
            }
            dst_files = {
                p.relative_to(dst)
                for p in dst.rglob("*")
                if p.is_file() and "__pycache__" not in p.parts
            }
            self.assertEqual(src_files, dst_files, f"drift in {mod}")
            for rel in src_files:
                self.assertEqual(
                    (src / rel).read_bytes(),
                    (dst / rel).read_bytes(),
                    f"content drift: {mod}/{rel}",
                )


class TestClaudeAgents(unittest.TestCase):
    AGENTS = {
        "agents/alpha-thesis.md": "alpha-thesis",
        "agents/beta-antithesis.md": "beta-antithesis",
        "agents/epistemic-auditor.md": "epistemic-auditor",
        "plugins/darkharvest/agents/harvest-proponent.md": "harvest-proponent",
        "plugins/darkharvest/agents/harvest-redteam.md": "harvest-redteam",
        "plugins/factory/agents/factory-manager.md": "factory-manager",
        "plugins/factory/agents/programmer.md": "programmer",
        "plugins/factory/agents/qa-functional.md": "qa-functional",
        "plugins/factory/agents/qa-adversarial.md": "qa-adversarial",
    }

    def test_agent_frontmatter(self):
        for rel, expected_name in self.AGENTS.items():
            fm = parse_frontmatter(PROJECT_ROOT / rel)
            self.assertEqual(fm.get("name"), expected_name, rel)
            self.assertTrue(fm.get("description"), f"no description: {rel}")
            self.assertIn("model", fm, f"no model: {rel}")
            for banned in ("permissionMode", "hooks", "mcpServers", "initialPrompt"):
                self.assertNotIn(banned, fm, f"banned field in {rel}")


class TestClaudeEvals(unittest.TestCase):
    CASES = {
        "evals/grill-fires": "grilling",
        "evals/darkharvest-fires": "darkharvest",
        "evals/factory-gate": "factory",
        "plugins/darkharvest/evals/teardown-verdict": "darkharvest",
        "plugins/factory/evals/gate-halt": "factory",
    }

    def test_eval_suite_structure(self):
        for case, skill in self.CASES.items():
            prompt = PROJECT_ROOT / case / "prompt.md"
            self.assertTrue(prompt.is_file(), f"missing {prompt}")
            body = prompt.read_text(encoding="utf-8")
            self.assertIn("allowed_tools", body)
            graders = sorted((PROJECT_ROOT / case / "graders").glob("*.md"))
            self.assertTrue(graders, f"no graders in {case}")
            kinds = set()
            for g in graders:
                fm = parse_frontmatter(g)
                self.assertIn(
                    fm.get("type"),
                    (
                        "tool_used",
                        "llm",
                        "regex",
                        "tool_order",
                        "file_exists",
                        "baseline",
                    ),
                    f"bad type in {g}",
                )
                kinds.add(fm.get("type"))
            self.assertIn("tool_used", kinds, f"no Skill-fired grader in {case}")


if __name__ == "__main__":
    unittest.main()
