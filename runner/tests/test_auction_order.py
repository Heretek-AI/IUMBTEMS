#!/usr/bin/env python3
"""Tests for the Stream F Frontier Markets auctioneer (deterministic, mock).

The live probe (wall-clock parity + >=20% claims/token) is scripts/auction_experiment.py
— it needs real models and is NOT a CI step. These tests pin the allocation
semantics: bid ordering, explicit-bid override, DAG default untouched.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.auctioneer import (  # noqa: E402
    bid_scope,
    dependency_depth,
    estimate_tokens,
    order_scope_ids,
    pick_next,
    record_scope_telemetry,
    score_scopes,
    unresolved_frontier_questions,
)


def scope(sid, deps=None, bid=None):
    s = {"scope_id": sid, "dependencies": deps or []}
    if bid is not None:
        s["bid"] = bid
    return s


class TestBidHeuristic(unittest.TestCase):
    def test_dependency_depth(self):
        scopes = [
            scope("a"),
            scope("b", ["a"]),
            scope("c", ["b"]),
            scope("d"),
        ]
        self.assertEqual(dependency_depth(scopes[0], scopes), 0)
        self.assertEqual(dependency_depth(scopes[1], scopes), 1)
        self.assertEqual(dependency_depth(scopes[2], scopes), 2)
        self.assertEqual(dependency_depth(scopes[3], scopes), 0)

    def test_unresolved_frontier_questions(self):
        frontier = {
            "nodes": {
                "n1": {"question": "q1", "settled_answer": "yes"},
                "n2": {"question": "q2", "settled_answer": None},
                "n3": {"question": "q3"},
            }
        }
        self.assertEqual(unresolved_frontier_questions(frontier), 2)
        self.assertEqual(unresolved_frontier_questions({}), 0)

    def test_explicit_bid_wins(self):
        s = scope("a", bid=42.5)
        self.assertEqual(bid_scope(s), 42.5)

    def test_frontier_weighting_prefers_shallow(self):
        frontier = {"nodes": {"n1": {"question": "q", "settled_answer": None}}}
        shallow = scope("a")
        deep = scope("c", ["b"])
        b_shallow = bid_scope(shallow, all_scopes=[shallow, scope("b"), deep], frontier=frontier)
        b_deep = bid_scope(deep, all_scopes=[shallow, scope("b"), deep], frontier=frontier)
        self.assertGreater(b_shallow, b_deep)

    def test_deterministic(self):
        scopes = [scope("b", ["a"]), scope("a"), scope("c", ["a"], bid=0.1)]
        frontier = {"nodes": {"n1": {"settled_answer": None}}}
        first = [b for b, _s in score_scopes(scopes, frontier=frontier)]
        second = [b for b, _s in score_scopes(scopes, frontier=frontier)]
        self.assertEqual(first, second)


class TestAuctionOrdering(unittest.TestCase):
    def test_orders_by_descending_bid(self):
        scopes = [
            scope("low", bid=0.1),
            scope("high", bid=9.0),
            scope("mid", bid=5.0),
        ]
        self.assertEqual(order_scope_ids(scopes), ["high", "mid", "low"])

    def test_tie_breaks_on_scope_id(self):
        scopes = [scope("zzz", bid=1.0), scope("aaa", bid=1.0)]
        self.assertEqual(order_scope_ids(scopes), ["aaa", "zzz"])

    def test_pick_next_respects_budget(self):
        scopes = [scope("high", bid=9.0), scope("mid", bid=5.0), scope("low", bid=0.5)]
        self.assertEqual(pick_next(scopes)["scope_id"], "high")
        self.assertEqual(pick_next(scopes, budget=6.0)["scope_id"], "mid")
        self.assertIsNone(pick_next(scopes, budget=0.1))

    def test_ready_batch_reordering(self):
        """The exact shape run_swarm uses: a ready batch reordered by bid."""
        ready = [scope("scope_02", ["scope_01"], bid=0.5), scope("scope_03", bid=3.0), scope("scope_01", bid=1.0)]
        ordered = order_scope_ids(ready)
        self.assertEqual(ordered, ["scope_03", "scope_01", "scope_02"])


class TestTelemetry(unittest.TestCase):
    def test_record_scope_telemetry(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            smdir = base / "scratchpads" / "scope_01"
            smdir.mkdir(parents=True)
            (smdir / "manifest.json").write_text(json.dumps({"scope_id": "scope_01", "status": "COMPLETE"}))

            record_scope_telemetry(base, "scope_01", tokens_used=1234, verified_claims=7, bid=2.5)
            manifest = json.loads((smdir / "manifest.json").read_text())
            self.assertEqual(manifest["telemetry"]["tokens_used"], 1234)
            self.assertEqual(manifest["telemetry"]["verified_claims"], 7)
            self.assertEqual(manifest["telemetry"]["bid"], 2.5)

    def test_estimate_tokens_flagged_approximation(self):
        self.assertEqual(estimate_tokens("x" * 400), 100)
        self.assertGreaterEqual(estimate_tokens(""), 1)


class TestSwarmAuctionIntegration(unittest.TestCase):
    def test_dag_default_unchanged(self):
        from runner.research_swarm import SwarmRunner

        with tempfile.TemporaryDirectory() as tmp:
            runner = SwarmRunner(base_dir=Path(tmp), mock_mode=True)
            self.assertEqual(runner.allocation, "dag")

    def test_auction_config_selected(self):
        from runner.research_swarm import SwarmRunner

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "config.json").write_text(json.dumps({"allocation": "auction"}))
            runner = SwarmRunner(base_dir=base, mock_mode=True)
            self.assertEqual(runner.allocation, "auction")

    def test_cli_override_beats_config(self):
        from runner.research_swarm import SwarmRunner

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "config.json").write_text(json.dumps({"allocation": "dag"}))
            runner = SwarmRunner(base_dir=base, mock_mode=True, allocation="auction")
            self.assertEqual(runner.allocation, "auction")

    def test_mock_swarm_runs_under_auction(self):
        """End-to-end mock run with auction allocation completes and records telemetry."""
        from runner.research_swarm import SwarmRunner

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            runner = SwarmRunner(base_dir=base, mock_mode=True, allocation="auction")
            runner.run_swarm("Evaluate auction allocation ordering")

            manifest = runner.state_machine.load_global_manifest()
            self.assertEqual(manifest["status"], "COMPLETED")
            # Mock orchestrator emits one scope; its manifest must carry telemetry.
            sid = manifest["scopes"][0]["scope_id"]
            sm = json.loads((base / "scratchpads" / sid / "manifest.json").read_text())
            self.assertIn("telemetry", sm)
            self.assertIn("tokens_used", sm["telemetry"])
            self.assertIn("verified_claims", sm["telemetry"])


if __name__ == "__main__":
    unittest.main()
