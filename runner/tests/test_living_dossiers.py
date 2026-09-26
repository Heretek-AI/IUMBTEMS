#!/usr/bin/env python3
"""Living Dossiers probe test (Stream C falsification criterion).

[HYPOTHESIS: injecting a simulated retraction into 5 completed dossiers
marks >= 4 dependent claim sets STALE within one auditor pass]

This test IS the probe: 5 scope dossiers cite shared source hashes; a
simulated retraction event is injected; exactly one degradation pass runs;
>= 4 claim sets must end STALE (or SUSPECT for REVISED events).
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
    STATUS_LIVE,
    STATUS_STALE,
    STATUS_SUSPECT,
)
from runner.living_dossiers import (  # noqa: E402
    EVENT_RETRACTED,
    EVENT_REVISED,
    RetractionEvent,
    apply_degradation,
    check_staleness,
    load_requeue,
    load_retractions,
    write_retraction,
)


def build_fixture(base: Path, n_scopes: int = 5) -> dict:
    """5 completed scopes; scopes 0-3 cite SHARED_A, scope 4 cites SHARED_B."""
    hashes = {}
    sources = base / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    for name, content in (
        ("SHARED_A", "Poseidon prover executes the round constraints in 184ms."),
        ("SHARED_B", "Independent replication confirmed 150k ops/sec throughput."),
    ):
        (sources / f"{name}.json").write_text(
            json.dumps({"hash": name, "url": f"https://x/{name}", "title": name})
        )
        (sources / f"{name}.md").write_text(content)
        hashes[name] = content

    scratch = base / "scratchpads"
    for i in range(n_scopes):
        scope = scratch / f"scope_{i:02d}"
        scope.mkdir(parents=True, exist_ok=True)
        src = "SHARED_A" if i < 4 else "SHARED_B"
        quote = "184ms" if src == "SHARED_A" else "150k ops/sec"
        (scope / "alpha_dossier.json").write_text(
            json.dumps(
                {
                    "agent": "Agent Alpha",
                    "scope_id": scope.name,
                    "affirmative_claims": [
                        {
                            "claim_id": f"A-{i:02d}",
                            "tag": "VERIFIED",
                            "statement": f"scope {i} affirmative",
                            "source_hash": src,
                            "verbatim_quote": quote,
                        }
                    ],
                    "inferred_implications": [],
                    "negative_knowledge": [],
                }
            )
        )
        (scope / "beta_dossier.json").write_text(
            json.dumps(
                {
                    "agent": "Agent Beta",
                    "scope_id": scope.name,
                    "falsification_claims": [
                        {
                            "claim_id": f"B-{i:02d}",
                            "tag": "VERIFIED",
                            "statement": f"scope {i} falsification",
                            "source_hash": src,
                            "verbatim_quote": quote,
                            "severity": "LOW",
                        }
                    ],
                    "methodological_critiques": [],
                    "negative_knowledge": [],
                }
            )
        )
    return hashes


class TestLivingDossiersProbe(unittest.TestCase):
    def test_probe_retraction_marks_four_claim_sets_stale(self):
        """THE probe: 5 dossiers, simulated retraction, >=4 claim sets STALE."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            build_fixture(base, n_scopes=5)

            # Simulate retraction of SHARED_A (cited by scopes 0-3 = 4 sets).
            write_retraction(
                base,
                "SHARED_A",
                EVENT_RETRACTED,
                note="simulated retraction: paper withdrawn by authors",
            )

            # Exactly one auditor/degradation pass.
            summary = check_staleness(base)

            degraded = set(summary["degraded_scopes"])
            # >= 4 claim sets (scopes) must degrade to STALE.
            self.assertGreaterEqual(
                len(degraded), 4, f"expected >=4 degraded scopes, got {degraded}"
            )
            self.assertEqual(degraded, {"scope_00", "scope_01", "scope_02", "scope_03"})

            # Scope 04 (SHARED_B) must remain LIVE.
            self.assertNotIn("scope_04", degraded)

            # Ledger is append-only and records the transitions.
            ledger_path = base / "ledger" / "claim_status.json"
            self.assertTrue(ledger_path.exists())
            ledger = json.loads(ledger_path.read_text())
            self.assertGreaterEqual(len(ledger), 8)  # 4 scopes x (alpha+beta claims)
            self.assertTrue(all(e["to_status"] == STATUS_STALE for e in ledger))

            # Requeue sidecar lists exactly the degraded scopes.
            requeue = load_requeue(base)
            self.assertEqual(
                sorted(e["scope_id"] for e in requeue),
                ["scope_00", "scope_01", "scope_02", "scope_03"],
            )

            # Dossiers themselves are NEVER mutated (historical record).
            d = json.loads((base / "scratchpads" / "scope_00" / "alpha_dossier.json").read_text())
            self.assertNotIn("status", d["affirmative_claims"][0])
            self.assertEqual(d["affirmative_claims"][0]["claim_id"], "A-00")

    def test_revised_marks_suspect_not_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            build_fixture(base, n_scopes=2)
            write_retraction(base, "SHARED_A", EVENT_REVISED, note="benchmark table updated")
            summary = check_staleness(base)
            self.assertIn("scope_00", summary["degraded_scopes"])

            # apply_degradation unit-level: SUSPECT for REVISED
            from runner.claim_witness import normalize_claim

            claim = normalize_claim(
                {"claim_id": "C1", "tag": "VERIFIED", "source_hash": "SHARED_A", "verbatim_quote": "184ms"}
            )
            retr = load_retractions(base)
            degraded, events = apply_degradation([claim], retr, scope_id="s")
            self.assertEqual(degraded[0].status, STATUS_SUSPECT)
            self.assertEqual(events[0].to_status, STATUS_SUSPECT)

    def test_no_retractions_no_degradation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            build_fixture(base, n_scopes=5)
            summary = check_staleness(base)
            self.assertEqual(summary["retractions"], 0)
            self.assertEqual(summary["degraded_scopes"], [])
            self.assertEqual(summary["status_events"], 0)

    def test_retraction_event_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            with self.assertRaises(ValueError):
                write_retraction(base, "H", "EXPLODED", note="bad event")

    def test_apply_degradation_idempotent(self):
        """Second pass over already-STALE claims produces no new events."""
        from runner.claim_witness import normalize_claim

        retr = {
            "SHARED_A": RetractionEvent(
                hash="SHARED_A", event=EVENT_RETRACTED, at="t", note="n"
            )
        }
        claim = normalize_claim(
            {"claim_id": "C1", "tag": "VERIFIED", "source_hash": "SHARED_A", "verbatim_quote": "q"}
        )
        d1, ev1 = apply_degradation([claim], retr, scope_id="s")
        self.assertEqual(len(ev1), 1)
        self.assertEqual(d1[0].status, STATUS_STALE)
        d2, ev2 = apply_degradation(d1, retr, scope_id="s")
        self.assertEqual(len(ev2), 0, "already-degraded claims produce no new events")
        self.assertEqual(d2[0].status, STATUS_STALE)


if __name__ == "__main__":
    unittest.main()
