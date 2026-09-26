#!/usr/bin/env python3
"""
Unit and integration test suite for Epistemic Swarm.
Tests source hashing, state machine IPC transitions, auditor engine, and swarm mock dispatch.
"""

import sys
import json
import shutil
import tempfile
import unittest
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from skills.research_cache.hasher import SourceHasher
from runner.state_machine import ResearchStateMachine, SessionStatus, ScopeStatus
from runner.auditor_engine import EpistemicAuditorEngine
from runner.research_swarm import SwarmRunner


class TestEpistemicSwarm(unittest.TestCase):
    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(prefix="epistemic_test_"))
        self.hasher = SourceHasher(base_dir=self.test_dir)
        self.state_machine = ResearchStateMachine(base_dir=self.test_dir)
        self.auditor = EpistemicAuditorEngine(base_dir=self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_source_hasher_and_quote_verification(self):
        content = """# Deep Learning Scaling Laws
Empirical measurements show that compute-optimal models scale loss as L(N) = (N_c / N)^alpha_N.
In our experiments, the 70B parameter model was trained on 15.0 trillion tokens.
"""
        shash = self.hasher.store_source(
            url="https://arxiv.org/abs/2203.15556",
            content=content,
            title="Chinchilla Scaling Laws",
        )
        self.assertTrue(len(shash) == 64)

        # 1. Exact quote match
        verified, conf, msg = self.hasher.verify_quote(
            shash, "the 70B parameter model was trained on 15.0 trillion tokens."
        )
        self.assertTrue(verified)
        self.assertGreaterEqual(conf, 0.95)

        # 2. Normalized whitespace match
        verified_norm, conf_norm, _ = self.hasher.verify_quote(
            shash, "the   70B parameter model was\ntrained on 15.0 trillion tokens."
        )
        self.assertTrue(verified_norm)

        # 3. Fabricated quote rejection
        verified_fake, conf_fake, _ = self.hasher.verify_quote(
            shash,
            "the 70B parameter model was trained on 500 quadrillion tokens by aliens.",
        )
        self.assertFalse(verified_fake)
        self.assertLess(conf_fake, 0.8)

    def test_state_machine_transitions_and_dag(self):
        self.state_machine.init_session("Evaluate rollup throughput")
        scopes = [
            {
                "scope_id": "scope_01_prover",
                "title": "Prover Benchmarks",
                "dependencies": [],
            },
            {
                "scope_id": "scope_02_recursion",
                "title": "Recursive Verification",
                "dependencies": ["scope_01_prover"],
            },
        ]
        self.state_machine.set_scopes(scopes)

        # Initially, only scope_01 should be ready
        ready = self.state_machine.get_ready_scopes()
        self.assertEqual(len(ready), 1)
        self.assertEqual(ready[0]["scope_id"], "scope_01_prover")

        # Mark scope_01 complete
        self.state_machine.update_scope_status("scope_01_prover", ScopeStatus.COMPLETE)

        # Now scope_02 should be ready
        ready_after = self.state_machine.get_ready_scopes()
        self.assertEqual(len(ready_after), 1)
        self.assertEqual(ready_after[0]["scope_id"], "scope_02_recursion")

    def test_epistemic_auditor_scoring_and_downgrade(self):
        # 1. Seed cached source
        shash = self.hasher.store_source(
            url="https://benchmark.org/zk",
            content="FPGA prover executes Poseidon in 184ms.",
            title="ZK Benchmarks",
        )

        # 2. Initialize scope
        self.state_machine.init_session("Test Objective")
        self.state_machine.set_scopes([{"scope_id": "scope_test", "dependencies": []}])

        # 3. Create Alpha Dossier with 1 verified and 1 fake quote
        alpha_dossier = {
            "agent": "Agent Alpha",
            "scope_id": "scope_test",
            "affirmative_claims": [
                {
                    "claim_id": "A1",
                    "tag": "VERIFIED",
                    "statement": "Poseidon prover executes in 184ms",
                    "source_hash": shash,
                    "verbatim_quote": "FPGA prover executes Poseidon in 184ms.",
                },
                {
                    "claim_id": "A2",
                    "tag": "VERIFIED",
                    "statement": "Hallucinated claim that does not exist in source",
                    "source_hash": shash,
                    "verbatim_quote": "This string does not exist anywhere in the text.",
                },
            ],
            "negative_knowledge": [{"query": "q1", "finding": "None"}],
        }

        # 4. Create Beta Dossier
        beta_dossier = {
            "agent": "Agent Beta",
            "scope_id": "scope_test",
            "falsification_claims": [],
            "methodological_critiques": [
                {
                    "target_assertion": "Poseidon prover executes in 184ms",
                    "critique": "Benchmark excludes PCIe host bus latency",
                }
            ],
            "negative_knowledge": [],
        }

        self.state_machine.record_agent_completion("scope_test", "alpha", alpha_dossier)
        self.state_machine.record_agent_completion("scope_test", "beta", beta_dossier)

        # 5. Run Auditor
        report = self.auditor.audit_scope("scope_test")
        summary = report["summary"]

        self.assertEqual(summary["verified_passed"], 1)
        self.assertEqual(summary["unverified_rejected"], 1)
        self.assertEqual(summary["negative_knowledge_count"], 1)
        self.assertGreater(summary["divergence_score"], 0.0)

        # Check synthesis markdown generated
        synth_file = self.test_dir / "scratchpads" / "scope_test" / "scope_synthesis.md"
        self.assertTrue(synth_file.exists())
        with open(synth_file, "r") as f:
            synth_content = f.read()
            self.assertIn("PURGED", synth_content)
            self.assertIn("Poseidon prover executes in 184ms", synth_content)

    def test_mock_swarm_runner_end_to_end(self):
        runner = SwarmRunner(base_dir=self.test_dir, mock_mode=True)
        runner.run_swarm("Evaluate hardware prover latency")

        manifest = runner.state_machine.load_global_manifest()
        self.assertEqual(manifest["status"], SessionStatus.COMPLETED.value)

        final_report = self.test_dir / "final_synthesis.md"
        self.assertTrue(final_report.exists())
        with open(final_report, "r") as f:
            report_text = f.read()
            self.assertIn("Master Epistemic Research Report", report_text)
            self.assertIn("Swarm Epistemic Audit Totals", report_text)

    def test_pi_and_opencode_manifest_integrity(self):
        pkg_json_path = PROJECT_ROOT / "package.json"
        self.assertTrue(pkg_json_path.exists())
        with open(pkg_json_path, "r", encoding="utf-8") as f:
            pkg = json.load(f)

        # 1. Pi manifest validation
        self.assertIn("pi", pkg)
        self.assertIn("pi-package", pkg.get("keywords", []))
        for skill_path in pkg["pi"].get("skills", []):
            resolved = (PROJECT_ROOT / skill_path).resolve()
            self.assertTrue(resolved.exists(), f"Pi skill path not found: {skill_path}")

        for ext_path in pkg["pi"].get("extensions", []):
            resolved = (PROJECT_ROOT / ext_path).resolve()
            self.assertTrue(
                resolved.exists(), f"Pi extension path not found: {ext_path}"
            )

        # 2. OpenCode plugin validation
        self.assertIn("opencode", pkg.get("keywords", []))
        self.assertIn("./opencode", pkg.get("exports", {}))
        opencode_entry = PROJECT_ROOT / "plugins/opencode/index.js"
        self.assertTrue(opencode_entry.exists())

        # 3. IUMBTEMS binary alias
        self.assertIn("iumbtems", pkg.get("bin", {}))
        self.assertTrue((PROJECT_ROOT / pkg["bin"]["iumbtems"]).exists())

    def test_config_manager_load_and_save(self):
        from skills.swarm_config.configure import load_config, save_config

        cfg = load_config(str(self.test_dir))
        self.assertEqual(cfg["search_engine"], "duckduckgo")
        self.assertEqual(cfg["mode"], "research")

        cfg["search_engine"] = "brave"
        cfg["mode"] = "audit"
        cfg["max_iterations"] = 3
        save_config(cfg, str(self.test_dir))

        reloaded = load_config(str(self.test_dir))
        self.assertEqual(reloaded["search_engine"], "brave")
        self.assertEqual(reloaded["mode"], "audit")
        self.assertEqual(reloaded["max_iterations"], 3)

    def test_mock_code_audit_mode(self):
        runner = SwarmRunner(base_dir=self.test_dir, mock_mode=True, mode="audit")
        runner.run_swarm("Audit state machine concurrency")

        audit_report = self.test_dir / "code_audit_report.md"
        self.assertTrue(audit_report.exists())
        with open(audit_report, "r") as f:
            content = f.read()
            self.assertIn("Codebase Architectural & Security Audit", content)

    def test_mock_oss_scout_mode(self):
        runner = SwarmRunner(base_dir=self.test_dir, mock_mode=True, mode="scout")
        runner.run_swarm("Scout Raft consensus libraries")

        scout_report = self.test_dir / "oss_scout_report.md"
        self.assertTrue(scout_report.exists())
        with open(scout_report, "r") as f:
            content = f.read()
            self.assertIn("Open-Source Software Discovery", content)

    def test_mock_brainstorm_mode(self):
        runner = SwarmRunner(base_dir=self.test_dir, mock_mode=True, mode="brainstorm")
        runner.run_swarm("Where do we go from here?")

        brainstorm_report = self.test_dir / "brainstorm_report.md"
        self.assertTrue(brainstorm_report.exists())
        with open(brainstorm_report, "r") as f:
            content = f.read()
            self.assertIn("Lateral Brainstorm", content)

    def test_brainstorm_prompt_and_skill_exist(self):
        prompt = PROJECT_ROOT / "prompts" / "agent_brainstormer.md"
        skill = PROJECT_ROOT / "skills" / "brainstorming" / "SKILL.md"
        scaffold = (
            PROJECT_ROOT / "skills" / "brainstorming" / "scripts" / "brainstorm.py"
        )
        self.assertTrue(prompt.exists())
        self.assertTrue(skill.exists())
        self.assertTrue(scaffold.exists())
        text = skill.read_text(encoding="utf-8")
        self.assertIn("name: brainstorming", text)
        self.assertIn("HYPOTHESIS", text)

    def test_universal_adapter_bundles_exist(self):
        # AntiGravity
        self.assertTrue((PROJECT_ROOT / "plugins/antigravity/plugin.json").exists())
        self.assertTrue((PROJECT_ROOT / "plugins/antigravity/mcp_config.json").exists())
        self.assertTrue((PROJECT_ROOT / "plugins/antigravity/hooks.json").exists())
        self.assertTrue(
            (
                PROJECT_ROOT / "plugins/antigravity/skills/brainstorming/SKILL.md"
            ).exists()
        )
        self.assertTrue(
            (PROJECT_ROOT / "plugins/antigravity/agents/brainstormer.md").exists()
        )
        # Gemini
        self.assertTrue(
            (PROJECT_ROOT / "plugins/gemini/gemini-extension.json").exists()
        )
        self.assertTrue((PROJECT_ROOT / "plugins/gemini/GEMINI.md").exists())
        self.assertTrue(
            (PROJECT_ROOT / "plugins/gemini/commands/brainstorming.toml").exists()
        )
        self.assertTrue(
            (PROJECT_ROOT / "plugins/gemini/skills/brainstorming/SKILL.md").exists()
        )
        # Codex
        self.assertTrue((PROJECT_ROOT / "plugins/codex/openai.yaml").exists())
        self.assertTrue((PROJECT_ROOT / "plugins/codex/config.toml.snippet").exists())
        self.assertTrue(
            (PROJECT_ROOT / "plugins/codex/skills/brainstorming/SKILL.md").exists()
        )
        self.assertTrue(
            (PROJECT_ROOT / ".agents/skills/brainstorming/SKILL.md").exists()
        )
        # OMP (oh-my-pi)
        self.assertTrue((PROJECT_ROOT / ".omp/commands/brainstorming.md").exists())
        self.assertTrue((PROJECT_ROOT / ".omp/prompts/brainstorming.md").exists())
        self.assertTrue((PROJECT_ROOT / ".omp/SYSTEM.md").exists())
        self.assertTrue(
            (PROJECT_ROOT / ".omp/hooks/pre/epistemic-redirect.ts").exists()
        )
        # package.json omp block mirrors pi block
        with open(PROJECT_ROOT / "package.json", "r", encoding="utf-8") as f:
            pkg = json.load(f)
        self.assertIn("omp", pkg)
        self.assertIn("./extensions/pi/index.js", pkg["omp"].get("extensions", []))
        self.assertIn("./skills/brainstorming", pkg["omp"].get("skills", []))
        self.assertIn("./skills/brainstorming", pkg["pi"].get("skills", []))

    def test_opencode_and_pi_extension_interfaces(self):
        import subprocess

        # 1. Test OpenCode Plugin registration (A2b: thin forwarders + both
        #    name exports — canonical IUMBTEMS_TOOL_NAMES and the deprecated
        #    IUMBEMS_TOOL_NAMES alias). Object form: server() resolves to
        #    {config, tool} with the tool map keyed by name.
        node_code_oc = """
        import plugin, { IUMBTEMS_TOOL_NAMES, IUMBEMS_TOOL_NAMES } from "./plugins/opencode/index.js";
        const shell = await plugin.server();
        const tools = Object.values(shell.tool);
        const names = tools.map(t => t.name);
        const cfg = {};
        shell.config(cfg);
        console.log(JSON.stringify({
          names,
          canonical: IUMBTEMS_TOOL_NAMES,
          alias: IUMBEMS_TOOL_NAMES,
          commands: Object.keys(cfg.command || {})
        }));
        """
        res_oc = subprocess.run(
            ["node", "--input-type=module", "-e", node_code_oc],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        self.assertEqual(
            res_oc.returncode, 0, f"OpenCode plugin test failed: {res_oc.stderr}"
        )
        lines = [
            line.strip()
            for line in res_oc.stdout.strip().split("\n")
            if line.strip().startswith("{")
        ]
        data_oc = json.loads(lines[-1])
        tools = data_oc["names"]
        # Canonical + deprecated alias must both exist and agree.
        self.assertEqual(data_oc["canonical"], data_oc["alias"])
        self.assertEqual(sorted(data_oc["canonical"]), sorted(tools))
        expected_tools = [
            "iumbtems_config",
            "iumbtems_swarm_research",
            "iumbtems_code_audit",
            "iumbtems_oss_scout",
            "iumbtems_brainstorm",
            "iumbtems_verify_quote",
            "iumbtems_socratic_frontier",
            "iumbtems_reindex_claims",
            "iumbtems_report_retraction",
            "iumbtems_check_staleness",
            "iumbtems_set_domain_pack",
            "iumbtems_export_brief",
            "iumbtems_verify_brief",
        ]
        for t in expected_tools:
            self.assertIn(t, tools)
        # Slash-command catalog registered via the server config hook.
        for c in [
            "swarm",
            "grill",
            "swarm-config",
            "audit",
            "scout",
            "brainstorming",
            "brainstorm",
        ]:
            self.assertIn(c, data_oc["commands"])

        # 2. Test Pi Extension registration
        node_code_pi = """
        import initPi from "./extensions/pi/index.js";
        const commands = [];
        const tools = [];
        initPi({
          registerCommand: (name) => commands.push(name),
          registerTool: (def) => tools.push(def.name)
        });
        console.log(JSON.stringify({ commands, tools }));
        """
        res_pi = subprocess.run(
            ["node", "--input-type=module", "-e", node_code_pi],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        self.assertEqual(
            res_pi.returncode, 0, f"Pi extension test failed: {res_pi.stderr}"
        )
        lines = [
            line.strip()
            for line in res_pi.stdout.strip().split("\n")
            if line.strip().startswith("{")
        ]
        data = json.loads(lines[-1])
        for c in ["swarm", "grill", "swarm-config", "audit", "scout", "brainstorming"]:
            self.assertIn(c, data["commands"])
        for t in ["iumbtems_verify_quote", "iumbtems_config", "iumbtems_brainstorm"]:
            self.assertIn(t, data["tools"])


if __name__ == "__main__":
    unittest.main()
