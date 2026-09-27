#!/usr/bin/env python3
"""CI-safe tests for the Bet-1 advisory spike harness (no LLM, no network)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.bet1_advisory_spike import (  # noqa: E402
    advisory_comment,
    generate,
    score_fixture,
)


class TestBet1Harness(unittest.TestCase):
    def test_generate_counts_and_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = generate(Path(tmp))
            self.assertEqual(len(manifest), 20)
            defective = [e for e in manifest if not e["clean"]]
            clean = [e for e in manifest if e["clean"]]
            self.assertEqual(len(defective), 16)
            self.assertEqual(len(clean), 4)
            for entry in manifest:
                self.assertTrue((Path(tmp) / entry["id"] / entry["file"]).exists())

    def test_generate_deterministic(self):
        with tempfile.TemporaryDirectory() as t1, tempfile.TemporaryDirectory() as t2:
            m1 = generate(Path(t1))
            m2 = generate(Path(t2))
            self.assertEqual(m1, m2)

    def test_scorer_hit_and_tolerance(self):
        entry = {"id": "x", "file": "users.py", "line": 6, "clean": False}
        self.assertTrue(score_fixture(entry, "see users.py:6 SQLi")["hit"])
        self.assertTrue(score_fixture(entry, "users.py L8 concat")["hit"])
        self.assertFalse(score_fixture(entry, "users.py:40 unrelated")["hit"])
        self.assertFalse(score_fixture(entry, "no file cited")["hit"])

    def test_scorer_clean_flags_fp(self):
        entry = {"id": "c", "file": "util.py", "line": None, "clean": True}
        self.assertTrue(score_fixture(entry, "issue in util.py:2")["false_positive"])
        self.assertFalse(
            score_fixture(entry, "all clear, nothing found")["false_positive"]
        )

    def test_advisory_is_non_blocking_shape(self):
        comment = advisory_comment("bet1-01", "findings text")
        self.assertIn("non-blocking", comment)
        self.assertIn("bet1-01", comment)
        self.assertIn("findings text", comment)

    def test_cli_generate_and_score_exit_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            for argv in (["--generate", "--dir", tmp], ["--score", "--dir", tmp]):
                res = subprocess.run(
                    [
                        sys.executable,
                        str(PROJECT_ROOT / "scripts" / "bet1_advisory_spike.py"),
                    ]
                    + argv,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                self.assertEqual(res.returncode, 0, res.stderr)
            summary = json.loads(
                subprocess.run(
                    [
                        sys.executable,
                        str(PROJECT_ROOT / "scripts" / "bet1_advisory_spike.py"),
                        "--score",
                        "--dir",
                        tmp,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=120,
                ).stdout
            )
            self.assertEqual(summary["fixtures"], 20)
            # No advisories written yet -> all misses, no false positives.
            self.assertEqual(summary["hits"], 0)
            self.assertEqual(summary["false_positives"], 0)


if __name__ == "__main__":
    unittest.main()
