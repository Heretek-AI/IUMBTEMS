#!/usr/bin/env python3
"""Phase 03-search-anomaly: DDG anti-bot page must surface as BLOCKED.

DuckDuckGo Lite answers suspected automation with an HTTP-2xx image-selection
CAPTCHA (the "anomaly" interstitial). It is not empty, but it carries no
``result-link`` rows, so ``search_duckduckgo`` silently returned ``[]`` and the
block was logged as a normal ``results: 0`` query.

These tests pin the fix:

* the recorded interstitial fixture reports ``status == "blocked"`` (not an
  empty result list) and never raises through the legacy list contract,
* a normal results page whose snippet merely *contains* the word "anomaly"
  still parses — the detection is anchored to page chrome, not the word,
* ``.research/retrieval.jsonl`` records ``status: "blocked"`` / ``blocked:
  true`` distinctly from a genuine ``status: "empty"`` query,
* an actionable engine-fallback/backoff hint is surfaced to the caller.

Fixtures live in ``runner/tests/fixtures/``:
``ddg_anomaly_page.html`` is the page captured live from
``https://lite.duckduckgo.com/lite/`` (14,213 bytes, HTTP 202).
"""

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ANOMALY_HTML = (FIXTURES / "ddg_anomaly_page.html").read_text(encoding="utf-8")
RESULTS_HTML = (FIXTURES / "ddg_results_page.html").read_text(encoding="utf-8")
EMPTY_HTML = (
    "<!DOCTYPE html><html><head><title>DuckDuckGo</title></head>"
    '<body><center id="lite_wrapper"><span class="header">DuckDuckGo</span>'
    "<p>No results.</p></center></body></html>"
)


def _load_search():
    """Import the plain script (it is not part of an importable package)."""
    path = PROJECT_ROOT / "skills" / "epistemic_search" / "scripts" / "search.py"
    spec = importlib.util.spec_from_file_location("iumbtems_search_anomaly", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["iumbtems_search_anomaly"] = module
    spec.loader.exec_module(module)
    return module


class _PatchedFetch:
    """Context manager replacing ``_fetch_ddg_html`` with a fixture."""

    def __init__(self, module, html):
        self._module = module
        self._html = html
        self._original = None

    def __enter__(self):
        self._original = self._module._fetch_ddg_html
        self._module._fetch_ddg_html = lambda _q: self._html
        return self

    def __exit__(self, *exc):
        self._module._fetch_ddg_html = self._original
        return False


class TestAnomalyDetectionAnchor(unittest.TestCase):
    """Detection must key off page chrome, not the bare word "anomaly"."""

    @classmethod
    def setUpClass(cls):
        cls.search = _load_search()

    def test_recorded_interstitial_is_detected(self):
        self.assertTrue(self.search._is_ddg_anomaly_page(ANOMALY_HTML))

    def test_bare_word_anomaly_in_snippet_is_not_detected(self):
        """A results page mentioning "anomaly" is not a block."""
        snippet = (
            '<table><tr><td><a class="result-link" '
            'href="https://x.example/a">Anomaly detection</a></td>'
            '<td class="result-snippet">the word anomaly appears here</td>'
            "</tr></table>"
        )
        self.assertFalse(self.search._is_ddg_anomaly_page(snippet))

    def test_marker_alongside_real_results_is_not_a_block(self):
        """Even a marker embedded in a snippet cannot flag a results page."""
        page = (
            '<table><tr><td><a class="result-link" '
            'href="https://x.example/a">Result</a></td>'
            '<td class="result-snippet">discusses anomaly-modal and '
            "assets/anomaly/images/challenge/</td></tr></table>"
        )
        self.assertFalse(self.search._is_ddg_anomaly_page(page))

    def test_empty_body_is_not_a_block(self):
        self.assertFalse(self.search._is_ddg_anomaly_page(""))


class TestBlockedIsDistinctFromEmpty(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.search = _load_search()

    def setUp(self):
        # Isolate telemetry: search calls log via IUMBTEMS_RESEARCH_DIR.
        self._tmp = tempfile.TemporaryDirectory()
        self._old_env = os.environ.get("IUMBTEMS_RESEARCH_DIR")
        os.environ["IUMBTEMS_RESEARCH_DIR"] = str(Path(self._tmp.name) / ".research")

    def tearDown(self):
        if self._old_env is None:
            os.environ.pop("IUMBTEMS_RESEARCH_DIR", None)
        else:
            os.environ["IUMBTEMS_RESEARCH_DIR"] = self._old_env
        self._tmp.cleanup()

    def test_interstitial_reports_blocked_not_ok(self):
        with _PatchedFetch(self.search, ANOMALY_HTML):
            outcome = self.search.search_duckduckgo_detailed("any query")
        self.assertEqual(outcome["status"], "blocked")
        self.assertEqual(outcome["results"], [])
        # OpenCode v2 ships no `brave`; the hint must not recommend it.
        self.assertNotIn("brave", outcome["hint"])
        self.assertIn("firecrawl", outcome["hint"])
        self.assertIn("searxng", outcome["hint"])
        self.assertIn("TINYFISH_API_KEY", outcome["hint"])

    def test_normal_page_reports_ok_and_parses(self):
        with _PatchedFetch(self.search, RESULTS_HTML):
            outcome = self.search.search_duckduckgo_detailed("anomaly detection")
        self.assertEqual(outcome["status"], "ok")
        self.assertEqual(len(outcome["results"]), 2)
        self.assertEqual(
            outcome["results"][0]["url"], "https://example.com/anomaly-101"
        )
        # The snippet legitimately contains "anomaly" and was still parsed.
        self.assertIn("anomaly", outcome["results"][0]["snippet"].lower())

    def test_genuine_no_hits_reports_empty(self):
        with _PatchedFetch(self.search, EMPTY_HTML):
            outcome = self.search.search_duckduckgo_detailed("no such thing")
        self.assertEqual(outcome["status"], "empty")
        self.assertEqual(outcome["results"], [])

    def test_network_failure_reports_error_not_blocked(self):
        with _PatchedFetch(self.search, ""):
            outcome = self.search.search_duckduckgo_detailed("any query")
        self.assertEqual(outcome["status"], "error")
        self.assertNotEqual(outcome["status"], "blocked")

    def test_legacy_list_contract_still_returns_a_list(self):
        """Callers that only want results must keep working (no raise)."""
        with _PatchedFetch(self.search, ANOMALY_HTML):
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                results = self.search.search_duckduckgo("any query")
        self.assertIsInstance(results, list)
        self.assertEqual(results, [])
        # The actionable hint is surfaced even on the legacy path.
        self.assertIn("BLOCKED", stderr.getvalue())

    def test_require_raises_search_blocked_with_hint(self):
        with _PatchedFetch(self.search, ANOMALY_HTML):
            with self.assertRaises(self.search.SearchBlocked) as ctx:
                self.search.require_search_duckduckgo("any query")
        self.assertIn("firecrawl", ctx.exception.hint)
        self.assertNotIn("brave", ctx.exception.hint)

    def test_require_passes_results_through_when_not_blocked(self):
        with _PatchedFetch(self.search, RESULTS_HTML):
            results = self.search.require_search_duckduckgo("anomaly detection")
        self.assertEqual(len(results), 2)


class TestBlockedTelemetry(unittest.TestCase):
    """`.research/retrieval.jsonl` must distinguish blocked from empty."""

    @classmethod
    def setUpClass(cls):
        cls.search = _load_search()

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name) / ".research"
        self._old_env = os.environ.get("IUMBTEMS_RESEARCH_DIR")
        os.environ["IUMBTEMS_RESEARCH_DIR"] = str(self.base)

    def tearDown(self):
        if self._old_env is None:
            os.environ.pop("IUMBTEMS_RESEARCH_DIR", None)
        else:
            os.environ["IUMBTEMS_RESEARCH_DIR"] = self._old_env
        self._tmp.cleanup()

    def _events(self, base: Path):
        log = base / "retrieval.jsonl"
        return [
            json.loads(line)
            for line in log.read_text(encoding="utf-8").splitlines()
            if line
        ]

    def test_blocked_and_empty_are_logged_distinctly(self):
        with _PatchedFetch(self.search, ANOMALY_HTML):
            with redirect_stderr(io.StringIO()):
                self.search.search_duckduckgo("blocked query")
        with _PatchedFetch(self.search, EMPTY_HTML):
            self.search.search_duckduckgo("empty query")
        with _PatchedFetch(self.search, RESULTS_HTML):
            self.search.search_duckduckgo("ok query")

        events = self._events(self.base)
        by_query = {e["query"]: e for e in events if e.get("kind") == "query"}
        self.assertEqual(len(by_query), 3)

        blocked = by_query["blocked query"]
        self.assertEqual(blocked["status"], "blocked")
        self.assertTrue(blocked["blocked"])

        empty = by_query["empty query"]
        self.assertEqual(empty["status"], "empty")
        self.assertNotIn("blocked", empty)

        ok = by_query["ok query"]
        self.assertEqual(ok["status"], "ok")
        self.assertEqual(ok["results"], 2)

    def test_log_false_suppresses_telemetry(self):
        """The preflight probe uses log=False so it is counted nowhere."""
        with _PatchedFetch(self.search, RESULTS_HTML):
            self.search.search_duckduckgo_detailed("probe query", log=False)
        self.assertFalse((self.base / "retrieval.jsonl").exists())

    def test_summarize_still_walks_richer_events(self):
        """Richer events must not break the runner's existing summarizer."""
        from runner.retrieval_log import summarize

        with _PatchedFetch(self.search, ANOMALY_HTML):
            with redirect_stderr(io.StringIO()):
                self.search.search_duckduckgo("blocked query")

        stats = summarize(self.base)
        self.assertEqual(stats["queries"], 1)
        self.assertEqual(stats["results"], 0)


class TestCliStatusSurface(unittest.TestCase):
    """The CLI must offer a machine-readable blocked signal + hint."""

    @classmethod
    def setUpClass(cls):
        cls.search = _load_search()

    def test_parse_status_flag(self):
        query, allowed, blocked, output_json, output_status = (
            self.search._parse_cli_args(["--status", "hello"])
        )
        self.assertEqual(query, "hello")
        self.assertFalse(output_json)
        self.assertTrue(output_status)
        self.assertIsNone(allowed)
        self.assertIsNone(blocked)


if __name__ == "__main__":
    unittest.main()
