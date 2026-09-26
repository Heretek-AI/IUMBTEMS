#!/usr/bin/env python3
"""Tests for the refinement-type checker and pure E(D) scoring.

Property-style checks are seeded hand-rolled loops (200 random claim sets)
rather than a hypothesis dependency — zero-dep constraint holds.
"""

import random
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
    STATUS_REJECTED,
    TAG_HYPOTHESIS,
    TAG_INFERRED,
    TAG_NEGATIVE_KNOWLEDGE,
    TAG_VERIFIED,
    ClaimWitness,
)
from runner.refinement import (  # noqa: E402
    LEGACY_CONSTITUTION,
    Constitution,
    check_invariants,
    compute_epistemic_score,
    compute_epistemic_score_from_claims,
)


def make_claim(**kw) -> ClaimWitness:
    base = dict(
        claim_id="C",
        kind=KIND_CLAIM,
        tag=TAG_VERIFIED,
        statement="s",
        source_hash="h",
        verbatim_quote="q",
    )
    base.update(kw)
    return ClaimWitness(**base)


class TestCheckInvariants(unittest.TestCase):
    def test_verified_requires_hash_and_quote(self):
        bad = make_claim(claim_id="C1", source_hash=None, verbatim_quote=None)
        viols = check_invariants([bad])
        rules = {v.rule for v in viols}
        self.assertIn("VERIFIED_REQUIRES_HASH", rules)
        self.assertIn("VERIFIED_REQUIRES_QUOTE", rules)

    def test_inferred_requires_parents_and_logic(self):
        bad = make_claim(
            claim_id="I1",
            kind=KIND_INFERENCE,
            tag=TAG_INFERRED,
            source_hash=None,
            verbatim_quote=None,
            parent_claims=[],
            deductive_logic=None,
        )
        viols = check_invariants([bad])
        rules = {v.rule for v in viols}
        self.assertIn("INFERRED_REQUIRES_PARENTS", rules)
        self.assertIn("INFERRED_REQUIRES_LOGIC", rules)

    def test_hypothesis_requires_falsification(self):
        bad = make_claim(
            claim_id="H1",
            kind=KIND_HYPOTHESIS,
            tag=TAG_HYPOTHESIS,
            source_hash=None,
            verbatim_quote=None,
            falsification=None,
        )
        viols = check_invariants([bad])
        self.assertIn("HYPOTHESIS_REQUIRES_FALSIFICATION", {v.rule for v in viols})

    def test_neg_knowledge_requires_query_and_finding(self):
        bad = make_claim(
            claim_id="N1",
            kind=KIND_NEGATIVE_KNOWLEDGE,
            tag=TAG_NEGATIVE_KNOWLEDGE,
            source_hash=None,
            verbatim_quote=None,
            query=None,
            finding=None,
        )
        viols = check_invariants([bad])
        rules = {v.rule for v in viols}
        self.assertIn("NEG_KNOWLEDGE_REQUIRES_QUERY", rules)
        self.assertIn("NEG_KNOWLEDGE_REQUIRES_FINDING", rules)

    def test_parent_cross_ref_resolution(self):
        good_parent = make_claim(claim_id="C1")
        orphan = make_claim(
            claim_id="I1",
            kind=KIND_INFERENCE,
            tag=TAG_INFERRED,
            source_hash=None,
            verbatim_quote=None,
            parent_claims=["DOES_NOT_EXIST"],
            deductive_logic="because",
        )
        viols = check_invariants([good_parent, orphan])
        self.assertIn("PARENT_UNRESOLVED", {v.rule for v in viols})

    def test_clean_set_has_no_violations(self):
        c1 = make_claim(claim_id="C1")
        c2 = make_claim(
            claim_id="I1",
            kind=KIND_INFERENCE,
            tag=TAG_INFERRED,
            source_hash=None,
            verbatim_quote=None,
            parent_claims=["C1"],
            deductive_logic="therefore",
        )
        self.assertEqual(check_invariants([c1, c2]), [])

    def test_witness_check_with_hasher(self):
        import tempfile
        from skills.research_cache.hasher import SourceHasher

        with tempfile.TemporaryDirectory() as tmp:
            hasher = SourceHasher(Path(tmp))
            content = "Verbatim sentence here."
            digest = hasher.store_source(url="https://x", content=content)
            good = make_claim(
                claim_id="C1", source_hash=digest, verbatim_quote="Verbatim sentence"
            )
            bad = make_claim(
                claim_id="C2", source_hash=digest, verbatim_quote="never in source"
            )
            viols = check_invariants([good, bad], hasher=hasher)
            rules_by_id = {v.claim_id: v.rule for v in viols}
            self.assertNotIn("C1", rules_by_id)
            self.assertEqual(rules_by_id.get("C2"), "WITNESS_CHECK_FAILED")

    def test_banned_domain_rule(self):
        const = Constitution(banned_domains=["banned.example"])
        bad = make_claim(claim_id="C1", source_url="https://banned.example/paper")
        viols = check_invariants([bad], constitution=const)
        self.assertIn("BANNED_DOMAIN", {v.rule for v in viols})


class TestComputeEpistemicScore(unittest.TestCase):
    def test_legacy_formula_exact(self):
        # 1 verified, 1 inferred, 1 hypothesis, 1 rejected, 1 neg_knowledge
        # raw = (1.0*1 + 0.5*1 - 2.5*1) / (1+1+1+1) = (1+0.5-2.5)/4 = -1/4 = -0.25
        # clamped to 0.0
        score, br = compute_epistemic_score(
            {"verified": 1, "rejected": 1, "inferred": 1, "hypotheses": 1, "neg_knowledge": 1}
        )
        self.assertEqual(score, 0.0)
        self.assertEqual(br["verified_passed"], 1)
        self.assertEqual(br["unverified_rejected"], 1)
        self.assertEqual(br["negative_knowledge_count"], 1)

    def test_legacy_formula_all_verified(self):
        # 2 verified, 0 else: raw = 2/2 = 1.0
        score, _ = compute_epistemic_score(
            {"verified": 2, "rejected": 0, "inferred": 0, "hypotheses": 0, "neg_knowledge": 0}
        )
        self.assertEqual(score, 1.0)

    def test_score_bounded(self):
        for counts in (
            {"verified": 0, "rejected": 0, "inferred": 0, "hypotheses": 0, "neg_knowledge": 0},
            {"verified": 0, "rejected": 100, "inferred": 0, "hypotheses": 0, "neg_knowledge": 0},
            {"verified": 100, "rejected": 0, "inferred": 0, "hypotheses": 0, "neg_knowledge": 100},
        ):
            score, _ = compute_epistemic_score(counts)
            self.assertGreaterEqual(score, 0.0)
            self.assertLessEqual(score, 1.0)

    def test_deterministic(self):
        counts = {"verified": 3, "rejected": 1, "inferred": 2, "hypotheses": 1, "neg_knowledge": 2}
        s1, b1 = compute_epistemic_score(counts)
        s2, b2 = compute_epistemic_score(counts)
        self.assertEqual(s1, s2)
        self.assertEqual(b1, b2)

    def test_monotone_rejection_penalty(self):
        base = {"verified": 5, "rejected": 0, "inferred": 0, "hypotheses": 0, "neg_knowledge": 0}
        more_rejects = dict(base, rejected=3)
        s0, _ = compute_epistemic_score(base)
        s1, _ = compute_epistemic_score(more_rejects)
        self.assertLessEqual(s1, s0)

    def test_zero_assertions_clamps(self):
        score, br = compute_epistemic_score(
            {"verified": 0, "rejected": 0, "inferred": 0, "hypotheses": 0, "neg_knowledge": 0}
        )
        self.assertEqual(score, 0.0)
        self.assertEqual(br["total_assertions"], 1)

    def test_property_loops_200_random_claim_sets(self):
        rng = random.Random(0xF00D)
        for _ in range(200):
            counts = {
                "verified": rng.randint(0, 20),
                "rejected": rng.randint(0, 10),
                "inferred": rng.randint(0, 10),
                "hypotheses": rng.randint(0, 10),
                "neg_knowledge": rng.randint(0, 5),
            }
            score, _br = compute_epistemic_score(counts)
            self.assertGreaterEqual(score, 0.0, counts)
            self.assertLessEqual(score, 1.0, counts)
            # Determinism
            score2, _ = compute_epistemic_score(counts)
            self.assertEqual(score, score2)
            # More rejections never improve the score
            worse = dict(counts, rejected=counts["rejected"] + 1)
            worse_score, _ = compute_epistemic_score(worse)
            self.assertLessEqual(worse_score, score, (counts, worse))


class TestConstitution(unittest.TestCase):
    def test_legacy_default_is_flat(self):
        self.assertEqual(LEGACY_CONSTITUTION.weight_for(None), 1.0)
        self.assertEqual(LEGACY_CONSTITUTION.weight_for("PREPRINT"), 1.0)

    def test_tier_weights_override(self):
        const = Constitution(tier_weights={"PREPRINT": 0.3, "__default__": 1.0})
        self.assertEqual(const.weight_for("PREPRINT"), 0.3)
        self.assertEqual(const.weight_for("PEER_REVIEWED"), 1.0)

    def test_tier_weighted_claims_path(self):
        # Legacy: 2 verified = 1.0
        legacy_claims = [make_claim(claim_id=f"C{i}") for i in range(2)]
        s_legacy, _ = compute_epistemic_score_from_claims(legacy_claims)
        self.assertEqual(s_legacy, 1.0)

        # Biopharma-ish: preprints downgraded to 0.3
        const = Constitution(tier_weights={"PREPRINT": 0.3, "__default__": 1.0})
        preprints = [
            make_claim(claim_id=f"C{i}", tier="PREPRINT") for i in range(2)
        ]
        s_tiered, br = compute_epistemic_score_from_claims(preprints, constitution=const)
        # weight = 0.3*2 = 0.6, assertions = 2, raw = 0.6/2 = 0.3
        self.assertEqual(s_tiered, 0.3)
        self.assertAlmostEqual(br["verified_weight"], 0.6, places=3)


if __name__ == "__main__":
    unittest.main()
