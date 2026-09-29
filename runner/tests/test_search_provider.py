#!/usr/bin/env python3
"""Phase 03-search-anomaly deliverables 2-7: cached provider, free-first
ladder, cost reporting, ask-gate delivery, and the mode-aware preflight gate.

Deliverable 1 (DDG anomaly detection + blocked telemetry) is covered by
``test_search_anomaly.py``. These tests pin the rest:

* `runner/preflight.py` resolves the active provider free-first, classifies it
  free/metered (BYO keys are metered), counts only OUR path's searches, and
  emits the acceptance-shaped one-liner,
* the availability gate HALTs retrieval-requiring modes on a positively
  unusable search, warns for internal modes, and warns (never halts/overrides)
  on an implicit Console,
* `run_swarm` fails fast BEFORE spawning when the gate halts,
* `install.sh --search-gate` writes the ask rule opt-in only.

Everything here is offline: the network-touching probe is patched, and the
install test reads/writes a temp HOME only.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.preflight import (  # noqa: E402
    BYO_PROVIDERS,
    build_search_report,
    canonical_engine,
    connected_provider_is_advisory,
    connected_websearch_provider,
    count_our_searches,
    estimate_search_cost,
    format_search_line,
    mode_requires_retrieval,
    preflight,
    provider_classification,
    resolve_search_provider,
    search_gate,
    search_usable,
)
from runner.research_swarm import (  # noqa: E402
    EXIT_PREFLIGHT_HALT,
    SwarmRunner,
)
from runner.retrieval_log import log_event  # noqa: E402


class TestProviderClassification(unittest.TestCase):
    def test_free_and_metered_and_unknown(self):
        # DuckDuckGo / SearXNG are free.
        for p in ("duckduckgo", "searxng"):
            self.assertEqual(provider_classification(p), "free", p)
        # BYO keys count as metered (vendor-billed); Console is metered.
        for p in list(BYO_PROVIDERS) + ["console", "brave"]:
            self.assertEqual(provider_classification(p), "metered", p)
        self.assertEqual(provider_classification("mystery"), "unknown")
        self.assertEqual(provider_classification(None), "unknown")

    def test_cost_estimate(self):
        self.assertEqual(estimate_search_cost("duckduckgo", 7), 0.0)
        self.assertEqual(estimate_search_cost("console", 3), 0.03)
        # Vendor billing is not ours to guess.
        self.assertIsNone(estimate_search_cost("exa", 3))


class TestFreeFirstLadder(unittest.TestCase):
    def test_default_is_zero_key_duckduckgo(self):
        resolved = resolve_search_provider({}, env={})
        self.assertEqual(resolved["provider"], "duckduckgo")
        self.assertEqual(resolved["tier"], "free")
        self.assertFalse(resolved["explicit"])

    def test_byo_key_beats_searxng_and_ddg(self):
        resolved = resolve_search_provider(
            {}, env={"SEARXNG_URL": "http://localhost:8080", "TAVILY_API_KEY": "k"}
        )
        self.assertEqual(resolved["provider"], "tavily")
        self.assertEqual(resolved["tier"], "metered")
        self.assertEqual(resolved["source"], "byo-env-key")

    def test_searxng_beats_ddg_when_no_byo_key(self):
        resolved = resolve_search_provider(
            {}, env={"SEARXNG_URL": "http://localhost:8080"}
        )
        self.assertEqual(resolved["provider"], "searxng")
        self.assertEqual(resolved["tier"], "free")

    def test_explicit_provider_is_never_overridden(self):
        # A deliberate websearch.provider wins even when a BYO key is present.
        resolved = resolve_search_provider(
            {"websearch": {"provider": "searxng"}},
            env={"EXA_API_KEY": "k"},
        )
        self.assertEqual(resolved["provider"], "searxng")
        self.assertTrue(resolved["explicit"])

    def test_explicit_engine_config_is_a_pin(self):
        resolved = resolve_search_provider(
            {"search_engine": "firecrawl"}, env={"EXA_API_KEY": "k"}
        )
        self.assertEqual(resolved["provider"], "firecrawl")
        self.assertTrue(resolved["explicit"])

    def test_tinyfish_only_config_does_not_halt(self):
        resolved = resolve_search_provider({}, env={"TINYFISH_API_KEY": "k"})
        self.assertEqual(resolved["provider"], "tinyfish")
        self.assertEqual(resolved["tier"], "metered")
        self.assertTrue(resolved["available"])
        gate = search_gate("research", resolved, {"ok": False, "status": "blocked"})
        self.assertEqual(gate["action"], "ok")

    def test_searxng_without_url_is_unavailable_even_when_explicit(self):
        # Explicit selection is NOT availability: no SEARXNG_URL means the
        # localhost default is unreachable and the gate must HALT with the fix.
        resolved = resolve_search_provider({"search_engine": "searxng"}, env={})
        self.assertEqual(resolved["provider"], "searxng")
        self.assertTrue(resolved["explicit"])
        self.assertFalse(resolved["available"])
        gate = search_gate("research", resolved, {"ok": True, "status": "ok"})
        self.assertEqual(gate["action"], "halt")
        self.assertIn("SEARXNG_URL", gate["message"])

    def test_explicit_provider_that_is_also_connected_is_available(self):
        # websearch.provider=tavily with the credential in the integration store
        # (no env key) must not halt: it is explicit AND connected.
        resolved = resolve_search_provider(
            {},
            env={"IUMBTEMS_CONNECTED_WEBSEARCH_PROVIDER": "tavily"},
            host_provider="tavily",
        )
        self.assertEqual(resolved["provider"], "tavily")
        self.assertTrue(resolved["explicit"])
        self.assertTrue(resolved["available"])
        self.assertTrue(resolved["connected"])
        gate = search_gate("research", resolved, {"ok": False, "status": "blocked"})
        self.assertEqual(gate["action"], "ok")

    def test_connected_provider_is_consulted_and_usable(self):
        # A /connect-ed provider has its credential in the host integration
        # store, not our env; it must resolve available and never halt.
        resolved = resolve_search_provider(
            {}, env={"IUMBTEMS_CONNECTED_WEBSEARCH_PROVIDER": "tavily"}
        )
        self.assertEqual(resolved["provider"], "tavily")
        self.assertEqual(resolved["source"], "host-connected")
        self.assertTrue(resolved["available"])
        self.assertTrue(resolved["connected"])
        gate = search_gate("research", resolved, {"ok": False, "status": "blocked"})
        self.assertEqual(gate["action"], "ok")

    def test_connected_provider_from_config(self):
        resolved = resolve_search_provider(
            {"websearch": {"connected_provider": "firecrawl"}}, env={}
        )
        self.assertEqual(resolved["provider"], "firecrawl")
        self.assertTrue(resolved["available"])
        self.assertEqual(resolved["source"], "host-connected")

    def test_connected_provider_from_workspace_state_file_is_advisory(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True)
            (base / "websearch-state.json").write_text(
                json.dumps(
                    {
                        "connected_provider": "tavily",
                        "connected_providers": ["tavily"],
                        "updated": datetime.now(timezone.utc).isoformat(),
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(connected_websearch_provider(base, {}, {}), "tavily")
            self.assertTrue(connected_provider_is_advisory(base, {}, {}))
            report = build_search_report(base, config={}, env={})
            # Advisory: the file alone must NOT mark a provider available (no
            # TAVILY_API_KEY and no host-confirmed connection). The unbacked
            # claim is dropped from the banner and recorded as ignored...
            self.assertEqual(report["provider"], "duckduckgo")
            self.assertEqual(report["advisory_ignored"], "tavily")
            # ...so it cannot suppress the fail-fast halt.
            gate = search_gate("research", report, {"ok": False, "status": "blocked"})
            self.assertEqual(gate["action"], "halt")
            self.assertEqual(gate["reason"], "no_usable_search")

    def test_stale_workspace_state_file_is_ignored(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True)
            (base / "websearch-state.json").write_text(
                json.dumps(
                    {
                        "connected_provider": "tavily",
                        "connected_providers": ["tavily"],
                        "updated": "2020-01-01T00:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(connected_websearch_provider(base, {}, {}), "")
            self.assertFalse(connected_provider_is_advisory(base, {}, {}))
            report = build_search_report(base, config={}, env={})
            self.assertEqual(report["provider"], "duckduckgo")

    def test_state_file_without_updated_stamp_is_ignored(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True)
            (base / "websearch-state.json").write_text(
                json.dumps({"connected_provider": "exa"}), encoding="utf-8"
            )
            self.assertEqual(connected_websearch_provider(base, {}, {}), "")
            report = build_search_report(base, config={}, env={})
            self.assertEqual(report["provider"], "duckduckgo")

    def test_forged_fresh_file_cannot_grant_availability(self):
        # A hand-written fresh file marks a nonexistent credential as available
        # in the old code and suppressed the halt. It must not any more.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True)
            (base / "websearch-state.json").write_text(
                json.dumps(
                    {
                        "connected_provider": "exa",
                        "connected_providers": ["exa"],
                        "updated": datetime.now(timezone.utc).isoformat(),
                    }
                ),
                encoding="utf-8",
            )
            search = build_search_report(base, config={}, env={})
            gate = search_gate("research", search, {"ok": False, "status": "blocked"})
            self.assertEqual(gate["action"], "halt")
            self.assertEqual(gate["reason"], "no_usable_search")

    def test_advisory_file_with_a_real_key_is_usable(self):
        # The file still helps reporting, and with a resolvable credential the
        # rung serves the run rather than halting.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True)
            (base / "websearch-state.json").write_text(
                json.dumps(
                    {
                        "connected_provider": "tavily",
                        "connected_providers": ["tavily"],
                        "updated": datetime.now(timezone.utc).isoformat(),
                    }
                ),
                encoding="utf-8",
            )
            report = build_search_report(base, config={}, env={"TAVILY_API_KEY": "k"})
            self.assertEqual(report["provider"], "tavily")
            self.assertTrue(report["available"])
            gate = search_gate("research", report, {"ok": False, "status": "blocked"})
            self.assertEqual(gate["action"], "ok")

    def test_host_confirmed_channel_is_not_advisory(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True)
            (base / "websearch-state.json").write_text(
                json.dumps(
                    {
                        "connected_provider": "exa",
                        "updated": datetime.now(timezone.utc).isoformat(),
                    }
                ),
                encoding="utf-8",
            )
            env = {"IUMBTEMS_CONNECTED_WEBSEARCH_PROVIDER": "tavily"}
            self.assertEqual(connected_websearch_provider(base, {}, env), "tavily")
            self.assertFalse(connected_provider_is_advisory(base, {}, env))

    def test_byo_without_key_is_unavailable_not_a_downgrade(self):
        resolved = resolve_search_provider({}, env={}, host_provider="tavily")
        self.assertEqual(resolved["provider"], "tavily")
        self.assertFalse(resolved["available"])
        self.assertTrue(resolved["explicit"])

    def test_console_is_never_implicit(self):
        # No console anywhere in the ladder unless the host tells us it is on.
        self.assertNotEqual(resolve_search_provider({}, env={})["provider"], "console")
        console = resolve_search_provider({"console_implicit": True}, env={})
        self.assertEqual(console["provider"], "console")
        self.assertFalse(console["explicit"])


_FIFO_FEEDER = (
    "import os, sys, time, json\n"
    "from datetime import datetime, timezone\n"
    "fifo = sys.argv[1]\n"
    "valid = json.dumps({'connected_provider': 'exa',\n"
    "                    'connected_providers': ['exa'],\n"
    "                    'updated': datetime.now(timezone.utc).isoformat()})\n"
    "fd = os.open(fifo, os.O_WRONLY)\n"
    "os.write(fd, valid.encode())\n"
    "os.close(fd)\n"
    "time.sleep(0.7)\n"
    "try:\n"
    "    fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)\n"
    "    os.write(fd, b'not json')\n"
    "    os.close(fd)\n"
    "except OSError:\n"
    "    pass\n"
)


def _run_python(code, timeout=20):
    return subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(PROJECT_ROOT),
    )


class TestAdvisoryStateFileSafety(unittest.TestCase):
    """N1: the advisory state file is single-read, regular-file-only, bounded.

    The old code read ``websearch-state.json`` twice (provider, then advisory
    flag). A FIFO could serve fresh JSON to the first read and garbage to the
    second, so ``advisory`` became ``False`` and the workspace file was treated
    as host-confirmed — granting ``available=True`` with no credential. A FIFO
    with no writer blocked ``Path.read_text`` forever (preflight + doctor hang);
    a symlink to ``/dev/zero`` read forever.
    """

    def _base(self, tmp):
        base = Path(tmp) / ".research"
        base.mkdir(parents=True, exist_ok=True)
        return base

    def _fresh(self, provider):
        return json.dumps(
            {
                "connected_provider": provider,
                "connected_providers": [provider],
                "updated": datetime.now(timezone.utc).isoformat(),
            }
        )

    def test_build_search_report_reads_state_exactly_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            (base / "websearch-state.json").write_text(
                self._fresh("tavily"), encoding="utf-8"
            )
            seen = []

            def one_read(_base_dir):
                seen.append(_base_dir)
                # A second read would (under the old bug) observe a different
                # file and flip the advisory verdict to host-confirmed.
                return "tavily" if len(seen) == 1 else ""

            with mock.patch(
                "runner.preflight._read_state_provider", side_effect=one_read
            ):
                build_search_report(base, config={}, env={})
            self.assertEqual(len(seen), 1)

    def test_fifo_state_file_cannot_grant_availability(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            fifo = base / "websearch-state.json"
            os.mkfifo(fifo)
            feeder = subprocess.Popen(
                [sys.executable, "-c", _FIFO_FEEDER, str(fifo)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                with mock.patch(
                    "runner.preflight._engine_probe",
                    return_value={"ok": False, "status": "blocked", "results": 0},
                ):
                    report = preflight(
                        base, mode="research", probe=True, timeout=1.0, env={}
                    )
            finally:
                feeder.kill()
                feeder.wait()
            search = report["search"]
            # The FIFO is refused as non-regular, so the forged claim is ignored.
            self.assertNotEqual(search.get("provider"), "exa")
            self.assertFalse(
                search.get("available") is True
                and search.get("connected")
                and not search.get("advisory")
            )
            self.assertEqual(report["search_gate"]["action"], "halt")
            self.assertEqual(report["search_gate"]["reason"], "no_usable_search")

    def test_fifo_without_feeder_does_not_hang_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            os.mkfifo(base / "websearch-state.json")
            code = (
                "import sys; sys.path.insert(0, " + repr(str(PROJECT_ROOT)) + ")\n"
                "from pathlib import Path\n"
                "from runner.preflight import preflight\n"
                "r = preflight(Path(" + repr(str(base)) + "), mode='research',"
                " probe=False, timeout=0.5, env={})\n"
                "print('provider=' + str(r['search'].get('provider')))\n"
            )
            proc = _run_python(code)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("provider=duckduckgo", proc.stdout)

    def test_fifo_without_feeder_does_not_hang_doctor(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            os.mkfifo(base / "websearch-state.json")
            args = json.dumps({"base_dir": str(base), "probe": False})
            proc = subprocess.run(
                [
                    sys.executable,
                    str(PROJECT_ROOT / "runner" / "mcp_server.py"),
                    "call",
                    "iumbtems_doctor",
                    args,
                ],
                capture_output=True,
                text=True,
                timeout=20,
                cwd=str(PROJECT_ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("report", proc.stdout)

    def test_symlink_to_device_is_refused_without_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            try:
                os.symlink("/dev/zero", base / "websearch-state.json")
            except OSError:
                self.skipTest("symlinks not available")
            code = (
                "import sys; sys.path.insert(0, " + repr(str(PROJECT_ROOT)) + ")\n"
                "from pathlib import Path\n"
                "from runner.preflight import _read_state_provider\n"
                "print('state=' + repr(_read_state_provider(Path("
                + repr(str(base))
                + "))))\n"
            )
            proc = _run_python(code, timeout=15)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("state=''", proc.stdout)

    def test_oversized_state_file_is_refused(self):
        from runner import preflight as preflight_module

        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            (base / "websearch-state.json").write_text(
                self._fresh("tavily") + " " * 4096, encoding="utf-8"
            )
            with mock.patch.object(preflight_module, "STATE_MAX_BYTES", 64):
                self.assertEqual(preflight_module._read_state_provider(base), "")
                report = build_search_report(base, config={}, env={})
            self.assertEqual(report["provider"], "duckduckgo")
            self.assertIsNone(report["advisory_ignored"])

    def test_future_updated_stamp_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            future = datetime.now(timezone.utc) + timedelta(days=2)
            (base / "websearch-state.json").write_text(
                json.dumps(
                    {
                        "connected_provider": "tavily",
                        "connected_providers": ["tavily"],
                        "updated": future.isoformat(),
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(connected_websearch_provider(base, {}, {}), "")
            self.assertFalse(connected_provider_is_advisory(base, {}, {}))

    def test_advisory_free_provider_id_cannot_force_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            (base / "websearch-state.json").write_text(
                self._fresh("duckduckgo"), encoding="utf-8"
            )
            # A BYO key is a real, metered path; the advisory free claim must not
            # suppress it into a "free" tier.
            report = build_search_report(base, config={}, env={"EXA_API_KEY": "k"})
            self.assertEqual(report["provider"], "exa")
            self.assertEqual(report["tier"], "metered")

    def test_advisory_searxng_claim_does_not_bypass_missing_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            (base / "websearch-state.json").write_text(
                self._fresh("searxng"), encoding="utf-8"
            )
            # No SEARXNG_URL: the state file cannot conjure a self-hosted engine.
            report = build_search_report(base, config={}, env={})
            self.assertEqual(report["provider"], "duckduckgo")

    def test_fresh_file_with_real_credential_still_usable(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._base(tmp)
            (base / "websearch-state.json").write_text(
                self._fresh("tavily"), encoding="utf-8"
            )
            report = build_search_report(base, config={}, env={"TAVILY_API_KEY": "k"})
            self.assertEqual(report["provider"], "tavily")
            self.assertTrue(report["available"])
            gate = search_gate("research", report, {"ok": False, "status": "blocked"})
            self.assertEqual(gate["action"], "ok")


class TestSearchReport(unittest.TestCase):
    def test_line_shape_and_estimate(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            log_event(base, "query", query="a", results=2)
            log_event(base, "query", query="b", results=0)
            log_event(base, "cache", url="u", hash="h")
            report = build_search_report(base, config={}, env={})
            self.assertEqual(report["searches"], 2)  # OUR path only, not the cache
            self.assertEqual(report["metered"], "no")
            self.assertIn("search: duckduckgo (free)", report["line"])
            self.assertIn("our-path searches: 2", report["line"])
            self.assertIn("~$0.00 est", report["line"])
            self.assertIn("metered-mode: no", report["line"])

    def test_console_line_is_metered_estimate(self):
        report = build_search_report(
            Path(tempfile.mkdtemp()),
            config={"console_implicit": True},
            env={},
        )
        self.assertEqual(report["provider"], "console")
        self.assertIn("(metered)", report["line"])
        self.assertIn("~$0.00 est", report["line"])  # zero searches so far
        self.assertIn("metered-mode: yes", report["line"])
        self.assertTrue(report["console_implicit"])

    def test_byo_line_admits_unknown_price(self):
        report = build_search_report(
            Path(tempfile.mkdtemp()), config={}, env={"EXA_API_KEY": "k"}
        )
        self.assertIn("search: exa (metered)", report["line"])
        self.assertIn("~$? est", report["line"])
        self.assertIn("vendor-billed", report["line"])
        self.assertIn("metered-mode: yes", report["line"])

    def test_missing_log_counts_zero(self):
        report = build_search_report(Path(tempfile.mkdtemp()), config={}, env={})
        self.assertEqual(report["searches"], 0)
        self.assertIn("our-path searches: 0", report["line"])


class TestPerRunCost(unittest.TestCase):
    def test_since_scopes_count_to_this_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            log_event(base, "query", query="prior", results=3)
            from runner.retrieval_log import current_offset

            offset = current_offset(base)
            log_event(base, "query", query="this-run", results=2)
            report = build_search_report(base, config={}, env={}, since=offset)
            self.assertEqual(report["searches"], 1)
            self.assertIn("our-path searches: 1", report["line"])
            # Without `since` the whole cumulative log is still visible.
            self.assertEqual(count_our_searches(base), 2)


class TestProbeExclusion(unittest.TestCase):
    """The reachability probe must never be counted as an agent search."""

    def _patch_fetch(self, html):
        sys.path.insert(
            0, str(PROJECT_ROOT / "skills" / "epistemic_search" / "scripts")
        )
        import search  # noqa: PLC0415

        original = search._fetch_ddg_html
        search._fetch_ddg_html = lambda _q: html
        self.addCleanup(lambda: setattr(search, "_fetch_ddg_html", original))

    def test_probe_is_not_logged_and_search_line_reads_zero(self):
        results_html = (
            '<table><tr><td><a class="result-link" href="https://x.example/a">R'
            '</a></td><td class="result-snippet">s</td></tr></table>'
        )
        self._patch_fetch(results_html)
        old_env = os.environ.get("IUMBTEMS_RESEARCH_DIR")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            os.environ["IUMBTEMS_RESEARCH_DIR"] = str(base)
            try:
                report = preflight(
                    base, mode="research", mock_mode=True, probe=True, env={}
                )
            finally:
                if old_env is None:
                    os.environ.pop("IUMBTEMS_RESEARCH_DIR", None)
                else:
                    os.environ["IUMBTEMS_RESEARCH_DIR"] = old_env
            self.assertEqual(report["engine_probe"].get("status"), "ok")
            # No probe event landed in the runner's workspace...
            self.assertFalse((base / "retrieval.jsonl").exists())
            # ...and the report reads an honest zero.
            self.assertEqual(report["search"]["searches"], 0)
            self.assertIn("our-path searches: 0", report["search"]["line"])

    def test_probe_does_not_leak_into_process_cwd_workspace(self):
        """A `--dir /tmp/X/.research` run must not append to the repo's log."""
        results_html = (
            '<table><tr><td><a class="result-link" href="https://x.example/a">R'
            '</a></td><td class="result-snippet">s</td></tr></table>'
        )
        self._patch_fetch(results_html)
        old_env = os.environ.pop("IUMBTEMS_RESEARCH_DIR", None)
        cwd_log = Path.cwd() / ".research" / "retrieval.jsonl"
        before = cwd_log.stat().st_size if cwd_log.exists() else 0
        try:
            with tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp) / ".research"
                preflight(base, mode="research", mock_mode=True, probe=True, env={})
                self.assertFalse((base / "retrieval.jsonl").exists())
        finally:
            if old_env is not None:
                os.environ["IUMBTEMS_RESEARCH_DIR"] = old_env
        after = cwd_log.stat().st_size if cwd_log.exists() else 0
        self.assertEqual(before, after, "probe leaked into the cwd workspace log")


class TestEngineAliasNormalization(unittest.TestCase):
    """BLOCKER 1: an engine alias must not skip the probe / downgrade the gate."""

    RESULTS_HTML = (
        '<table><tr><td><a class="result-link" href="https://x.example/a">R'
        '</a></td><td class="result-snippet">s</td></tr></table>'
    )

    def test_canonical_engine_folds_aliases(self):
        for alias in ("ddg", "DDG", "DuckDuckGo", " duckduckgo ", "duckduckgo"):
            self.assertEqual(canonical_engine(alias), "duckduckgo", alias)
        self.assertEqual(canonical_engine("firecrawl"), "firecrawl")
        self.assertEqual(canonical_engine(None), "")

    def test_alias_resolves_to_zero_key_duckduckgo(self):
        # A non-default engine pins the provider, but every ddg spelling is the
        # SAME zero-key default and must not be treated as a separate pin.
        for alias in ("ddg", "DuckDuckGo", "DDG", " duckduckgo"):
            resolved = resolve_search_provider({"search_engine": alias}, env={})
            self.assertEqual(resolved["provider"], "duckduckgo", alias)
            self.assertFalse(resolved["explicit"], alias)

    def test_alias_probe_runs_not_skipped(self):
        sys.path.insert(
            0, str(PROJECT_ROOT / "skills" / "epistemic_search" / "scripts")
        )
        import search  # noqa: PLC0415

        original = search._fetch_ddg_html
        search._fetch_ddg_html = lambda _q: self.RESULTS_HTML
        self.addCleanup(lambda: setattr(search, "_fetch_ddg_html", original))
        from runner.preflight import _engine_probe

        for alias in ("ddg", "DDG", "DuckDuckGo", " duckduckgo"):
            outcome = _engine_probe(alias, True, 1.0)
            self.assertNotIn("skipped", outcome, alias)
            self.assertEqual(outcome.get("status"), "ok", alias)

    def test_preflight_probes_alias_and_halts(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch(
                "runner.preflight._engine_probe",
                return_value={"ok": False, "status": "blocked", "results": 0},
            ) as probe:
                report = preflight(
                    Path(tmp),
                    mode="research",
                    mock_mode=True,
                    config={"search_engine": "ddg"},
                    env={},
                )
            # The alias reaches the probe as the canonical engine (so it runs).
            probe.assert_called_with("duckduckgo", True, 5.0)
            self.assertEqual(report["engine"], "duckduckgo")
            self.assertEqual(report["search_gate"]["action"], "halt")

    def test_probe_timeout_defaults_to_5s(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch(
                "runner.preflight._engine_probe",
                return_value={"ok": True, "status": "ok", "results": 1},
            ) as probe:
                preflight(
                    Path(tmp),
                    mode="research",
                    mock_mode=True,
                    config={"search_engine": "duckduckgo"},
                    env={},
                )
            probe.assert_called_with("duckduckgo", True, 5.0)

    def test_probe_timeout_reads_config_search_timeout_s(self):
        for configured, expected in ((2.5, 2.5), (0, 5.0), ("soon", 5.0), (None, 5.0)):
            with self.subTest(configured=configured):
                with tempfile.TemporaryDirectory() as tmp:
                    with mock.patch(
                        "runner.preflight._engine_probe",
                        return_value={"ok": True, "status": "ok", "results": 1},
                    ) as probe:
                        preflight(
                            Path(tmp),
                            mode="research",
                            mock_mode=True,
                            config={"search_timeout_s": configured},
                            env={},
                        )
                    probe.assert_called_with("duckduckgo", True, expected)

    def test_searxng_url_config_reaches_the_provider_resolver(self):
        """config `searxng_url` is a real consumer input for the doctor/gate path."""
        with tempfile.TemporaryDirectory() as tmp:
            report = preflight(
                Path(tmp),
                mode="research",
                mock_mode=True,
                probe=False,
                config={
                    "search_engine": "searxng",
                    "searxng_url": "http://localhost:8080",
                },
                env={},
            )
            self.assertEqual(report["search"]["provider"], "searxng")
            self.assertTrue(report["search"]["available"])
            self.assertEqual(report["search_gate"]["action"], "ok")

    def test_env_searxng_url_beats_config(self):
        from runner.preflight import _env_with_config_searxng

        merged = _env_with_config_searxng(
            {"searxng_url": "http://from-config:1"},
            {"SEARXNG_URL": "http://from-env:2"},
        )
        self.assertEqual(merged["SEARXNG_URL"], "http://from-env:2")
        # Absent/null config leaves the env untouched.
        self.assertNotIn(
            "SEARXNG_URL",
            _env_with_config_searxng({"searxng_url": None}, {"PATH": "/bin"}),
        )
        self.assertEqual(
            _env_with_config_searxng({"searxng_url": "http://cfg:1"}, {})[
                "SEARXNG_URL"
            ],
            "http://cfg:1",
        )

    def test_probe_timeout_is_wired_through(self):
        sys.path.insert(
            0, str(PROJECT_ROOT / "skills" / "epistemic_search" / "scripts")
        )
        import search  # noqa: PLC0415

        seen = {}
        original = search._fetch_ddg_html

        def capture(_q, timeout=15.0):
            seen["timeout"] = timeout
            return self.RESULTS_HTML

        search._fetch_ddg_html = capture
        self.addCleanup(lambda: setattr(search, "_fetch_ddg_html", original))
        from runner.preflight import _engine_probe

        _engine_probe("duckduckgo", True, 2.5)
        self.assertEqual(seen.get("timeout"), 2.5)


class TestModeRequiresRetrieval(unittest.TestCase):
    def test_retrieval_modes(self):
        for mode in ("research", "scout", "darkharvest", "hybrid"):
            self.assertTrue(mode_requires_retrieval(mode, {}), mode)

    def test_internal_modes_do_not_require(self):
        for mode in ("audit", "brainstorm"):
            self.assertFalse(mode_requires_retrieval(mode, {}), mode)

    def test_strict_brainstorm_requires(self):
        self.assertTrue(mode_requires_retrieval("brainstorm", {"strict": True}))
        self.assertTrue(mode_requires_retrieval("brainstorm", {"domain_pack": "legal"}))

    def test_hybrid_halts_on_blocked_probe(self):
        gate = search_gate(
            "hybrid",
            {
                "provider": "duckduckgo",
                "available": True,
                "explicit": False,
                "tier": "free",
            },
            {"ok": False, "status": "blocked"},
        )
        self.assertEqual(gate["action"], "halt")


class TestAvailabilityGate(unittest.TestCase):
    def _search(self, provider, available=True, explicit=False, **extra):
        return {
            "provider": provider,
            "available": available,
            "explicit": explicit,
            "tier": provider_classification(provider),
            **extra,
        }

    def test_halt_on_blocked_for_retrieval_mode(self):
        gate = search_gate(
            "research", self._search("duckduckgo"), {"ok": False, "status": "blocked"}
        )
        self.assertEqual(gate["action"], "halt")
        self.assertEqual(gate["reason"], "no_usable_search")
        # Actionable: names a BYO key and SearXNG.
        self.assertIn("EXA_API_KEY", gate["message"])
        self.assertIn("docker-compose.infra.yml", gate["message"])

    def test_halt_on_error_for_scout_and_darkharvest(self):
        for mode in ("scout", "darkharvest"):
            gate = search_gate(
                mode, self._search("duckduckgo"), {"ok": False, "status": "error"}
            )
            self.assertEqual(gate["action"], "halt", mode)

    def test_internal_mode_warns_and_proceeds(self):
        gate = search_gate(
            "audit", self._search("duckduckgo"), {"ok": False, "status": "blocked"}
        )
        self.assertEqual(gate["action"], "warn")
        self.assertIn("does not require retrieval", gate["message"])

    def test_strict_brainstorm_halts(self):
        gate = search_gate(
            "brainstorm",
            self._search("duckduckgo"),
            {"ok": False, "status": "blocked"},
            config={"strict": True},
        )
        self.assertEqual(gate["action"], "halt")

    def test_unknown_probe_never_halts(self):
        gate = search_gate(
            "research", self._search("duckduckgo"), {"skipped": "probe disabled"}
        )
        self.assertEqual(gate["action"], "warn")
        self.assertEqual(gate["reason"], "search_unknown")

    def test_ok_when_probe_ok(self):
        gate = search_gate(
            "research", self._search("duckduckgo"), {"ok": True, "status": "ok"}
        )
        self.assertEqual(gate["action"], "ok")

    def test_byo_missing_key_halts_with_env_var_named(self):
        search = self._search("exa", available=False, explicit=True)
        gate = search_gate("research", search, {"ok": True, "status": "ok"})
        self.assertEqual(gate["action"], "halt")
        self.assertIn("EXA_API_KEY", gate["message"])

    def test_console_implicit_warns_loudly_never_overrides(self):
        search = self._search("console", available=True, explicit=False)
        search["console_implicit"] = True
        gate = search_gate("research", search, {"ok": True, "status": "ok"})
        self.assertEqual(gate["action"], "warn")
        self.assertEqual(gate["reason"], "console_metered")
        self.assertIn("$0.01", gate["message"])
        self.assertIn("will not override", gate["message"])

    def test_search_usable_tristate(self):
        self.assertTrue(search_usable(self._search("exa"), {}))
        self.assertFalse(
            search_usable(self._search("duckduckgo"), {"status": "blocked"})
        )
        self.assertIsNone(
            search_usable(self._search("duckduckgo"), {"skipped": "probe disabled"})
        )


class TestPreflightIntegratesSearch(unittest.TestCase):
    def test_report_carries_search_and_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = preflight(
                Path(tmp),
                mode="research",
                mock_mode=True,
                probe=False,
                env={},
            )
            self.assertIn("search", report)
            self.assertIn("search_gate", report)
            self.assertIn("search:", format_search_line(report["search"]))
            # Probe skipped -> inconclusive -> warn, never halt.
            self.assertEqual(report["search_gate"]["action"], "warn")

    def test_blocked_probe_halts_research(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch(
                "runner.preflight._engine_probe",
                return_value={"ok": False, "status": "blocked", "results": 0},
            ):
                report = preflight(Path(tmp), mode="research", mock_mode=True)
            self.assertEqual(report["search_gate"]["action"], "halt")
            self.assertTrue(
                any("search gate HALT" in w for w in report["warnings"]),
                report["warnings"],
            )


class TestRunPathFailFast(unittest.TestCase):
    def _blocked(self):
        return mock.patch(
            "runner.preflight._engine_probe",
            return_value={"ok": False, "status": "blocked", "results": 0},
        )

    def test_run_swarm_halts_before_spawning(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=False, mode="research")
            buf = io.StringIO()
            with self._blocked():
                with redirect_stdout(buf):
                    status = runner.run_swarm("grounded objective")
            out = buf.getvalue()
            self.assertIn("PREFLIGHT HALT", out)
            self.assertEqual(status, "halted")
            self.assertTrue(runner._halted)
            # No scopes/spawns happened: scratchpads has no scope dirs.
            scope_dirs = (
                [p for p in (base / "scratchpads").iterdir() if p.is_dir()]
                if (base / "scratchpads").exists()
                else []
            )
            self.assertEqual(scope_dirs, [])
            # The session is marked failed rather than silently completed.
            manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest.get("status"), "FAILED")

    def test_dry_run_validates_and_never_halts(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(
                base_dir=base, mock_mode=False, mode="research", dry_run=True
            )
            buf = io.StringIO()
            with self._blocked():
                with redirect_stdout(buf):
                    status = runner.run_swarm("grounded objective")
            out = buf.getvalue()
            self.assertNotIn("PREFLIGHT HALT", out)
            self.assertIn("[Dry Run]", out)
            self.assertEqual(status, "dry-run")
            self.assertFalse(runner._halted)

    def test_cli_domain_pack_halts_strict_brainstorm(self):
        # `--domain-pack` lives on the runner, not the persisted config; it must
        # still make a brainstorm retrieval-requiring and halt when ungrounded.
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(
                base_dir=base,
                mock_mode=False,
                mode="brainstorm",
                domain_pack="biopharma",
            )
            buf = io.StringIO()
            with self._blocked():
                with redirect_stdout(buf):
                    status = runner.run_swarm("strict brainstorm objective")
            self.assertIn("PREFLIGHT HALT", buf.getvalue())
            self.assertEqual(status, "halted")

    def test_host_provider_env_is_plumbed_to_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = SwarmRunner(
                base_dir=Path(tmp) / ".research", mock_mode=True, mode="research"
            )
            with mock.patch.dict(os.environ, {"IUMBTEMS_WEBSEARCH_PROVIDER": "tavily"}):
                self.assertEqual(runner._host_websearch_provider(), "tavily")
                buf = io.StringIO()
                with mock.patch(
                    "runner.preflight._engine_probe",
                    return_value={"skipped": "probe disabled"},
                ):
                    with redirect_stdout(buf):
                        runner.run_swarm("objective")
            self.assertIn("search: tavily", buf.getvalue())

    def test_run_path_advisory_state_file_does_not_suppress_halt(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True, exist_ok=True)
            (base / "websearch-state.json").write_text(
                json.dumps(
                    {
                        "connected_provider": "tavily",
                        "connected_providers": ["tavily"],
                        "updated": datetime.now(timezone.utc).isoformat(),
                    }
                ),
                encoding="utf-8",
            )
            runner = SwarmRunner(base_dir=base, mock_mode=False, mode="research")
            buf = io.StringIO()
            with mock.patch(
                "runner.preflight._engine_probe",
                return_value={"ok": False, "status": "blocked", "results": 0},
            ):
                with redirect_stdout(buf):
                    status = runner.run_swarm("objective")
            out = buf.getvalue()
            # The advisory file has no resolvable credential, so it must not
            # keep the run grounded: the gate halts.
            self.assertIn("PREFLIGHT HALT", out)
            self.assertEqual(status, "halted")
            self.assertTrue(runner._halted)

    def test_run_path_host_confirmed_channel_keeps_grounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
            buf = io.StringIO()
            with mock.patch.dict(
                os.environ, {"IUMBTEMS_CONNECTED_WEBSEARCH_PROVIDER": "tavily"}
            ):
                with mock.patch(
                    "runner.preflight._engine_probe",
                    return_value={"ok": False, "status": "blocked", "results": 0},
                ):
                    with redirect_stdout(buf):
                        status = runner.run_swarm("objective")
            self.assertIn("search: tavily", buf.getvalue())
            self.assertNotEqual(status, "halted")

    def test_main_exits_nonzero_on_halt(self):
        with tempfile.TemporaryDirectory() as tmp:
            from runner import research_swarm as rs

            argv = [
                "research_swarm.py",
                "--mode",
                "research",
                "--objective",
                "x",
                "--dir",
                str(Path(tmp) / ".research"),
            ]
            with mock.patch.object(rs.SwarmRunner, "run_swarm", return_value="halted"):
                with mock.patch.object(sys, "argv", argv):
                    with self.assertRaises(SystemExit) as ctx:
                        rs.main()
            self.assertEqual(ctx.exception.code, EXIT_PREFLIGHT_HALT)
            self.assertNotEqual(ctx.exception.code, 0)
            # Distinct from argparse's usage-error code (2) so CI can tell a
            # deliberate refusal from a mistyped invocation.
            self.assertNotEqual(ctx.exception.code, 2)

    def test_mock_runs_are_exempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
            buf = io.StringIO()
            with mock.patch(
                "runner.preflight._engine_probe",
                return_value={"ok": False, "status": "blocked", "results": 0},
            ):
                with redirect_stdout(buf):
                    runner.run_swarm("mock objective")
            # Mock mode never retrieves, so it proceeds to synthesis.
            self.assertNotIn("PREFLIGHT HALT", buf.getvalue())


class TestMcpRunStatus(unittest.TestCase):
    """BLOCKER 2: MCP must report the ACTUAL outcome, not the raw gate verdict."""

    def _call(self, args):
        from runner.mcp_server import _handle_swarm_research

        return json.loads(_handle_swarm_research(args))

    def _blocked(self):
        return mock.patch(
            "runner.preflight._engine_probe",
            return_value={"ok": False, "status": "blocked", "results": 0},
        )

    def test_mock_run_reports_completed_not_halted(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self._blocked():
                payload = self._call(
                    {
                        "objective": "x",
                        "base_dir": str(Path(tmp) / ".research"),
                        "mock_claude": True,
                    }
                )
            # A mock run never retrieves and completes; it is exempt from halt.
            self.assertEqual(payload["status"], "completed")
            self.assertIn("report", payload)

    def test_dry_run_reports_dry_run_not_halted(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self._blocked():
                payload = self._call(
                    {
                        "objective": "x",
                        "base_dir": str(Path(tmp) / ".research"),
                        "dry_run": True,
                    }
                )
            self.assertEqual(payload["status"], "dry-run")

    def test_real_halt_still_reports_halted(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self._blocked():
                payload = self._call(
                    {"objective": "x", "base_dir": str(Path(tmp) / ".research")}
                )
            self.assertEqual(payload["status"], "halted")
            self.assertEqual(payload["reason"], "no_usable_search")


class TestMcpDoctorProvider(unittest.TestCase):
    """RESIDUAL 3: the doctor and the run banner must name the same provider."""

    def test_doctor_honours_host_provider_env(self):
        from runner.mcp_server import _handle_doctor

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(
                os.environ,
                {"IUMBTEMS_WEBSEARCH_PROVIDER": "tavily"},
            ):
                out = _handle_doctor({"base_dir": tmp, "probe": False})
            report = json.loads(out)["report"]
            self.assertEqual(report["search"]["provider"], "tavily")

    def test_doctor_and_run_agree(self):
        from runner.mcp_server import _handle_doctor

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True, exist_ok=True)
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
            with mock.patch.dict(os.environ, {"IUMBTEMS_WEBSEARCH_PROVIDER": "tavily"}):
                with mock.patch(
                    "runner.preflight._engine_probe",
                    return_value={"skipped": "probe disabled"},
                ):
                    buf = io.StringIO()
                    with redirect_stdout(buf):
                        runner.run_swarm("objective")
                doctor = json.loads(
                    _handle_doctor({"base_dir": str(base), "probe": False})
                )["report"]
            self.assertIn("search: tavily", buf.getvalue())
            self.assertEqual(doctor["search"]["provider"], "tavily")


class TestInstallSearchGate(unittest.TestCase):
    def _run_install(self, home, *args):
        env = dict(os.environ, HOME=str(home))
        return subprocess.run(
            ["bash", str(PROJECT_ROOT / "install.sh"), *args],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            env=env,
        )

    def _oc_path(self, home):
        return home / ".config" / "opencode" / "opencode.json"

    def test_without_flag_permissions_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            oc.write_text(
                '{"$schema":"https://opencode.ai/config.json"}', encoding="utf-8"
            )
            res = self._run_install(home)
            self.assertEqual(res.returncode, 0, res.stderr)
            cfg = json.loads(oc.read_text(encoding="utf-8"))
            self.assertNotIn("permissions", cfg)

    def test_flag_writes_ask_rule_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            oc.write_text(
                '{"$schema":"https://opencode.ai/config.json"}', encoding="utf-8"
            )
            res = self._run_install(home, "--search-gate")
            self.assertEqual(res.returncode, 0, res.stderr)
            cfg = json.loads(oc.read_text(encoding="utf-8"))
            self.assertIn(
                {"action": "websearch", "resource": "*", "effect": "ask"},
                cfg.get("permissions", []),
            )
            # Second run must not duplicate the rule.
            second = self._run_install(home, "--search-gate")
            self.assertEqual(second.returncode, 0, second.stderr)
            cfg2 = json.loads(oc.read_text(encoding="utf-8"))
            self.assertEqual(
                [r for r in cfg2["permissions"] if r.get("action") == "websearch"],
                [{"action": "websearch", "resource": "*", "effect": "ask"}],
            )

    def test_flag_upgrades_existing_allow_rule_and_keeps_unrelated(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            oc.write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": [
                            {"action": "websearch", "resource": "*", "effect": "allow"},
                            {"action": "bash", "resource": "*", "effect": "ask"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            res = self._run_install(home, "--search-gate")
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertNotIn("command not found", res.stdout + res.stderr)
            rules = json.loads(oc.read_text(encoding="utf-8"))["permissions"]
            websearch = [r for r in rules if r.get("action") == "websearch"]
            self.assertEqual(
                websearch,
                [{"action": "websearch", "resource": "*", "effect": "ask"}],
            )
            # An unrelated permission must survive untouched.
            self.assertIn({"action": "bash", "resource": "*", "effect": "ask"}, rules)

    def test_mixed_ask_and_allow_is_normalised_to_single_ask(self):
        # A competing websearch `allow` must not survive alongside the ask gate.
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            oc.write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": [
                            {"action": "websearch", "resource": "*", "effect": "ask"},
                            {"action": "websearch", "resource": "*", "effect": "allow"},
                            {"action": "bash", "resource": "*", "effect": "ask"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            res = self._run_install(home, "--search-gate")
            self.assertEqual(res.returncode, 0, res.stderr)
            rules = json.loads(oc.read_text(encoding="utf-8"))["permissions"]
            self.assertEqual(
                [r for r in rules if r.get("action") == "websearch"],
                [{"action": "websearch", "resource": "*", "effect": "ask"}],
            )
            self.assertIn({"action": "bash", "resource": "*", "effect": "ask"}, rules)

    def test_non_list_permissions_is_refused_not_clobbered(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            oc.write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": {"bash": "ask"},
                    }
                ),
                encoding="utf-8",
            )
            res = self._run_install(home, "--search-gate")
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("not a list", res.stdout + res.stderr)
            # Nothing was silently dropped/replaced.
            self.assertEqual(
                json.loads(oc.read_text(encoding="utf-8"))["permissions"],
                {"bash": "ask"},
            )

    def test_existing_deny_is_never_downgraded(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            deny = {"action": "websearch", "resource": "*", "effect": "deny"}
            oc.write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": [deny],
                    }
                ),
                encoding="utf-8",
            )
            res = self._run_install(home, "--search-gate")
            self.assertNotEqual(res.returncode, 0)
            combined = (res.stdout + res.stderr).lower()
            self.assertIn("deny", combined)
            self.assertIn("stricter", combined)
            # The deny survives untouched — no silent downgrade to ask.
            self.assertEqual(
                json.loads(oc.read_text(encoding="utf-8"))["permissions"], [deny]
            )

    def test_resource_scoped_allow_is_preserved_not_silently_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            scoped = {
                "action": "websearch",
                "resource": "secret query",
                "effect": "allow",
            }
            bash = {"action": "bash", "resource": "*", "effect": "allow"}
            oc.write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": [scoped, bash],
                    }
                ),
                encoding="utf-8",
            )
            res = self._run_install(home, "--search-gate")
            self.assertEqual(res.returncode, 0, res.stderr)
            rules = json.loads(oc.read_text(encoding="utf-8"))["permissions"]
            # The scoped rule the user wrote is neither deleted nor rewritten.
            self.assertIn(scoped, rules)
            self.assertIn(bash, rules)
            self.assertIn(
                {"action": "websearch", "resource": "*", "effect": "ask"}, rules
            )
            # The keep-decision is reported, never silent.
            self.assertIn("Preserved resource-scoped websearch allow", res.stdout)

    def test_wildcard_action_deny_is_never_downgraded(self):
        # Under last-match-wins, appending a websearch ask after a wildcard
        # deny ({action:"*"} or {action:"web*"}) would silently weaken it.
        for action in ("*", "web*"):
            with self.subTest(action=action):
                with tempfile.TemporaryDirectory() as tmp:
                    home = Path(tmp)
                    oc = self._oc_path(home)
                    oc.parent.mkdir(parents=True, exist_ok=True)
                    deny = {"action": action, "resource": "*", "effect": "deny"}
                    oc.write_text(
                        json.dumps(
                            {
                                "$schema": "https://opencode.ai/config.json",
                                "permissions": [deny],
                            }
                        ),
                        encoding="utf-8",
                    )
                    res = self._run_install(home, "--search-gate")
                    self.assertNotEqual(res.returncode, 0)
                    combined = (res.stdout + res.stderr).lower()
                    self.assertIn("deny", combined)
                    self.assertEqual(
                        json.loads(oc.read_text(encoding="utf-8"))["permissions"],
                        [deny],
                    )

    def test_malformed_effect_is_refused_not_rewritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            oc.write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": [
                            {"action": "websearch", "resource": "*", "effect": None}
                        ],
                    }
                ),
                encoding="utf-8",
            )
            res = self._run_install(home, "--search-gate")
            self.assertNotEqual(res.returncode, 0)

    def test_existing_ask_with_extra_keys_is_preserved_verbatim(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            rule = {
                "action": "websearch",
                "resource": "*",
                "effect": "ask",
                "note": "keep-me",
            }
            oc.write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": [rule],
                    }
                ),
                encoding="utf-8",
            )
            res = self._run_install(home, "--search-gate")
            self.assertEqual(res.returncode, 0, res.stderr)
            rules = json.loads(oc.read_text(encoding="utf-8"))["permissions"]
            # Verbatim — the unknown key must survive, not be rewritten away.
            self.assertEqual(rules, [rule])

    def test_existing_global_ask_followed_by_scoped_allow_moves_gate_last(self):
        # Last-match-wins: [ask(*), allow("specific query")] would let the
        # scoped allow bypass the gate. The gate must move last (verbatim).
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            ask = {"action": "websearch", "resource": "*", "effect": "ask"}
            scoped = {
                "action": "websearch",
                "resource": "specific query",
                "effect": "allow",
            }
            oc.write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": [ask, scoped],
                    }
                ),
                encoding="utf-8",
            )
            res = self._run_install(home, "--search-gate")
            self.assertEqual(res.returncode, 0, res.stderr)
            rules = json.loads(oc.read_text(encoding="utf-8"))["permissions"]
            # Scoped rule bytes preserved, but the gate is now last to win.
            self.assertIn(scoped, rules)
            self.assertEqual(rules[-1], ask)
            self.assertIn("Moved websearch ask gate", res.stdout)

    def test_broader_ask_followed_by_scoped_allow_appends_canonical(self):
        # A broader wildcard ask ({action:"*"}) with a later scoped websearch
        # allow is not "already gated" — the allow would win. Canonical ask
        # must be appended last.
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            oc = self._oc_path(home)
            oc.parent.mkdir(parents=True, exist_ok=True)
            broader = {"action": "*", "resource": "*", "effect": "ask"}
            scoped = {
                "action": "websearch",
                "resource": "specific query",
                "effect": "allow",
            }
            oc.write_text(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "permissions": [broader, scoped],
                    }
                ),
                encoding="utf-8",
            )
            res = self._run_install(home, "--search-gate")
            self.assertEqual(res.returncode, 0, res.stderr)
            rules = json.loads(oc.read_text(encoding="utf-8"))["permissions"]
            self.assertIn(broader, rules)
            self.assertIn(scoped, rules)
            self.assertEqual(
                rules[-1],
                {"action": "websearch", "resource": "*", "effect": "ask"},
            )
            self.assertIn("appending canonical ask", res.stdout.lower())

    def test_help_and_unknown_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            help_res = self._run_install(home, "--help")
            self.assertEqual(help_res.returncode, 0)
            self.assertIn("--search-gate", help_res.stdout)
            bad = self._run_install(home, "--nope")
            self.assertNotEqual(bad.returncode, 0)


if __name__ == "__main__":
    unittest.main()
