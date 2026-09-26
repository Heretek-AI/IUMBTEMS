#!/usr/bin/env python3
"""PCRB probe test (Stream D / Gate G3 falsification criterion).

[HYPOTHESIS: a standalone verifier over a 50-claim brief runs in <2s and
flags 100% of seeded quote tampering]

This test IS the probe: build a realistic 50-claim signed brief, time the
verifier, then seed >= 20 tampering mutations across four attack classes
(quote flips, source body edits, claim swaps, coordinated manifest rewrites)
and assert every single one is flagged.
"""

import copy
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.pcrb import export_brief, sha256_text, member_hash  # noqa: E402
from runner.pcrb_verify import verify_brief  # noqa: E402

TEST_KEY = "pcrb-probe-secret-key"
N_CLAIMS = 50
N_SOURCES = 5
VERIFY_BUDGET_S = 2.0
N_MUTATIONS = 20


def build_workspace(base: Path) -> dict:
    """A .research-shaped workspace: 5 sources x 10 claims, all quotes real."""
    sources = base / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    scratch = base / "scratchpads" / "scope_01"
    scratch.mkdir(parents=True, exist_ok=True)

    src_hashes = []
    for s in range(N_SOURCES):
        content = (
            f"BENCHMARK REPORT {s}: The prover executes witness generation in "
            f"{180 + s}ms under load, with peak bandwidth {40 + s} GB/s and "
            f"validated reproducibility across {3 + s} independent runs. "
            f"Section {s} documents the methodology and error bars in full."
        )
        h = sha256_text(content)
        (sources / f"{h}.md").write_text(content, encoding="utf-8")
        (sources / f"{h}.json").write_text(
            json.dumps({"hash": h, "url": f"https://bench.example/{s}", "title": f"Bench {s}", "tier": "WEB_DOCUMENT"})
        )
        src_hashes.append(h)

    alpha_claims, beta_claims = [], []
    for i in range(N_CLAIMS):
        s = i % N_SOURCES
        content = (sources / f"{src_hashes[s]}.md").read_text(encoding="utf-8")
        # Unique verbatim substring from that source.
        quote = f"validated reproducibility across {3 + s} independent runs"
        claim = {
            "claim_id": f"C-{i:03d}",
            "tag": "VERIFIED",
            "statement": f"Claim {i}: prover behavior measured in benchmark {s}",
            "source_hash": src_hashes[s],
            "source_url": f"https://bench.example/{s}",
            "verbatim_quote": quote,
        }
        if i % 2 == 0:
            alpha_claims.append(claim)
        else:
            claim["severity"] = "LOW"
            beta_claims.append(claim)

    (scratch / "alpha_dossier.json").write_text(
        json.dumps({"agent": "Agent Alpha", "scope_id": "scope_01", "affirmative_claims": alpha_claims, "inferred_implications": [], "negative_knowledge": []})
    )
    (scratch / "beta_dossier.json").write_text(
        json.dumps({"agent": "Agent Beta", "scope_id": "scope_01", "falsification_claims": beta_claims, "methodological_critiques": [], "negative_knowledge": []})
    )
    (base / "final_synthesis.md").write_text("# Master Synthesis\n\nAll claims verified against benchmark sources.\n")
    return {"src_hashes": src_hashes}


class TestPcrbProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="pcrb_probe_")
        cls.base = Path(cls._tmp.name)
        cls.fx = build_workspace(cls.base)
        cls.bundle_path = export_brief(cls.base, key=TEST_KEY, objective="PCRB probe")
        cls.bundle = json.loads(cls.bundle_path.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_bundle_shape(self):
        self.assertEqual(self.bundle["pcrb_version"], "1.0")
        self.assertEqual(len(self.bundle["claims"]), N_CLAIMS)
        self.assertEqual(len(self.bundle["sources"]), N_SOURCES)
        self.assertEqual(self.bundle["signature"]["alg"], "hmac-sha256")
        self.assertIn("manifest", self.bundle)

    def test_probe_clean_brief_verifies_under_two_seconds(self):
        """THE probe (half 1): 50-claim brief verifies in <2s."""
        key = TEST_KEY.encode("utf-8")
        started = time.perf_counter()
        report = verify_brief(self.bundle, key=key)
        elapsed = time.perf_counter() - started

        self.assertTrue(report["ok"], report["failures"])
        self.assertEqual(report["stats"]["quotes_verified"], N_CLAIMS)
        self.assertEqual(report["stats"]["quotes_failed"], 0)
        self.assertLess(elapsed, VERIFY_BUDGET_S, f"verify took {elapsed:.3f}s")
        self.assertLess(report["stats"]["elapsed_s"], VERIFY_BUDGET_S)

    def test_probe_twenty_tamper_mutations_all_flagged(self):
        """THE probe (half 2): 100% of >=20 seeded mutations are caught."""
        key = TEST_KEY.encode("utf-8")
        mutations = self._seed_mutations()
        self.assertGreaterEqual(len(mutations), N_MUTATIONS)

        caught = []
        missed = []
        for name, tampered in mutations:
            report = verify_brief(tampered, key=key)
            if report["ok"]:
                missed.append(name)
            else:
                caught.append((name, [f["check"] for f in report["failures"]]))

        self.assertEqual(
            missed, [],
            f"MISSED tampering ({len(missed)}/{len(mutations)}): {missed}",
        )
        self.assertEqual(len(caught), len(mutations), "every mutation must be flagged")

    def _seed_mutations(self):
        """Four attack classes; each mutation is a fresh deep copy."""
        out = []

        # Class 1: quote character flips inside claim records (5x)
        for i in range(5):
            b = copy.deepcopy(self.bundle)
            rec = b["claims"][i]
            q = rec["verbatim_quote"]
            rec["verbatim_quote"] = q.replace("reproducibility", "reproducib1lity", 1)
            out.append((f"quote_flip_{i}", b))

        # Class 2: source body edits (5x)
        for i in range(5):
            b = copy.deepcopy(self.bundle)
            src = self.fx["src_hashes"][i % N_SOURCES]
            b["sources"][src]["content"] = b["sources"][src]["content"] + "\nINJECTED FALSE PARAGRAPH."
            out.append((f"source_body_edit_{i}", b))

        # Class 3: claim swaps — replace a claim wholesale with a different one (5x)
        for i in range(5):
            b = copy.deepcopy(self.bundle)
            donor = copy.deepcopy(b["claims"][(i + 7) % N_CLAIMS])
            donor["claim_id"] = b["claims"][i]["claim_id"]  # same id, different content
            b["claims"][i] = donor
            out.append((f"claim_swap_{i}", b))

        # Class 4: coordinated rewrites — attacker fixes the manifest hash too
        # (only the HMAC signature can catch these) (3x claims + 2x sources)
        for i in range(3):
            b = copy.deepcopy(self.bundle)
            rec = b["claims"][i + 10]
            rec["statement"] = rec["statement"] + " (fabricated conclusion)"
            rec["verbatim_quote"] = rec["verbatim_quote"].replace("independent", "independant", 1)
            b["manifest"]["claims"][rec["claim_id"]] = member_hash(rec)  # attacker "fixes" the hash
            out.append((f"coordinated_claim_rewrite_{i}", b))

        for i in range(2):
            b = copy.deepcopy(self.bundle)
            src = self.fx["src_hashes"][i]
            b["sources"][src]["content"] = b["sources"][src]["content"].replace("GB/s", "TB/s", 1)
            b["manifest"]["sources"][src] = sha256_text(b["sources"][src]["content"])  # attacker "fixes" it
            out.append((f"coordinated_source_rewrite_{i}", b))

        return out

    def test_unsigned_mode_still_catches_member_mismatches(self):
        """alg=none: integrity catches manifest mismatches; no authenticity claim."""
        unsigned = export_brief(self.base, out_path=self.base / "unsigned.pcrb.json", objective="unsigned probe")
        bundle = json.loads(unsigned.read_text(encoding="utf-8"))
        self.assertEqual(bundle["signature"]["alg"], "none")

        report = verify_brief(bundle, key=None)
        self.assertTrue(report["ok"], report["failures"])
        self.assertEqual(report["checks"]["signature"], "unsigned")

        # Member tamper still caught without a key...
        tampered = copy.deepcopy(bundle)
        tampered["claims"][0]["verbatim_quote"] = "totally fabricated quote text"
        report2 = verify_brief(tampered, key=None)
        self.assertFalse(report2["ok"])

        # ...but a COORDINATED rewrite (content + manifest) is undetectable
        # without a key. This is the honest limitation of alg=none.
        coordinated = copy.deepcopy(bundle)
        coordinated["claims"][0]["verbatim_quote"] = "totally fabricated quote text"
        coordinated["manifest"]["claims"][coordinated["claims"][0]["claim_id"]] = member_hash(
            coordinated["claims"][0]
        )
        report3 = verify_brief(coordinated, key=None)
        self.assertTrue(
            report3["ok"],
            "alg=none cannot detect coordinated rewrites — documented limitation, not a bug",
        )

    def test_missing_key_is_reported_not_silently_passed(self):
        report = verify_brief(self.bundle, key=None)
        self.assertFalse(report["ok"])
        self.assertEqual(report["checks"]["signature"], "unverifiable")

    def test_wrong_key_fails(self):
        report = verify_brief(self.bundle, key=b"wrong-key")
        self.assertFalse(report["ok"])
        self.assertEqual(report["checks"]["signature"], "invalid")

    def test_cli_exit_codes(self):
        import subprocess

        proc = subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "runner" / "pcrb_verify.py"), str(self.bundle_path), "--json"],
            capture_output=True, text=True, timeout=30,
            env={**__import__("os").environ, "IUMBTEMS_PCRB_KEY": TEST_KEY},
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        data = json.loads(proc.stdout)
        self.assertTrue(data["ok"])


if __name__ == "__main__":
    unittest.main()
