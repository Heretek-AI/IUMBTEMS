#!/usr/bin/env python3
"""Grounding regressions (issue #3): the summary must match the audit, brainstorm
scores speculation rather than web quotes, retrieval is observable, and dossiers
are treated as untrusted input.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.claim_witness import (  # noqa: E402
    KIND_HYPOTHESIS,
    KIND_INFERENCE,
    TAG_HYPOTHESIS,
    TAG_INFERRED,
    ClaimWitness,
)
from runner.refinement import (  # noqa: E402
    BRAINSTORM_MODE_THRESHOLD,
    compute_brainstorm_score_from_claims,
    compute_epistemic_score_from_claims,
)
from runner.research_swarm import SwarmRunner  # noqa: E402
from runner.retrieval_log import log_event, summarize  # noqa: E402
from runner.state_machine import ResearchStateMachine  # noqa: E402


def _hypothesis(i: int, falsification: str = "measurable test") -> ClaimWitness:
    return ClaimWitness(
        claim_id=f"H{i}",
        kind=KIND_HYPOTHESIS,
        tag=TAG_HYPOTHESIS,
        statement=f"speculative vector {i}",
        falsification=falsification,
    )


class TestRetrievalTelemetry(unittest.TestCase):
    def test_events_summarize_with_run_offset(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            log_event(base, "query", query="a", results=5)
            log_event(base, "cache", url="u", hash="h")

            self.assertEqual(
                summarize(base), {"queries": 1, "results": 5, "cached": 1, "events": 2}
            )

            offset = (base / "retrieval.jsonl").stat().st_size
            log_event(base, "query", query="b", results=2)
            delta = summarize(base, since=offset)
            self.assertEqual(delta["queries"], 1)
            self.assertEqual(delta["results"], 2)
            self.assertEqual(delta["cached"], 0)

    def test_missing_log_is_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(
                summarize(Path(tmp) / "nope"),
                {"queries": 0, "results": 0, "cached": 0, "events": 0},
            )


class TestSummaryMatchesAudit(unittest.TestCase):
    def _runner_with_scope(self, verified: int, verdict: str):
        tmp = tempfile.mkdtemp()
        base = Path(tmp) / ".research"
        runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
        sm: ResearchStateMachine = runner.state_machine
        sm.init_session("objective")
        sm.set_scopes([{"scope_id": "s1", "title": "t", "objective": "o"}])
        scope_dir = sm.get_scope_dir("s1")
        (scope_dir / "audit_report.json").write_text(
            json.dumps(
                {
                    "summary": {
                        "verified_passed": verified,
                        "unverified_rejected": 2,
                        "divergence_score": 0.0,
                        "verdict": verdict,
                    }
                }
            ),
            encoding="utf-8",
        )
        (scope_dir / "scope_synthesis.md").write_text(
            "# scope synthesis", encoding="utf-8"
        )
        return runner, base

    def test_zero_verified_summary_warns_and_does_not_claim_certainty(self):
        runner, base = self._runner_with_scope(0, "WARNING_LOW_GROUNDING")
        report = runner._compile_master_synthesis("objective").read_text(
            encoding="utf-8"
        )
        self.assertIn("⚠️ **WARNING_LOW_GROUNDING**", report)
        self.assertNotIn("Every factual statement carries", report)
        self.assertIn("retrieval:", report)

    def test_grounded_summary_does_not_warn(self):
        runner, _ = self._runner_with_scope(7, "CERTIFIED")
        report = runner._compile_master_synthesis("objective").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("⚠️ **WARNING_LOW_GROUNDING**", report)
        self.assertIn("7 primary citation(s) verified", report)


class TestBrainstormScoring(unittest.TestCase):
    def test_well_formed_hypotheses_pass_brainstorm(self):
        claims = [_hypothesis(i) for i in range(4)]
        score, breakdown = compute_brainstorm_score_from_claims(claims)
        self.assertGreaterEqual(score, BRAINSTORM_MODE_THRESHOLD)
        self.assertEqual(breakdown["well_formed_count"], 4)

    def test_research_formula_would_fail_same_dossier(self):
        claims = [_hypothesis(i) for i in range(4)]
        research_score, _ = compute_epistemic_score_from_claims(claims)
        self.assertLess(research_score, BRAINSTORM_MODE_THRESHOLD)

    def test_hypotheses_without_falsification_score_lower(self):
        good = [_hypothesis(i) for i in range(4)]
        weak = [_hypothesis(i, falsification="") for i in range(4)]
        self.assertGreater(
            compute_brainstorm_score_from_claims(good)[0],
            compute_brainstorm_score_from_claims(weak)[0],
        )

    def test_inference_without_parents_is_not_credited(self):
        with_parents = ClaimWitness(
            claim_id="I1",
            kind=KIND_INFERENCE,
            tag=TAG_INFERRED,
            statement="because",
            parent_claims=["H1"],
        )
        without = ClaimWitness(
            claim_id="I2", kind=KIND_INFERENCE, tag=TAG_INFERRED, statement="because"
        )
        self.assertGreater(
            compute_brainstorm_score_from_claims([with_parents])[0],
            compute_brainstorm_score_from_claims([without])[0],
        )


class TestDossierIsUntrusted(unittest.TestCase):
    def test_scope_id_mismatch_is_rejected(self):
        tmp = tempfile.mkdtemp()
        base = Path(tmp) / ".research"
        runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
        scope_dir = runner.state_machine.get_scope_dir("s1")
        scope_dir.mkdir(parents=True, exist_ok=True)
        (scope_dir / "beta_dossier.json").write_text(
            json.dumps({"scope_id": "some_other_scope", "claims": []}), encoding="utf-8"
        )
        with self.assertRaises(FileNotFoundError):
            runner._load_agent_dossier(
                scope_dir / "beta_dossier.json", "s1", "beta", None
            )

    def test_matching_scope_id_is_accepted(self):
        tmp = tempfile.mkdtemp()
        base = Path(tmp) / ".research"
        runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
        scope_dir = runner.state_machine.get_scope_dir("s1")
        scope_dir.mkdir(parents=True, exist_ok=True)
        (scope_dir / "beta_dossier.json").write_text(
            json.dumps({"scope_id": "s1", "falsification_claims": []}), encoding="utf-8"
        )
        data = runner._load_agent_dossier(
            scope_dir / "beta_dossier.json", "s1", "beta", None
        )
        self.assertEqual(data["scope_id"], "s1")


if __name__ == "__main__":
    unittest.main()
