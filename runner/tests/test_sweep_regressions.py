#!/usr/bin/env python3
"""Regression tests for defects introduced by the Sonar remediation sweep (41d5f6f).

That commit landed green because these modules sit outside the unit suite:

* ``scripts/build_adapters.py`` — import-time ``NameError: name 'List' is not
  defined`` (annotations added by the complexity extraction, import never added).
  This broke CI job ``parity-matrix`` while the 138 tests stayed green.
* ``skills/epistemic_search/scripts/search.py`` — the ReDoS replacement
  (DDGLiteParser) decoded HTML entities and then emitted them unescaped, so a
  snippet containing ``&`` produced malformed XML; and a ``result-link`` nested
  inside a ``result-snippet`` destroyed parser state so the snippet was never
  recorded and every later row was mispaired.
* ``scripts/divergence_experiment.py`` — an extraction inverted the scope
  selection from "last scored audit" to "first", so multi-scope runs reported a
  different divergence than before.
* ``runner/research_swarm.py`` — a five-name backend allowlist rejected any
  PATH-resolvable backend outside it (``python3.11``, ``aider``, ``codex``).
* ``runner/path_safety.py`` — the containment helper had no callers at all.

Each test here targets exactly one of those.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import typing
import unittest
import xml.dom.minidom
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def _load_module(rel_path: str, name: str):
    """Import a plain script that is not part of a package."""
    path = PROJECT_ROOT / rel_path
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# Imported at module level (not stored on the TestCase) so the helpers are
# called as plain functions — assigning them to a class attribute would bind
# `self` as their first argument.
from runner.path_safety import safe_join, safe_resolve_path  # noqa: E402


class TestBuildAdaptersImportable(unittest.TestCase):
    """Importing build_adapters must not raise — this is the parity-matrix gate."""

    def test_module_imports_and_annotations_resolve(self):
        # The defect was `-> List[str]` with no `from typing import List`.
        #
        # Importing alone is NOT enough to catch it: Python 3.11 (what CI runs)
        # evaluates annotations at definition time and dies on import, but
        # Python 3.14 (PEP 649) defers annotation evaluation, so the NameError
        # only surfaces when something actually resolves the annotations. We
        # force that resolution with get_type_hints() so the test reproduces
        # the CI failure on every interpreter. An import-time NameError
        # propagates uncaught (red test) — no wrapper, per S8714.
        module = _load_module("scripts/build_adapters.py", "iumbtems_build_adapters")

        unresolved = []
        for attr_name, attr in list(vars(module).items()):
            if not callable(attr):
                continue
            fn = getattr(attr, "__func__", attr)
            try:
                # Reading __annotations__ (or resolving hints) forces PEP 649
                # deferred evaluation — which is where a missing `List` blows up.
                typing.get_type_hints(fn)
            except NameError as e:
                unresolved.append(f"{attr_name}: {e}")
            except Exception:
                # Callable without resolvable hints (builtins, partials) — not
                # an annotation defect.
                continue
        self.assertEqual(
            unresolved,
            [],
            "annotations reference undefined names (this is the Python 3.11 "
            f"import-time NameError): {unresolved}",
        )

    def test_check_mode_exits_zero(self):
        res = subprocess.run(
            [
                sys.executable,
                str(PROJECT_ROOT / "scripts" / "build_adapters.py"),
                "--check",
            ],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        self.assertEqual(
            res.returncode, 0, f"--check failed:\n{res.stdout}\n{res.stderr}"
        )


class TestSearchParserRegression(unittest.TestCase):
    """F4 (invalid XML) and F5 (nested-link desync) in the DDG lite parser."""

    @classmethod
    def setUpClass(cls):
        cls.search = _load_module(
            "skills/epistemic_search/scripts/search.py", "iumbtems_search"
        )

    def _parse(self, html: str):
        parser = self.search.DDGLiteParser()
        parser.feed(html)
        parser.flush()
        return parser.results

    def test_nested_result_link_inside_snippet_keeps_snippet(self):
        """A result-link nested in a snippet must not hijack capture state.

        Before the fix this returned [] — the nested anchor reset the buffer and
        the outer </td> found no open capture, so the snippet was never recorded
        and zip(links, snippets) produced nothing.
        """
        html = (
            "<table><tr>"
            '<td><a class="result-link" href="https://a.example/x">Title</a></td>'
            '<td class="result-snippet">See '
            '<a href="/l/?uddg=https%3A%2F%2Fy.example" class="result-link">this</a> page'
            "</td></tr></table>"
        )
        results = self._parse(html)
        self.assertEqual(len(results), 1, f"expected 1 result, got {results}")
        self.assertEqual(results[0]["title"], "Title")
        self.assertEqual(results[0]["snippet"], "See this page")

    def test_missing_snippet_does_not_desynchronise_later_rows(self):
        """A row without a snippet must not shift every subsequent pairing."""
        html = (
            "<table>"
            '<tr><td><a class="result-link" href="https://a.example/1">T1</a></td>'
            '<td class="result-snippet">S1</td></tr>'
            '<tr><td><a class="result-link" href="https://a.example/2">T2</a></td></tr>'
            '<tr><td><a class="result-link" href="https://a.example/3">T3</a></td>'
            '<td class="result-snippet">S3</td></tr>'
            "</table>"
        )
        results = self._parse(html)
        by_title = {r["title"]: r["snippet"] for r in results}
        self.assertEqual(by_title, {"T1": "S1", "T2": "", "T3": "S3"})

    def test_nested_anchor_in_title_does_not_close_capture_early(self):
        html = (
            "<table><tr>"
            '<td><a class="result-link" href="https://a.example/x">Main '
            "<span>and</span> <b>more</b></a></td>"
            '<td class="result-snippet">S</td>'
            "</tr></table>"
        )
        results = self._parse(html)
        self.assertEqual(results[0]["title"], "Main and more")

    def test_entity_bearing_fields_produce_well_formed_xml(self):
        """F4: decoded text must be re-escaped at emit time.

        A bare `&` from `&amp;` (or from a URL query string) makes the
        <search_results> document malformed.
        """
        xml_text = self.search.format_xml(
            [
                {
                    "title": "Q&A",
                    "url": "https://x.example/?a=1&b=2",
                    "snippet": "A & B and C++ <tips>",
                }
            ]
        )
        # Malformed output raises here (red test) — no wrapper, per S8714.
        xml.dom.minidom.parseString(xml_text)
        self.assertIn("&amp;", xml_text)
        self.assertIn("&lt;tips&gt;", xml_text)

    def test_entity_roundtrip_through_parser_and_formatter(self):
        """HTML `&amp;` decodes to `&` then re-encodes to `&amp;`."""
        html = (
            "<table><tr>"
            '<td><a class="result-link" href="https://a.example/x">Q&amp;A</a></td>'
            '<td class="result-snippet">A &amp; B</td>'
            "</tr></table>"
        )
        results = self._parse(html)
        self.assertEqual(results[0]["title"], "Q&A")
        self.assertEqual(results[0]["snippet"], "A & B")
        xml_text = self.search.format_xml(
            [
                {
                    "title": results[0]["title"],
                    "url": "https://a.example/x",
                    "snippet": results[0]["snippet"],
                }
            ]
        )
        xml.dom.minidom.parseString(xml_text)  # raises if malformed
        self.assertIn("<title>Q&amp;A</title>", xml_text)
        self.assertIn("<snippet>A &amp; B</snippet>", xml_text)


class TestDivergenceAggregation(unittest.TestCase):
    """F6: multi-scope runs must reduce deterministically, not by traversal order."""

    @classmethod
    def setUpClass(cls):
        cls.div = _load_module(
            "scripts/divergence_experiment.py", "iumbtems_divergence"
        )

    def _write_audits(self, base: Path, by_scope: dict):
        for scope, summary in by_scope.items():
            d = base / "scratchpads" / scope
            d.mkdir(parents=True, exist_ok=True)
            (d / "audit_report.json").write_text(
                json.dumps({"summary": summary}), encoding="utf-8"
            )

    def test_single_scope_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self._write_audits(
                base, {"scope_a": {"divergence_score": 0.5, "verified_passed": True}}
            )
            score, verified = self.div._extract_audit_divergence(base)
        self.assertAlmostEqual(score, 0.5)
        self.assertTrue(verified)

    def test_multiple_scopes_reduce_to_mean_not_first_or_last(self):
        """The rule is the mean — independent of scope-name sort order."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self._write_audits(
                base,
                {
                    "aaa_first": {"divergence_score": 0.0, "verified_passed": True},
                    "mmm_mid": {"divergence_score": 0.5, "verified_passed": True},
                    "zzz_last": {"divergence_score": 1.0, "verified_passed": False},
                },
            )
            score, verified = self.div._extract_audit_divergence(base)
        self.assertAlmostEqual(score, 0.5)
        # Not the first scope's 0.0, not the last scope's 1.0.
        self.assertNotAlmostEqual(score, 0.0)
        self.assertNotAlmostEqual(score, 1.0)
        # verified requires every scored audit to pass.
        self.assertFalse(verified)

    def test_unscored_audits_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self._write_audits(
                base,
                {
                    "aaa": {"verified_passed": True},  # no score
                    "bbb": {"divergence_score": 0.25, "verified_passed": True},
                },
            )
            score, verified = self.div._extract_audit_divergence(base)
        self.assertAlmostEqual(score, 0.25)
        self.assertTrue(verified)

    def test_no_audits_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            score, verified = self.div._extract_audit_divergence(Path(tmp))
        self.assertIsNone(score)
        self.assertIsNone(verified)


class TestBackendValidation(unittest.TestCase):
    """The backend check must resolve like subprocess, not allowlist five names."""

    @classmethod
    def setUpClass(cls):
        cls.swarm = _load_module("runner/research_swarm.py", "iumbtems_swarm")

    def test_known_shortcut_names_pass(self):
        self.assertEqual(
            self.swarm._validate_backend(["claude", "-p"]), ["claude", "-p"]
        )

    def test_path_resolvable_backends_are_accepted(self):
        """`python3.11`, `sh`, `npx`… were rejected by the five-name allowlist."""
        for name in ("python3", "sh", "env"):
            with self.subTest(backend=name):
                self.assertEqual(self.swarm._validate_backend([name]), [name])

    def test_absolute_path_to_executable_is_accepted(self):
        resolved = self.swarm.shutil.which("python3")
        self.assertIsNotNone(resolved, "python3 must be on PATH for this test")
        self.assertEqual(self.swarm._validate_backend([resolved]), [resolved])

    def test_unresolvable_backend_still_raises(self):
        with self.assertRaises(ValueError):
            self.swarm._validate_backend(["definitely-not-a-real-binary-xyz"])

    def test_empty_backend_falls_back_to_default(self):
        self.assertEqual(self.swarm._validate_backend([]), ["claude", "-p"])

    def test_bad_backend_becomes_runtime_error_not_propagated_valueerror(self):
        """A bad backend must surface as a run failure, not abort the swarm."""
        runner = self.swarm.SwarmRunner(
            mock_mode=False, base_dir=Path(tempfile.mkdtemp())
        )
        original = runner.build_agent_cmd
        runner.build_agent_cmd = lambda *a, **k: ["definitely-not-a-real-binary-xyz"]
        try:
            with self.assertRaises(RuntimeError) as ctx:
                runner.run_claude_process("prompt")
            self.assertIn("Invalid agent backend", str(ctx.exception))
        finally:
            runner.build_agent_cmd = original


class TestPathSafety(unittest.TestCase):
    """The containment helper must actually contain (and be importable)."""

    def test_relative_inside_base_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = safe_resolve_path("sub/file.json", tmp)
            self.assertTrue(str(p).startswith(os.path.realpath(tmp)))

    def test_dotdot_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                safe_resolve_path("../outside.json", tmp)

    def test_absolute_outside_base_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                safe_resolve_path("/etc/passwd", tmp)

    def test_absolute_inside_base_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            inner = Path(tmp) / "sub"
            inner.mkdir()
            p = safe_resolve_path(str(inner), tmp)
            self.assertEqual(p, Path(os.path.realpath(str(inner))))

    def test_safe_join_rejects_separators_and_dotdot(self):
        with tempfile.TemporaryDirectory() as tmp:
            for bad in ("../x", "a/b", "..", "", "."):
                with self.subTest(segment=bad):
                    with self.assertRaises(ValueError):
                        safe_join(tmp, bad)

    def test_safe_join_accepts_bare_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = safe_join(tmp, "abc123.json")
            self.assertEqual(p, Path(os.path.realpath(tmp)) / "abc123.json")


class TestKeyFileFailsLoudly(unittest.TestCase):
    """A typo'd --key-file must not silently export an unsigned bundle."""

    def test_pcrb_resolve_key_rejects_missing_file(self):
        from runner.pcrb import _resolve_key

        with self.assertRaises(ValueError):
            _resolve_key(None, Path("/definitely/not/a/real/key/file"))

    def test_pcrb_resolve_key_rejects_directory(self):
        from runner.pcrb import _resolve_key

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                _resolve_key(None, Path(tmp))

    def test_pcrb_resolve_key_reads_valid_file(self):
        from runner.pcrb import _resolve_key

        with tempfile.TemporaryDirectory() as tmp:
            kf = Path(tmp) / "key.txt"
            kf.write_text("secret\n", encoding="utf-8")
            self.assertEqual(_resolve_key(None, kf), b"secret")

    def test_pcrb_resolve_key_absent_returns_none(self):
        from runner.pcrb import _resolve_key

        self.assertIsNone(_resolve_key(None, None))


class TestNoStaleV1PluginSurface(unittest.TestCase):
    """Nothing outside the plugin may reference the removed V1 opencode surface.

    Dropping `plugin.server()` broke the Python tests *and* a Node snippet
    embedded in .github/workflows/validate-all-harnesses.yml that nobody
    thought of as "test code". Grep every non-node_modules file so a V1
    reference cannot hide in a workflow, a script, or a doc.
    """

    # Patterns that only make sense against the V1 plugin factory / config key.
    V1_PATTERNS = (
        "plugin.server()",
        "registerOpenCodeCommands",
        "experimental.session.compacting",
    )
    SCAN_DIRS = (
        ".github",
        "scripts",
        "bin",
        "config",
        "runner",
        "extensions",
        "docs",
        "skills",
    )
    SCAN_SUFFIXES = (".yml", ".yaml", ".js", ".ts", ".py", ".sh", ".json", ".md")

    def test_no_v1_surface_references(self):
        offenders = []
        for scan_dir in self.SCAN_DIRS:
            root = PROJECT_ROOT / scan_dir
            if not root.is_dir():
                continue
            for path in root.rglob("*"):
                if not path.is_file() or path.suffix not in self.SCAN_SUFFIXES:
                    continue
                if "node_modules" in path.parts or "__pycache__" in path.parts:
                    continue
                # Tests legitimately discuss the removed surface (that is what
                # they regression-check), so they are not offenders.
                if "tests" in path.parts:
                    continue
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                for pattern in self.V1_PATTERNS:
                    if pattern in text:
                        offenders.append(f"{path.relative_to(PROJECT_ROOT)}: {pattern}")
        self.assertEqual(
            offenders,
            [],
            "references to the removed V1 opencode plugin surface "
            "(these broke CI when `server()` was dropped): " + "; ".join(offenders),
        )


if __name__ == "__main__":
    unittest.main()
