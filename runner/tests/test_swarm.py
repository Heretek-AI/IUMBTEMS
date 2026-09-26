#!/usr/bin/env python3
"""
Unit and integration test suite for Epistemic Swarm.
Tests source hashing, state machine IPC transitions, auditor engine, and swarm mock dispatch.
"""

import sys
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
            title="Chinchilla Scaling Laws"
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
            shash, "the 70B parameter model was trained on 500 quadrillion tokens by aliens."
        )
        self.assertFalse(verified_fake)
        self.assertLess(conf_fake, 0.8)

    def test_state_machine_transitions_and_dag(self):
        self.state_machine.init_session("Evaluate rollup throughput")
        scopes = [
            {
                "scope_id": "scope_01_prover",
                "title": "Prover Benchmarks",
                "dependencies": []
            },
            {
                "scope_id": "scope_02_recursion",
                "title": "Recursive Verification",
                "dependencies": ["scope_01_prover"]
            }
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
            title="ZK Benchmarks"
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
                    "verbatim_quote": "FPGA prover executes Poseidon in 184ms."
                },
                {
                    "claim_id": "A2",
                    "tag": "VERIFIED",
                    "statement": "Hallucinated claim that does not exist in source",
                    "source_hash": shash,
                    "verbatim_quote": "This string does not exist anywhere in the text."
                }
            ],
            "negative_knowledge": [{"query": "q1", "finding": "None"}]
        }

        # 4. Create Beta Dossier
        beta_dossier = {
            "agent": "Agent Beta",
            "scope_id": "scope_test",
            "falsification_claims": [],
            "methodological_critiques": [
                {
                    "target_assertion": "Poseidon prover executes in 184ms",
                    "critique": "Benchmark excludes PCIe host bus latency"
                }
            ],
            "negative_knowledge": []
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


if __name__ == "__main__":
    unittest.main()
