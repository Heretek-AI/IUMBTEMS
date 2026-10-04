#!/usr/bin/env python3
"""
Unit tests for Antigravity plugin surface: manifest, commands, agents, hooks, MCP, rules.

Validates that plugins/antigravity maintains complete feature parity with Claude Code
and OpenCode, and complies with Antigravity specifications.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

PLUGIN_ROOT = PROJECT_ROOT / "plugins" / "antigravity"

EXPECTED_COMMANDS = [
    "audit",
    "brainstorm",
    "brainstorming",
    "darkharvest",
    "domainexpansion",
    "factory",
    "grill",
    "scout",
    "swarm-config",
    "swarm",
]

EXPECTED_AGENTS = [
    "alpha-thesis",
    "beta-antithesis",
    "brainstormer",
    "code-auditor",
    "darkharvester",
    "epistemic-auditor",
    "manager",
    "oss-scout",
    "programmer",
    "qa-a",
    "qa-b",
]

EXPECTED_SKILLS = [
    "grilling",
    "research_cache",
    "epistemic_search",
    "swarm_config",
    "code_audit",
    "oss_scout",
    "brainstorming",
    "darkharvest",
    "factory",
]


class TestAntigravityPluginManifest(unittest.TestCase):
    def setUp(self):
        self.pkg = json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))
        self.manifest = json.loads((PLUGIN_ROOT / "plugin.json").read_text(encoding="utf-8"))

    def test_manifest_metadata_and_version_lockstep(self):
        self.assertEqual(self.manifest.get("name"), "epistemic-swarm")
        self.assertEqual(
            self.manifest.get("version"),
            self.pkg.get("version"),
            "plugin.json version must match package.json exactly",
        )
        self.assertEqual(
            self.manifest.get("$schema"),
            "https://antigravity.google/schemas/v1/plugin.json",
        )
        self.assertTrue(self.manifest.get("description"))


class TestAntigravityCommands(unittest.TestCase):
    def test_all_ten_commands_exist_with_frontmatter(self):
        commands_dir = PLUGIN_ROOT / "commands"
        self.assertTrue(commands_dir.is_dir())
        for cmd in EXPECTED_COMMANDS:
            cmd_file = commands_dir / f"{cmd}.md"
            self.assertTrue(cmd_file.exists(), f"missing command: {cmd}.md")
            content = cmd_file.read_text(encoding="utf-8")
            self.assertTrue(content.startswith("---"), f"{cmd}.md missing frontmatter header")
            self.assertIn("description:", content, f"{cmd}.md missing description frontmatter")


class TestAntigravityAgents(unittest.TestCase):
    def test_all_eleven_agents_exist_with_valid_frontmatter(self):
        agents_dir = PLUGIN_ROOT / "agents"
        self.assertTrue(agents_dir.is_dir())
        for agent in EXPECTED_AGENTS:
            agent_file = agents_dir / f"{agent}.md"
            self.assertTrue(agent_file.exists(), f"missing agent: {agent}.md")
            content = agent_file.read_text(encoding="utf-8")
            self.assertTrue(content.startswith("---"), f"{agent}.md missing frontmatter header")
            self.assertIn(f"name: {agent}", content)
            self.assertIn("tools:", content)
            self.assertIn("subagent: true", content)
            self.assertIn("commandExecutionPolicy: sandbox", content)


class TestAntigravityRules(unittest.TestCase):
    def test_rules_exist_and_respect_size_budget(self):
        rules_dir = PLUGIN_ROOT / "rules"
        self.assertTrue(rules_dir.is_dir())
        for rule in ("AGENTS.md", "epistemic-integrity.md"):
            rule_file = rules_dir / rule
            self.assertTrue(rule_file.exists(), f"missing rule: {rule}")
            # Antigravity per-file budget limit is 24,000 bytes
            self.assertLessEqual(
                rule_file.stat().st_size,
                24000,
                f"{rule} exceeds 24,000 byte budget",
            )


class TestAntigravityMCPConfig(unittest.TestCase):
    def test_mcp_servers_defined(self):
        mcp_cfg = json.loads((PLUGIN_ROOT / "mcp_config.json").read_text(encoding="utf-8"))
        servers = mcp_cfg.get("mcpServers", {})
        self.assertIn("iumbtems", servers)
        self.assertIn("brave-search", servers)
        self.assertIn("firecrawl", servers)
        self.assertIn("searxng", servers)
        self.assertEqual(servers["iumbtems"]["command"], "python3")


class TestAntigravityHooks(unittest.TestCase):
    def test_hooks_json_structure(self):
        hooks_cfg = json.loads((PLUGIN_ROOT / "hooks.json").read_text(encoding="utf-8"))
        self.assertIn("epistemic-query-interceptor", hooks_cfg)
        self.assertIn("epistemic-claim-auditor", hooks_cfg)

        interceptor = hooks_cfg["epistemic-query-interceptor"]
        self.assertIn("PreToolUse", interceptor)
        self.assertEqual(interceptor["PreToolUse"][0]["matcher"], "*")
        self.assertIn("PreInvocation", interceptor)

        auditor = hooks_cfg["epistemic-claim-auditor"]
        self.assertIn("PostToolUse", auditor)
        self.assertIn("Stop", auditor)

    def test_hooks_runner_search_denial(self):
        bridge_script = PROJECT_ROOT / "runner" / "antigravity_hooks.py"
        self.assertTrue(bridge_script.exists())

        # PreTool search_web denial test
        proc = subprocess.run(
            [sys.executable, str(bridge_script), "pre_tool"],
            input=json.dumps({"toolCall": {"name": "search_web", "args": {"query": "test"}}}),
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0)
        res = json.loads(proc.stdout)
        self.assertEqual(res.get("decision"), "deny")

        # PreTool read_url_content denial test
        proc = subprocess.run(
            [sys.executable, str(bridge_script), "pre_tool"],
            input=json.dumps({"toolCall": {"name": "read_url_content", "args": {"Url": "https://example.com"}}}),
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0)
        res = json.loads(proc.stdout)
        self.assertEqual(res.get("decision"), "deny")

    def test_pre_tool_allow_read_tools(self):
        bridge_script = PROJECT_ROOT / "runner" / "antigravity_hooks.py"
        proc = subprocess.run(
            [sys.executable, str(bridge_script), "pre_tool"],
            input=json.dumps({"toolCall": {"name": "view_file", "args": {"AbsolutePath": "/dummy/file"}}}),
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0)
        res = json.loads(proc.stdout)
        self.assertEqual(res.get("decision"), "allow")

    def test_pre_tool_pre_commit_config_validation(self):
        bridge_script = PROJECT_ROOT / "runner" / "antigravity_hooks.py"
        with tempfile.TemporaryDirectory() as tmpdir:
            tmppath = Path(tmpdir)
            research_dir = tmppath / ".research"
            research_dir.mkdir(parents=True, exist_ok=True)
            cfg_file = research_dir / "config.json"

            # 1. Invalid config payload (illegal mode)
            proc = subprocess.run(
                [sys.executable, str(bridge_script), "pre_tool"],
                input=json.dumps({
                    "workspacePaths": [str(tmppath)],
                    "toolCall": {
                        "name": "write_to_file",
                        "args": {
                            "TargetFile": str(cfg_file),
                            "CodeContent": json.dumps({"mode": "totally_invalid_mode"}),
                        },
                    },
                }),
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0)
            res = json.loads(proc.stdout)
            self.assertEqual(res.get("decision"), "deny")
            self.assertIn("Pre-commit validation rejected", res.get("reason", ""))

    def test_pre_invocation_injects_epistemic_and_compaction_context(self):
        bridge_script = PROJECT_ROOT / "runner" / "antigravity_hooks.py"
        with tempfile.TemporaryDirectory() as tmpdir:
            tmppath = Path(tmpdir)
            research_dir = tmppath / ".research"
            research_dir.mkdir(parents=True, exist_ok=True)
            (research_dir / "config.json").write_text(
                json.dumps({"mode": "research", "search_engine": "duckduckgo", "max_iterations": 3}),
                encoding="utf-8",
            )

            proc = subprocess.run(
                [sys.executable, str(bridge_script), "pre_invocation"],
                input=json.dumps({"workspacePaths": [str(tmppath)], "conversationId": "test-compaction"}),
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0)
            res = json.loads(proc.stdout)
            self.assertIn("injectSteps", res)
            steps = res["injectSteps"]
            self.assertGreaterEqual(len(steps), 2)
            texts = [s.get("ephemeralMessage", "") for s in steps]
            # Must contain epistemic integrity prompt
            self.assertTrue(any("EPISTEMIC INTEGRITY" in t for t in texts))
            # Must contain compaction context with active configuration
            self.assertTrue(any("mode=research" in t and "engine=duckduckgo" in t for t in texts))

    def test_stop_allows_clean_workspace(self):
        bridge_script = PROJECT_ROOT / "runner" / "antigravity_hooks.py"
        with tempfile.TemporaryDirectory() as tmpdir:
            proc = subprocess.run(
                [sys.executable, str(bridge_script), "stop"],
                input=json.dumps({"workspacePaths": [tmpdir], "terminationReason": "model_stop"}),
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0)
            res = json.loads(proc.stdout)
            self.assertEqual(res.get("decision"), "allow")

    def test_stop_gates_when_degraded_claims_present(self):
        bridge_script = PROJECT_ROOT / "runner" / "antigravity_hooks.py"
        with tempfile.TemporaryDirectory() as tmpdir:
            tmppath = Path(tmpdir)
            ledger_dir = tmppath / ".research" / "ledger"
            ledger_dir.mkdir(parents=True, exist_ok=True)
            ledger_file = ledger_dir / "claim_status.json"
            # Write a ledger with a degraded STALE claim
            ledger_file.write_text(
                json.dumps([{"claim_id": "c1", "to_status": "STALE", "at": "2026-10-03T00:00:00Z"}]),
                encoding="utf-8",
            )

            proc = subprocess.run(
                [sys.executable, str(bridge_script), "stop"],
                input=json.dumps({"workspacePaths": [str(tmppath)], "terminationReason": "model_stop"}),
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0)
            res = json.loads(proc.stdout)
            self.assertEqual(res.get("decision"), "continue")
            self.assertIn("Epistemic audit warning", res.get("reason", ""))

            # Now create .factory/STOP and verify immediate allow override
            factory_dir = tmppath / ".factory"
            factory_dir.mkdir(parents=True, exist_ok=True)
            (factory_dir / "STOP").write_text("STOP", encoding="utf-8")

            proc = subprocess.run(
                [sys.executable, str(bridge_script), "stop"],
                input=json.dumps({"workspacePaths": [str(tmppath)], "terminationReason": "model_stop"}),
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0)
            res = json.loads(proc.stdout)
            self.assertEqual(res.get("decision"), "allow")


class TestAntigravityHookBusBridgeDirect(unittest.TestCase):
    def test_bridge_direct_execution(self):
        bridge_js = PLUGIN_ROOT / "hook_bus_bridge.js"
        self.assertTrue(bridge_js.exists())

        # Test pre_tool allow
        proc = subprocess.run(
            ["node", str(bridge_js), "pre_tool", json.dumps({"toolCall": {"name": "view_file"}})],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        self.assertEqual(proc.returncode, 0)
        lines = [l.strip() for l in proc.stdout.strip().splitlines() if l.strip().startswith("{")]
        res = json.loads(lines[-1])
        self.assertEqual(res.get("decision"), "allow")

        # Test pre_invocation compaction context
        proc = subprocess.run(
            ["node", str(bridge_js), "pre_invocation", "{}"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        self.assertEqual(proc.returncode, 0)
        lines = [l.strip() for l in proc.stdout.strip().splitlines() if l.strip().startswith("{")]
        res = json.loads(lines[-1])
        self.assertIn("compactionContext", res)

        # Test stop
        proc = subprocess.run(
            ["node", str(bridge_js), "stop", "{}"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        self.assertEqual(proc.returncode, 0)
        lines = [l.strip() for l in proc.stdout.strip().splitlines() if l.strip().startswith("{")]
        res = json.loads(lines[-1])
        self.assertEqual(res.get("decision"), "allow")


class TestAntigravityCLIValidation(unittest.TestCase):
    def test_native_agy_plugin_validate_if_present(self):
        agy_bin = shutil.which("agy")
        if not agy_bin:
            self.skipTest("agy CLI binary not installed on host PATH")

        proc = subprocess.run(
            [agy_bin, "plugin", "validate", str(PLUGIN_ROOT)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, f"agy plugin validate failed: {proc.stderr}\n{proc.stdout}")
        self.assertIn("[ok]", proc.stdout)
        self.assertIn("skills", proc.stdout)
        self.assertIn("agents", proc.stdout)
        self.assertIn("commands", proc.stdout)
        self.assertIn("mcpServers", proc.stdout)
        self.assertIn("hooks", proc.stdout)


if __name__ == "__main__":
    unittest.main()
