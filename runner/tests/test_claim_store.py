#!/usr/bin/env python3
"""Tests for the derived claim index (runner/claim_store.py).

Invariant under test: the flat files are source of truth; claims.sqlite is
rebuildable and idempotent. Double-reindex must yield an identical content
fingerprint; cross-run dedup must collapse shared source hashes.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.claim_store import ClaimStore, reindex  # noqa: E402


def write_dossier(base: Path, scope: str, name: str, payload: dict) -> Path:
    d = base / "scratchpads" / scope
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return p


class TestClaimStore(unittest.TestCase):
    def test_reindex_twice_identical_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            write_dossier(
                base,
                "scope_01",
                "alpha_dossier.json",
                {
                    "affirmative_claims": [
                        {"claim_id": "A1", "statement": "s", "source_hash": "h1", "verbatim_quote": "q"}
                    ],
                    "negative_knowledge": [{"query": "q", "finding": "f"}],
                },
            )
            write_dossier(
                base,
                "scope_01",
                "beta_dossier.json",
                {
                    "falsification_claims": [
                        {"claim_id": "B1", "statement": "t", "source_hash": "h1", "verbatim_quote": "q2", "severity": "LOW"}
                    ],
                },
            )

            r1 = reindex(base)
            r2 = reindex(base)
            self.assertEqual(r1["fingerprint"], r2["fingerprint"], "reindex must be idempotent")
            # claims_from_dossier folds all four shapes, so negative_knowledge
            # rows also become ClaimWitness records: 1 affirmative + 1 neg_knowledge
            # + 1 falsification = 3.
            self.assertEqual(r1["claims_indexed"], 3)
            self.assertEqual(r2["claims_indexed"], 3)

    def test_reindex_captures_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "sources").mkdir(parents=True)
            (base / "sources" / "h1.json").write_text(
                json.dumps({"hash": "h1", "url": "https://x", "title": "T", "tier": "WEB_DOCUMENT"})
            )
            (base / "sources" / "h1.md").write_text("content")

            result = reindex(base)
            self.assertEqual(result["sources_indexed"], 1)

            store = ClaimStore(base)
            rows = store.conn.execute("SELECT * FROM sources").fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["url"], "https://x")
            store.close()

    def test_cross_run_dedup(self):
        """Two runs citing one source hash => one sources row, N claim rows."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            # Register the shared source once (as a cache metadata file).
            (base / "sources").mkdir(parents=True)
            (base / "sources" / "SHARED_HASH.json").write_text(
                json.dumps({"hash": "SHARED_HASH", "url": "https://shared", "title": "Shared"})
            )
            (base / "sources" / "SHARED_HASH.md").write_text("body")

            for scope in ("scope_01", "scope_02"):
                write_dossier(
                    base,
                    scope,
                    "alpha_dossier.json",
                    {
                        "affirmative_claims": [
                            {
                                "claim_id": f"{scope}-A1",
                                "statement": f"claim from {scope}",
                                "source_hash": "SHARED_HASH",
                                "verbatim_quote": "q",
                            }
                        ]
                    },
                )
            reindex(base)

            store = ClaimStore(base)
            claims = store.claims_citing("SHARED_HASH")
            self.assertEqual(len(claims), 2, "both claims present")
            # One source row (deduped by primary key)
            n_sources = store.conn.execute(
                "SELECT COUNT(*) AS n FROM sources WHERE source_hash = ?", ("SHARED_HASH",)
            ).fetchone()["n"]
            self.assertEqual(n_sources, 1)
            store.close()

    def test_search_statements(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            write_dossier(
                base,
                "scope_01",
                "alpha_dossier.json",
                {
                    "affirmative_claims": [
                        {"claim_id": "A1", "statement": "Poseidon hash prover latency", "source_hash": "h", "verbatim_quote": "q"}
                    ]
                },
            )
            reindex(base)
            store = ClaimStore(base)
            hits = store.search_statements("Poseidon")
            self.assertEqual(len(hits), 1)
            self.assertEqual(hits[0]["claim_id"], "A1")
            store.close()

    def test_status_event_append(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            store = ClaimStore(base)
            store.record_status_event("scope_01", "A1", "LIVE", "STALE", "retracted", "2026-09-26T00:00:00Z")
            store.record_status_event("scope_01", "A1", "STALE", "SUSPECT", "revised", "2026-09-26T01:00:00Z")
            rows = store.conn.execute("SELECT * FROM status_events ORDER BY event_id").fetchall()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["to_status"], "STALE")
            self.assertEqual(rows[1]["to_status"], "SUSPECT")
            store.close()

    def test_fts5_flag_is_boolean(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = ClaimStore(Path(tmp))
            self.assertIsInstance(store.fts5, bool)
            store.close()


if __name__ == "__main__":
    unittest.main()
