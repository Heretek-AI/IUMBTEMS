#!/usr/bin/env python3
"""Regulated Domain Packs probe test (Stream G falsification criterion).

[HYPOTHESIS: a biopharma constitution flips accept/reject on >= 25% of a
20-claim borderline fixture set]

This test IS the probe: the 20-claim borderline fixture is judged under the
legacy default constitution and under the biopharma pack; >= 25% of per-claim
verdicts must flip. The zero-tolerance retraction policy must downgrade
claims with retracted sources regardless of score.
"""

import json
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.claim_witness import normalize_claim  # noqa: E402
from runner.refinement import (  # noqa: E402
    LEGACY_CONSTITUTION,
    claim_verdict,
    compute_epistemic_score_from_claims,
    load_domain_pack,
)

FIXTURE = PROJECT_ROOT / "runner" / "tests" / "fixtures" / "borderline_claims.json"
N_CLAIMS = 20
FLIP_BAR = 0.25


def load_fixture():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    claims = [normalize_claim(c) for c in data["claims"]]
    return claims, set(data["retracted_hashes"])


class TestDomainPacksProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.claims, cls.retracted = load_fixture()
        cls.biopharma = load_domain_pack("biopharma")

    def test_fixture_shape(self):
        self.assertEqual(len(self.claims), N_CLAIMS)

    def test_load_all_three_packs(self):
        for pack_id in ("biopharma", "quant", "legal"):
            c = load_domain_pack(pack_id)
            self.assertIsNotNone(c.tier_weights)
            self.assertIn("PREPRINT", c.tier_weights)
        with self.assertRaises(FileNotFoundError):
            load_domain_pack("no-such-pack")

    def test_probe_biopharma_flips_at_least_quarter(self):
        """THE probe: >= 25% of 20 borderline verdicts flip under biopharma."""
        default_results = [
            claim_verdict(c, constitution=LEGACY_CONSTITUTION, retracted_hashes=self.retracted)
            for c in self.claims
        ]
        bio_results = [
            claim_verdict(c, constitution=self.biopharma, retracted_hashes=self.retracted)
            for c in self.claims
        ]

        flips = [
            (d["claim_id"], d["verdict"], b["verdict"])
            for d, b in zip(default_results, bio_results)
            if d["verdict"] != b["verdict"]
        ]
        flip_rate = len(flips) / N_CLAIMS
        self.assertGreaterEqual(
            flip_rate,
            FLIP_BAR,
            f"flip rate {flip_rate:.0%} ({len(flips)}/{N_CLAIMS}) below {FLIP_BAR:.0%}: {flips}",
        )

        # Default constitution accepts the whole borderline set...
        self.assertTrue(all(r["verdict"] == "ACCEPTED" for r in default_results),
                        [r for r in default_results if r["verdict"] != "ACCEPTED"])
        # ...and every flip is default-ACCEPTED -> biopharma-REJECTED.
        self.assertTrue(all(d == "ACCEPTED" and b == "REJECTED" for _c, d, b in flips))

    def test_banned_domain_mechanism(self):
        banned = [c for c in self.claims if "mirror.example" in (c.source_url or "") or "predatory-journal" in (c.source_url or "")]
        self.assertEqual(len(banned), 6, "fixture expects 6 banned-domain claims")
        for c in banned:
            r = claim_verdict(c, constitution=self.biopharma)
            self.assertEqual(r["verdict"], "REJECTED", c.claim_id)
            self.assertTrue(any("BANNED_DOMAIN" in x for x in r["reasons"]), r["reasons"])

    def test_missing_tag_mechanism(self):
        untagged = [c for c in self.claims if not c.tag]
        self.assertEqual(len(untagged), 2)
        for c in untagged:
            r = claim_verdict(c, constitution=self.biopharma)
            self.assertEqual(r["verdict"], "REJECTED", c.claim_id)
            self.assertTrue(any("MISSING_TAG" in x for x in r["reasons"]), r["reasons"])

    def test_zero_tolerance_retraction_mechanism(self):
        """RETRACTED source downgrades regardless of quote match or score."""
        retracted_claims = [c for c in self.claims if c.source_hash in self.retracted]
        self.assertEqual(len(retracted_claims), 2)
        for c in retracted_claims:
            # Even without passing retracted_hashes: status-based downgrade.
            c.status = "STALE"
            r = claim_verdict(c, constitution=self.biopharma)
            self.assertEqual(r["verdict"], "REJECTED", c.claim_id)
            self.assertTrue(
                any("ZERO_TOLERANCE_RETRACTION" in x for x in r["reasons"]), r["reasons"]
            )
            # Standard policy does NOT apply this rule.
            r_std = claim_verdict(c, constitution=LEGACY_CONSTITUTION)
            self.assertEqual(r_std["verdict"], "ACCEPTED")

    def test_tier_weights_move_the_score(self):
        """Preprint downweighting lowers E(D); threshold also comes from the pack."""
        s_default, _ = compute_epistemic_score_from_claims(self.claims, constitution=LEGACY_CONSTITUTION)
        s_bio, br = compute_epistemic_score_from_claims(self.claims, constitution=self.biopharma)
        self.assertLess(s_bio, s_default, (s_default, s_bio))
        # 18 of 20 claims carry the VERIFIED tag (2 are deliberately untagged);
        # each scores 0.3 under the biopharma preprint weight.
        n_verified = sum(1 for c in self.claims if c.tag == "VERIFIED")
        self.assertEqual(n_verified, 18)
        self.assertAlmostEqual(br["verified_weight"], n_verified * 0.3, places=3)

    def test_legacy_default_preserves_existing_behavior(self):
        """No pack => flat weights, no domain/tag rules, standard retraction."""
        self.assertEqual(LEGACY_CONSTITUTION.weight_for("PREPRINT"), 1.0)
        self.assertEqual(LEGACY_CONSTITUTION.banned_domains, [])
        self.assertEqual(LEGACY_CONSTITUTION.mandatory_tags, [])
        self.assertEqual(LEGACY_CONSTITUTION.retraction_policy, "standard")
        self.assertEqual(LEGACY_CONSTITUTION.accept_threshold, 0.65)


class TestAuditConstitutionWiring(unittest.TestCase):
    def test_audit_scope_default_unchanged(self):
        """audit_scope() with no constitution must match legacy numbers exactly."""
        import tempfile
        from runner.auditor_engine import EpistemicAuditorEngine
        from runner.state_machine import ResearchStateMachine
        from skills.research_cache.hasher import SourceHasher

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            hasher = SourceHasher(base)
            sm = ResearchStateMachine(base_dir=base)
            shash = hasher.store_source(
                "https://x", "FPGA prover executes Poseidon in 184ms.", "T"
            )
            sm.init_session("t")
            sm.set_scopes([{"scope_id": "s1", "dependencies": []}])
            sm.record_agent_completion("s1", "alpha", {
                "affirmative_claims": [{
                    "claim_id": "A1", "tag": "VERIFIED", "statement": "s",
                    "source_hash": shash, "verbatim_quote": "executes Poseidon in 184ms",
                }],
                "inferred_implications": [],
                "negative_knowledge": [],
            })
            sm.record_agent_completion("s1", "beta", {
                "falsification_claims": [],
                "methodological_critiques": [],
                "negative_knowledge": [],
            })

            engine = EpistemicAuditorEngine(base_dir=base)
            report = engine.audit_scope("s1")
            self.assertEqual(report["summary"]["verified_passed"], 1)
            self.assertEqual(report["summary"]["verdict"], "CERTIFIED")

    def test_audit_scope_with_biopharma_uses_threshold(self):
        import tempfile
        from runner.auditor_engine import EpistemicAuditorEngine
        from runner.refinement import load_domain_pack
        from runner.state_machine import ResearchStateMachine
        from skills.research_cache.hasher import SourceHasher

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            hasher = SourceHasher(base)
            sm = ResearchStateMachine(base_dir=base)
            shash = hasher.store_source(
                "https://predatory-journal.example/x",
                "Weak preprint finding about surrogate endpoints.",
                "T", tier="PREPRINT",
            )
            sm.init_session("t")
            sm.set_scopes([{"scope_id": "s1", "dependencies": []}])
            sm.record_agent_completion("s1", "alpha", {
                "affirmative_claims": [{
                    "claim_id": "A1", "tag": "VERIFIED", "statement": "s",
                    "source_hash": shash,
                    "source_url": "https://predatory-journal.example/x",
                    "verbatim_quote": "surrogate endpoints",
                }],
                "inferred_implications": [],
                "negative_knowledge": [],
            })
            sm.record_agent_completion("s1", "beta", {
                "falsification_claims": [],
                "methodological_critiques": [],
                "negative_knowledge": [],
            })

            engine = EpistemicAuditorEngine(base_dir=base)
            report = engine.audit_scope("s1", constitution=load_domain_pack("biopharma"))
            # Banned domain claim => REJECTED under biopharma.
            self.assertEqual(report["summary"]["unverified_rejected"], 1)
            self.assertEqual(report["summary"]["verified_passed"], 0)


if __name__ == "__main__":
    unittest.main()
