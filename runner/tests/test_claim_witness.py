#!/usr/bin/env python3
"""Tests for the normalized ClaimWitness model (runner/claim_witness.py)."""

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.claim_witness import (  # noqa: E402
    KIND_CLAIM,
    KIND_HYPOTHESIS,
    KIND_INFERENCE,
    KIND_NEGATIVE_KNOWLEDGE,
    STATUS_LIVE,
    TAG_HYPOTHESIS,
    TAG_INFERRED,
    TAG_NEGATIVE_KNOWLEDGE,
    TAG_VERIFIED,
    claims_from_dossier,
    normalize_claim,
    witness_check,
)


class TestNormalizeClaim(unittest.TestCase):
    def test_normalize_claim_kind_claim(self):
        raw = {
            "claim_id": "C-01",
            "tag": "VERIFIED",
            "statement": "s",
            "source_hash": "abc",
            "source_url": "u",
            "verbatim_quote": "q",
            "severity": "LOW",
        }
        c = normalize_claim(raw, kind=KIND_CLAIM)
        self.assertEqual(c.claim_id, "C-01")
        self.assertEqual(c.kind, KIND_CLAIM)
        self.assertEqual(c.tag, TAG_VERIFIED)
        self.assertEqual(c.source_hash, "abc")
        self.assertEqual(c.severity, "LOW")
        self.assertEqual(c.status, STATUS_LIVE)

    def test_normalize_claim_kind_inference(self):
        raw = {
            "inference_id": "I-01",
            "tag": "INFERRED",
            "statement": "s",
            "parent_claims": ["C-01"],
            "deductive_logic": "because",
        }
        c = normalize_claim(raw, kind=KIND_INFERENCE)
        self.assertEqual(c.claim_id, "I-01")
        self.assertEqual(c.kind, KIND_INFERENCE)
        self.assertEqual(c.tag, TAG_INFERRED)
        self.assertEqual(c.parent_claims, ["C-01"])
        self.assertEqual(c.deductive_logic, "because")

    def test_normalize_claim_kind_hypothesis(self):
        raw = {
            "hypothesis_id": "H-01",
            "tag": "HYPOTHESIS",
            "statement": "s",
            "falsification": "measurable test",
        }
        c = normalize_claim(raw, kind=KIND_HYPOTHESIS)
        self.assertEqual(c.claim_id, "H-01")
        self.assertEqual(c.kind, KIND_HYPOTHESIS)
        self.assertEqual(c.tag, TAG_HYPOTHESIS)
        self.assertEqual(c.falsification, "measurable test")

    def test_normalize_claim_kind_negative_knowledge(self):
        raw = {"query": "q", "finding": "nothing found"}
        c = normalize_claim(raw, kind=KIND_NEGATIVE_KNOWLEDGE)
        self.assertEqual(c.kind, KIND_NEGATIVE_KNOWLEDGE)
        self.assertEqual(c.tag, TAG_NEGATIVE_KNOWLEDGE)
        self.assertEqual(c.query, "q")
        self.assertEqual(c.finding, "nothing found")

    def test_parent_claims_accepts_string(self):
        c = normalize_claim({"inference_id": "I", "parent_claims": "C-01"}, KIND_INFERENCE)
        self.assertEqual(c.parent_claims, ["C-01"])

    def test_missing_tag_defaults_by_kind(self):
        c = normalize_claim({"claim_id": "C"}, KIND_CLAIM)
        self.assertEqual(c.tag, TAG_VERIFIED)
        c = normalize_claim({"inference_id": "I"}, KIND_INFERENCE)
        self.assertEqual(c.tag, TAG_INFERRED)


class TestClaimsFromDossier(unittest.TestCase):
    def test_extracts_all_four_shapes(self):
        dossier = {
            "affirmative_claims": [{"claim_id": "A1", "statement": "s"}],
            "falsification_claims": [{"claim_id": "B1", "statement": "s", "severity": "HIGH"}],
            "inferred_implications": [{"inference_id": "I1", "parent_claims": ["A1"]}],
            "hypotheses": [{"hypothesis_id": "H1", "falsification": "t"}],
            "negative_knowledge": [{"query": "q", "finding": "f"}],
        }
        claims = claims_from_dossier(dossier)
        self.assertEqual(len(claims), 5)
        kinds = sorted(c.kind for c in claims)
        self.assertEqual(
            kinds,
            sorted(
                [
                    KIND_CLAIM,
                    KIND_CLAIM,
                    KIND_INFERENCE,
                    KIND_HYPOTHESIS,
                    KIND_NEGATIVE_KNOWLEDGE,
                ]
            ),
        )

    def test_handles_missing_keys(self):
        self.assertEqual(claims_from_dossier({}), [])

    def test_handles_non_list_rows(self):
        self.assertEqual(claims_from_dossier({"affirmative_claims": "not-a-list"}), [])


class TestWitnessCheck(unittest.TestCase):
    def test_missing_hash_or_quote_rejected(self):
        from runner.claim_witness import ClaimWitness

        class FakeHasher:
            def verify_quote(self, h, q):
                return True, 1.0, "ok"

        c = ClaimWitness(claim_id="C", kind=KIND_CLAIM, tag=TAG_VERIFIED, statement="s")
        passed, conf, msg = witness_check(c, FakeHasher())
        self.assertFalse(passed)
        self.assertEqual(conf, 0.0)
        self.assertIn("Missing", msg)

    def test_delegates_to_hasher(self):
        from runner.claim_witness import ClaimWitness

        calls = []

        class FakeHasher:
            def verify_quote(self, h, q):
                calls.append((h, q))
                return True, 0.99, "ok"

        c = ClaimWitness(
            claim_id="C",
            kind=KIND_CLAIM,
            tag=TAG_VERIFIED,
            statement="s",
            source_hash="h",
            verbatim_quote="q",
        )
        passed, conf, msg = witness_check(c, FakeHasher())
        self.assertTrue(passed)
        self.assertEqual(conf, 0.99)
        self.assertEqual(calls, [("h", "q")])

    def test_real_hasher_round_trip(self):
        import tempfile
        from skills.research_cache.hasher import SourceHasher

        with tempfile.TemporaryDirectory() as tmp:
            hasher = SourceHasher(Path(tmp))
            content = "Poseidon round constraints in 184ms with 45 GB/s."
            digest = hasher.store_source(url="https://x", content=content, title="T")
            c = normalize_claim(
                {
                    "claim_id": "C",
                    "tag": "VERIFIED",
                    "statement": "s",
                    "source_hash": digest,
                    "verbatim_quote": "Poseidon round constraints in 184ms",
                }
            )
            passed, conf, _msg = witness_check(c, hasher)
            self.assertTrue(passed)
            self.assertGreaterEqual(conf, 0.95)


if __name__ == "__main__":
    unittest.main()
