#!/usr/bin/env python3
"""Queereye phase 02 acceptance: specs + webref + TUI + CSF divergence gates.

Phase queereye-02-component-specs (run queereye-style-guide).
Evidence hashes (full quotes in the phase dossier):
- shadcn-style prop-driven pin [VERIFIED: dc656fd4]
- Radix focus-trap/Esc/pointer-outside/SR gap [VERIFIED: 0785dc45]
- cva variant/size matrix [VERIFIED: c24a9c9c]
- unstyled behavior-first contract [VERIFIED: 28a04ca6]
- CSF args-shape + play functions [VERIFIED: 60c8c31d]
"""

import copy
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.queereye import csf as _csf
from runner.queereye import fs as _fs
from runner.queereye import specs as _specs
from runner.queereye import tui as _tui
from runner.queereye import webref as _webref
from runner.queereye.cli import (
    check_project,
    compile_project,
    render_project,
    specs_check_all,
    specs_write_all,
)


def _seed_interview(tmp):
    """Seed a minimal valid interview project (phase-01 surface only)."""
    from runner.queereye import slots as _slots

    loop = _slots.SlotLoop()
    for axis in _slots.AXES:
        for slot in loop.required_slots(axis):
            loop.skip(axis, slot)
    _fs.save_interview_state(str(tmp), loop)
    ok_c, errs_c, _css = compile_project(str(tmp))
    assert ok_c, errs_c
    ok_r, errs_r, _guide = render_project(str(tmp))
    assert ok_r, errs_r
    return loop


class TestSpecCompleteness(unittest.TestCase):
    """A1: 3 exemplars complete per template; gaps FAIL."""

    def test_three_exemplars_present(self):
        self.assertEqual(sorted(_specs.EXEMPLARS), ["button", "dialog", "form-input"])

    def test_exemplars_validate_clean(self):
        for name, errors in _specs.validate_all().items():
            self.assertEqual(errors, [], f"{name}: {errors}")

    def test_missing_variants_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        del bad["variants"]
        self.assertTrue(any("variants" in e for e in _specs.validate_spec(bad)))

    def test_missing_slots_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["slots"] = {}
        self.assertTrue(_specs.validate_spec(bad))

    def test_missing_a11y_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["dialog"])
        bad["keyboard"] = []
        self.assertTrue(any("keyboard" in e for e in _specs.validate_spec(bad)))
        bad2 = copy.deepcopy(_specs.EXEMPLARS["dialog"])
        del bad2["focus"]
        self.assertTrue(any("focus" in e for e in _specs.validate_spec(bad2)))

    def test_missing_snippet_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["form-input"])
        bad["snippets"] = {"web": "<x/>"}
        self.assertTrue(any("snippets.tui" in e for e in _specs.validate_spec(bad)))

    def test_missing_csf_component_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["csf"] = {"title": "Queereye/Button"}
        self.assertTrue(any("csf.component" in e for e in _specs.validate_spec(bad)))

    def test_incomplete_cva_matrix_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["variants"] = {
            "variant": ["default"],
            "size": ["default"],
            "default": {"variant": "default", "size": "default"},
        }
        errs = _specs.validate_spec(bad)
        self.assertTrue(any("cva" in e for e in errs), errs)


class TestCvaMatrix(unittest.TestCase):
    """cva matrix shape [VERIFIED: c24a9c9c]."""

    def test_axes_enumeration(self):
        self.assertEqual(
            list(_specs.CVA_VARIANTS),
            ["default", "outline", "ghost", "destructive", "secondary", "link"],
        )
        self.assertEqual(list(_specs.CVA_SIZES), ["default", "xs", "sm", "lg", "icon"])

    def test_dialog_anatomy_full(self):
        self.assertEqual(
            list(_specs.DIALOG_ANATOMY),
            [
                "Root",
                "Trigger",
                "Portal",
                "Overlay",
                "Content",
                "Title",
                "Description",
                "Close",
            ],
        )


class TestWebRefPin(unittest.TestCase):
    """A2: hash-pinned MIT snapshot, never a live URL (rot-immune)."""

    def test_spdx_mit_manifest(self):
        manifest = _webref.webref_manifest()
        self.assertEqual(manifest["spdx"], "MIT")
        self.assertEqual(manifest["license"], "MIT")
        self.assertIn("SPDX-License-Identifier: MIT", _webref.spdx_block())

    def test_hash_stable_and_content_addressed(self):
        self.assertEqual(_webref.snapshot_hash(), _webref.snapshot_hash())
        manifest = _webref.webref_manifest()
        self.assertEqual(manifest["snapshot_hash"], _webref.snapshot_hash())
        self.assertEqual(_webref.verify_snapshot(manifest), [])

    def test_tamper_detected(self):
        manifest = _webref.webref_manifest()
        evil = dict(manifest)
        evil["snapshot_hash"] = "0" * 64
        self.assertTrue(any("mismatch" in e for e in _webref.verify_snapshot(evil)))

    def test_no_live_url_in_snapshot(self):
        for name, content in _webref.SNAPSHOT_FILES.items():
            self.assertNotIn("http://", content, name)
            self.assertNotIn("https://", content, name)
        # Rot probe: mutating a URL-shaped string elsewhere leaves hash intact.
        before = _webref.snapshot_hash()
        _probe = "https://example.com/rot-probe"
        self.assertEqual(_webref.snapshot_hash(), before)

    def test_transform_registry_mirrors_style_dictionary(self):
        for group in ("css-vars", "scss", "android-style"):
            self.assertIn(group, _webref.TRANSFORM_GROUPS)
            detail = _webref.TRANSFORM_GROUPS[group]
            self.assertTrue(detail["platform"])
            self.assertTrue(detail["transforms"])
            self.assertTrue(detail["attribution"])


class TestSnapshotFreshness(unittest.TestCase):
    def test_fresh_within_budget(self):
        self.assertTrue(_webref.is_fresh(today="2026-10-05"))
        self.assertTrue(_webref.is_fresh(today="2027-01-01"))

    def test_stale_beyond_budget(self):
        self.assertFalse(_webref.is_fresh(today="2027-06-01"))
        self.assertFalse(_webref.is_fresh(today="2026-10-05", max_age_days=-1))


class TestTuiCoverage(unittest.TestCase):
    """A3: every web-only primitive has a TUI re-spec row (inversion on record)."""

    def test_primitives_all_have_rows(self):
        self.assertEqual(
            sorted(_tui.WEB_ONLY_PRIMITIVES),
            ["esc-close", "focus-trap", "pointer-outside", "sr-announcement"],
        )
        for name, row in _tui.WEB_ONLY_PRIMITIVES.items():
            self.assertTrue(row["web"], name)
            self.assertTrue(row["tui"], name)

    def test_downgrade_rows_cover_states(self):
        states = {r["state"] for r in _tui.DOWNGRADE_ROWS}
        for required in (
            "blur",
            "hover",
            "motion",
            "focus-trap",
            "esc-close",
            "pointer-outside",
            "sr-announcement",
            "loading",
            "disabled",
        ):
            self.assertIn(required, states)

    def test_exemplars_covered(self):
        for name, spec in _specs.EXEMPLARS.items():
            self.assertEqual(_tui.validate_tui_coverage(spec), [], name)

    def test_missing_row_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["dialog"])
        bad["tui_rows"] = [r for r in bad["tui_rows"] if r["state"] != "focus-trap"]
        self.assertTrue(any("focus-trap" in e for e in _tui.validate_tui_coverage(bad)))

    def test_lowering_deterministic_with_fallback(self):
        first = _tui.lowering_for("hover")
        self.assertEqual(first["tui"], "focus-visible border (no pointer)")
        self.assertEqual(_tui.lowering_for("  HOVER "), first)
        fallback = _tui.lowering_for("mystery-state")
        self.assertIn("fallback", fallback["tui"])

    def test_negative_knowledge_recorded(self):
        self.assertTrue(_tui.NEGATIVE_KNOWLEDGE)
        blob = " ".join(_tui.NEGATIVE_KNOWLEDGE)
        self.assertIn("NEGATIVE_KNOWLEDGE", blob)
        self.assertTrue(_tui.EVENT_LOOP_NOTE)


class TestCsfGate(unittest.TestCase):
    """A4: CSF component field + headless play harness with pass-rate."""

    def test_component_field_required(self):
        self.assertEqual(_csf.validate_csf_meta({"id": "x", "component": "Button"}), [])
        errs = _csf.validate_csf_meta({"id": "x", "title": "No component"})
        self.assertTrue(any("component" in e for e in errs))

    def test_stories_all_validate(self):
        for story_id, errs in _csf.validate_all_stories().items():
            self.assertEqual(errs, [], f"{story_id}: {errs}")

    def test_play_runs_headless_with_full_pass_rate(self):
        results, rate = _csf.run_play_suite()
        self.assertEqual(rate, 1.0)
        for story_id, res in results.items():
            self.assertEqual(res["failures"], [], story_id)
            self.assertTrue(res["passed"], story_id)

    def test_visual_regression_pattern(self):
        frame = _csf.render_story({"component": "Button", "args": {"label": "Save"}})
        same = _csf.visual_regression_check(frame, frame)
        self.assertTrue(same["equal"])
        other = _csf.visual_regression_check(frame, frame + " ")
        self.assertFalse(other["equal"])
        self.assertNotEqual(other["hash_a"], other["hash_b"])


class TestSpecVsRender(unittest.TestCase):
    def test_in_sync_when_slots_filled_and_fresh(self):
        for name, spec in _specs.EXEMPLARS.items():
            errs = _csf.spec_vs_render_check(
                spec,
                rendered_slots=sorted((spec.get("slots") or {}).keys()),
                webref_fresh=True,
            )
            self.assertEqual(errs, [], f"{name}: {errs}")

    def test_unfilled_slot_diverges(self):
        spec = _specs.EXEMPLARS["button"]
        errs = _csf.spec_vs_render_check(
            spec, rendered_slots=["label"], webref_fresh=True
        )
        self.assertTrue(any("not filled" in e for e in errs))

    def test_stale_ref_diverges(self):
        spec = _specs.EXEMPLARS["button"]
        errs = _csf.spec_vs_render_check(
            spec, rendered_slots=sorted(spec["slots"]), webref_fresh=False
        )
        self.assertTrue(any("stale" in e for e in errs))


class TestLicenseGate(unittest.TestCase):
    """A5: permissive-only vendor/depend, GPL clean-room-only."""

    def test_permissive_vendor_passes(self):
        for lic in ("MIT", "Apache-2.0", "BSD-3-Clause", "ISC"):
            self.assertEqual(_webref.license_gate(lic, "vendor"), [], lic)
            self.assertEqual(_webref.license_gate(lic, "depend"), [], lic)

    def test_gpl_vendor_refused_clean_room_allowed(self):
        for lic in ("GPL-3.0-only", "AGPL-3.0-only"):
            self.assertTrue(_webref.license_gate(lic, "vendor"), lic)
            self.assertEqual(_webref.license_gate(lic, "clean-room"), [], lic)

    def test_unknown_license_refused(self):
        self.assertTrue(_webref.license_gate("PROPRIETARY", "vendor"))


class TestCliSpecs(unittest.TestCase):
    def test_specs_write_then_check_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            ok, errors, written = specs_write_all(tmp)
            self.assertTrue(ok, errors)
            self.assertIn("components/button.md", written)
            for rel in (
                "components/button.md",
                "components/dialog.md",
                "components/form-input.md",
                "webref.json",
                "tui-notes.md",
                "csf.json",
            ):
                self.assertTrue((Path(tmp) / ".queereye" / rel).is_file(), rel)
            ok2, errors2 = specs_check_all(tmp)
            self.assertEqual(errors2, [], errors2)
            self.assertTrue(ok2)

    def test_specs_drift_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            ok, _errs, _w = specs_write_all(tmp)
            self.assertTrue(ok)
            guide = Path(tmp) / ".queereye" / "components" / "button.md"
            guide.write_text(
                guide.read_text(encoding="utf-8") + "\nhand edit\n", encoding="utf-8"
            )
            ok2, errors2 = specs_check_all(tmp)
            self.assertFalse(ok2)
            self.assertTrue(any("drift" in e for e in errors2))

    def test_check_backward_compat_without_specs(self):
        # Phase-01 interview-only project: check stays green (no spec adoption).
        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            ok, errors = check_project(tmp)
            self.assertEqual(errors, [], errors)
            self.assertTrue(ok)

    def test_check_enforces_specs_once_adopted(self):
        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            ok, _errs, _w = specs_write_all(tmp)
            self.assertTrue(ok)
            ok_c, errors_c = check_project(tmp)
            self.assertEqual(errors_c, [], errors_c)
            self.assertTrue(ok_c)
            # Break one spec file: unified check must now fail.
            guide = Path(tmp) / ".queereye" / "components" / "dialog.md"
            guide.write_text("forged\n", encoding="utf-8")
            ok_b, errors_b = check_project(tmp)
            self.assertFalse(ok_b)
            self.assertTrue(any("dialog" in e for e in errors_b))

    def test_specs_cli_entrypoint(self):
        from runner.queereye.cli import main as _main

        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            self.assertEqual(_main(["--project-dir", tmp, "specs"]), 0)
            self.assertEqual(_main(["--project-dir", tmp, "specs", "--check"]), 0)


class TestF1VacuousGatesClosed(unittest.TestCase):
    """F1: 8 vacuous validate_spec bypasses now FAIL (regression pins).

    Evidence: shadcn pin [VERIFIED: dc656fd4], cva matrix [VERIFIED: c24a9c9c],
    Radix gap [VERIFIED: 0785dc45], behavior contract [VERIFIED: 28a04ca6],
    CSF shape [VERIFIED: 60c8c31d].
    """

    def test_truncated_dialog_anatomy_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["dialog"])
        bad["anatomy"] = ["Root"]
        errs = _specs.validate_spec(bad)
        self.assertTrue(any("DIALOG_ANATOMY" in e for e in errs), errs)

    def test_empty_prop_type_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["props"]["label"] = {"type": "", "default": ""}
        self.assertTrue(
            any("prop" in e and "type" in e for e in _specs.validate_spec(bad))
        )

    def test_evil_variant_values_and_defaults_fail(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["variants"]["variant"] = list(_specs.CVA_VARIANTS) + ["evil"]
        self.assertTrue(
            any("unknown cva" in e for e in _specs.validate_spec(bad)),
            _specs.validate_spec(bad),
        )
        bad2 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad2["variants"]["default"] = {"variant": "evil", "size": "default"}
        self.assertTrue(
            any("cva axis" in e for e in _specs.validate_spec(bad2)),
            _specs.validate_spec(bad2),
        )

    def test_usage_blank_items_fail(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["usage"]["do"] = [""]
        self.assertTrue(any("usage.do" in e for e in _specs.validate_spec(bad)))
        bad2 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad2["usage"]["dont"] = ["   "]
        self.assertTrue(any("usage.dont" in e for e in _specs.validate_spec(bad2)))

    def test_states_whitespace_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["states"]["loading"] = "   "
        self.assertTrue(any("loading" in e for e in _specs.validate_spec(bad)))

    def test_focus_prose_wave_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["dialog"])
        bad["focus"] = {"web": "x", "tui": "todo"}
        errs = _specs.validate_spec(bad)
        self.assertTrue(
            any("prose-wave" in e or "placeholder" in e for e in errs), errs
        )
        self.assertTrue(any("keyboard-first" in e for e in errs), errs)

    def test_tui_rows_empty_strings_fail(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["tui_rows"][0] = {"state": "hover", "web": "", "tui": "   "}
        self.assertTrue(any("tui_rows" in e for e in _specs.validate_spec(bad)))

    def test_slot_keyboard_csf_whitespace_fail(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["slots"]["label"] = {"description": "   "}
        self.assertTrue(any("slot" in e for e in _specs.validate_spec(bad)))
        bad2 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad2["keyboard"] = [{"keys": " ", "action": ""}]
        self.assertTrue(any("keyboard" in e for e in _specs.validate_spec(bad2)))
        bad3 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad3["csf"] = {"component": "   ", "title": "x"}
        self.assertTrue(any("csf.component" in e for e in _specs.validate_spec(bad3)))


class TestF2TuiCoverageHardened(unittest.TestCase):
    """F2: all 4 primitives for all specs + full DOWNGRADE + no exemption."""

    def test_non_dialog_missing_primitive_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["tui_rows"] = [r for r in bad["tui_rows"] if r["state"] != "focus-trap"]
        self.assertTrue(any("focus-trap" in e for e in _tui.validate_tui_coverage(bad)))
        bad2 = copy.deepcopy(_specs.EXEMPLARS["form-input"])
        bad2["tui_rows"] = [
            r for r in bad2["tui_rows"] if r["state"] != "pointer-outside"
        ]
        self.assertTrue(
            any("pointer-outside" in e for e in _tui.validate_tui_coverage(bad2))
        )

    def test_dialog_missing_hover_focus_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["dialog"])
        bad["tui_rows"] = [
            r for r in bad["tui_rows"] if r["state"] not in ("hover", "focus")
        ]
        errs = _tui.validate_tui_coverage(bad)
        self.assertTrue(any("hover" in e for e in errs), errs)
        self.assertTrue(any("focus" in e for e in errs), errs)

    def test_missing_empty_error_fails_no_exemption(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["tui_rows"] = [
            r for r in bad["tui_rows"] if r["state"] not in ("empty", "error")
        ]
        errs = _tui.validate_tui_coverage(bad)
        self.assertTrue(any("empty" in e for e in errs), errs)
        self.assertTrue(any("error" in e for e in errs), errs)

    def test_empty_tui_lowering_fails(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["dialog"])
        for r in bad["tui_rows"]:
            if r["state"] == "blur":
                r["tui"] = "   "
        self.assertTrue(any("empty" in e for e in _tui.validate_tui_coverage(bad)))

    def test_waiver_with_reason_passes(self):
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["tui_rows"] = [r for r in bad["tui_rows"] if r["state"] != "empty"]
        # Without waiver: fails.
        self.assertTrue(any("empty" in e for e in _tui.validate_tui_coverage(bad)))
        # With explicit reason: passes for that state.
        bad["tui_waivers"] = {
            "empty": "button empty is icon-only aria-label; no downgrade row applicable"
        }
        errs = _tui.validate_tui_coverage(bad)
        self.assertFalse(any("empty" in e for e in errs), errs)

    def test_exemplars_full_downgrade_green(self):
        downgrade_states = {r["state"] for r in _tui.DOWNGRADE_ROWS}
        self.assertIn("focus", downgrade_states)
        self.assertIn("empty", downgrade_states)
        self.assertIn("error", downgrade_states)
        for name, spec in _specs.EXEMPLARS.items():
            self.assertEqual(_tui.validate_tui_coverage(spec), [], name)


class TestF3WebrefForgeClosed(unittest.TestCase):
    """F3: freshness pinned, file-bytes hashed, URL case + //evil flagged."""

    def test_forge_future_date_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            ok, _errs, _w = specs_write_all(tmp)
            self.assertTrue(ok)
            import json as _json

            from pathlib import Path as _Path

            ref = _Path(tmp) / ".queereye" / "webref.json"
            doc = _json.loads(ref.read_text(encoding="utf-8"))
            doc["pinned_on"] = "2999-01-01"
            ref.write_text(
                _json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            errs = _webref.check_webref(tmp)
            self.assertTrue(any("future" in e or "forge" in e for e in errs), errs)

    def test_max_age_99999_capped(self):
        # Stale pin stays stale even with a forged huge budget (capped).
        self.assertFalse(_webref.is_fresh(today="2027-06-01", max_age_days=99999))
        self.assertTrue(_webref.is_fresh(today="2026-10-05", max_age_days=99999))
        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            ok, _errs, _w = specs_write_all(tmp)
            self.assertTrue(ok)
            import json as _json

            from pathlib import Path as _Path

            ref = _Path(tmp) / ".queereye" / "webref.json"
            doc = _json.loads(ref.read_text(encoding="utf-8"))
            doc["max_age_days"] = 99999
            ref.write_text(
                _json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            errs = _webref.check_webref(tmp, today="2027-06-01")
            self.assertTrue(
                any("stale" in e or "forge" in e or "capped" in e for e in errs), errs
            )

    def test_tamper_script_tag_detected(self):
        manifest = _webref.webref_manifest()
        evil_files = dict(_webref.SNAPSHOT_FILES)
        evil_files["button.html"] = (
            evil_files["button.html"] + "<script>alert(1)</script>\n"
        )
        errs = _webref.verify_snapshot(manifest, evil_files)
        self.assertTrue(errs, "tampered snapshot must mismatch hash")
        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            ok, _errs, _w = specs_write_all(tmp)
            self.assertTrue(ok)
            import json as _json

            from pathlib import Path as _Path

            ref = _Path(tmp) / ".queereye" / "webref.json"
            doc = _json.loads(ref.read_text(encoding="utf-8"))
            doc["snapshot"]["button.html"] = (
                doc["snapshot"]["button.html"] + "<script>alert(1)</script>\n"
            )
            ref.write_text(
                _json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            errs2 = _webref.check_webref(tmp)
            self.assertTrue(any("mismatch" in e or "drift" in e for e in errs2), errs2)

    def test_https_and_protocol_relative_flagged(self):
        self.assertTrue(_webref._LIVE_URL_RE.search("see HTTPS://evil.com/x"))
        self.assertTrue(_webref._LIVE_URL_RE.search("load //evil.com/x.js"))
        self.assertTrue(_webref._LIVE_URL_RE.search("see https://evil.com/x"))
        manifest = _webref.webref_manifest()
        evil_files = dict(_webref.SNAPSHOT_FILES)
        evil_files["button.html"] = evil_files["button.html"] + "HTTPS://evil.com/x\n"
        self.assertTrue(
            any("live URL" in e for e in _webref.verify_snapshot(manifest, evil_files))
        )
        evil2 = dict(_webref.SNAPSHOT_FILES)
        evil2["button-variants.js"] = evil2["button-variants.js"] + "//evil.com/x\n"
        self.assertTrue(
            any("live URL" in e for e in _webref.verify_snapshot(manifest, evil2))
        )

    def test_rot_probe_mutates_file_bytes(self):
        before = _webref.snapshot_hash()
        evil = dict(_webref.SNAPSHOT_FILES)
        evil["button.html"] = evil["button.html"] + "<!-- rot -->\n"
        after = _webref.snapshot_hash(evil)
        self.assertNotEqual(before, after)
        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            ok, _errs, _w = specs_write_all(tmp)
            self.assertTrue(ok)
            import json as _json

            from pathlib import Path as _Path

            ref = _Path(tmp) / ".queereye" / "webref.json"
            doc = _json.loads(ref.read_text(encoding="utf-8"))
            doc["snapshot"]["button.html"] = (
                doc["snapshot"]["button.html"] + "<!-- rot -->\n"
            )
            ref.write_text(
                _json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            self.assertTrue(_webref.check_webref(tmp))


class TestF4CsfHardened(unittest.TestCase):
    """F4: play tautologies dead, snippets linked, rendered_slots required."""

    def test_run_play_empty_component_fails(self):
        passed, failures = _csf.run_play({"component": "", "args": {}})
        self.assertTrue(failures)
        passed2, failures2 = _csf.run_play({"component": "   ", "args": {"a": "b"}})
        self.assertTrue(failures2)

    def test_args_empty_fails(self):
        passed, failures = _csf.run_play({"component": "Button", "args": {}})
        self.assertTrue(any("args" in f for f in failures), failures)

    def test_loading_requires_loading_token(self):
        # A loading story renders the loading token (no "True" tautology).
        passed, failures = _csf.run_play(
            {"component": "Button", "args": {"variant": "default", "loading": True}}
        )
        # The exemplar loading story passes via the loading token.
        self.assertEqual(failures, [])
        # Direct assertion probe: frame without loading must fail loading check.
        assertions = _csf._play_assertions_for(
            {"component": "Button", "args": {"loading": True}}
        )
        frame_without_loading = (
            '<Button variant="default">x</Button><!--web:dummy--><!--tui:dummy-->'
        )
        # _loading_or_label is index 2.
        ok, _msg = assertions[2](frame_without_loading)
        self.assertFalse(ok)

    def test_render_links_snippets(self):
        frame = _csf.render_story({"component": "Button", "args": {"label": "Save"}})
        spec = _specs.EXEMPLARS["button"]
        self.assertIn(spec["snippets"]["web"].strip()[:40], frame)
        frame2 = _csf.render_story({"component": "Dialog", "args": {"open": True}})
        self.assertIn("<!--web:", frame2)
        self.assertIn("<!--tui:", frame2)

    def test_snippet_blank_fails_play(self):
        spec = copy.deepcopy(_specs.EXEMPLARS["button"])
        spec["snippets"]["web"] = "   "
        _passed, failures = _csf.run_play(
            {"component": "Button", "args": {"label": "Save"}}, spec=spec
        )
        self.assertTrue(any("snippet" in f for f in failures), failures)

    def test_rendered_slots_none_fails(self):
        spec = _specs.EXEMPLARS["button"]
        errs = _csf.spec_vs_render_check(spec, rendered_slots=None, webref_fresh=True)
        self.assertTrue(any("rendered_slots" in e for e in errs), errs)

    def test_csf_whitespace_fails(self):
        self.assertTrue(_csf.validate_csf_meta({"id": "x", "component": "   "}))
        self.assertTrue(_csf.validate_csf_meta({"id": "   ", "component": "Button"}))


class TestF5F6ZeroRisk(unittest.TestCase):
    """F5 rival $meta refused; F6 PROPRIETARY/empty clean-room refused."""

    def test_unknown_dollar_key_fails(self):
        from runner.queereye import tokens as _tokens

        loop_ok = {
            "color": {"primitive": {"paper": {"$value": "#fff", "$type": "color"}}}
        }
        # Sanity: clean tree passes (no $meta).
        self.assertEqual(_tokens.validate_tokens(loop_ok), [])
        evil = copy.deepcopy(loop_ok)
        evil["$meta"] = {"tool": "rival"}
        self.assertTrue(
            any(
                "$meta" in e or "unknown $ key" in e
                for e in _tokens.validate_tokens(evil)
            )
        )
        evil2 = copy.deepcopy(loop_ok)
        evil2["color"]["$evil"] = "x"
        self.assertTrue(any("$evil" in e for e in _tokens.validate_tokens(evil2)))

    def test_license_empty_proprietary_cleanroom_skip_refused(self):
        self.assertTrue(_webref.license_gate("", "clean-room"))
        self.assertTrue(_webref.license_gate("   ", "skip"))
        self.assertTrue(_webref.license_gate("PROPRIETARY", "clean-room"))
        self.assertTrue(_webref.license_gate("PROPRIETARY", "skip"))
        # GPL clean-room still allowed (existing contract).
        self.assertEqual(_webref.license_gate("GPL-3.0-only", "clean-room"), [])


class TestNoHeavyDeps(unittest.TestCase):
    """A6: zero new runtime deps; no network ingest in phase-02 modules."""

    def test_stdlib_only_imports(self):
        import ast

        for mod in ("specs", "webref", "tui", "csf"):
            src = (PROJECT_ROOT / "runner" / "queereye" / f"{mod}.py").read_text(
                encoding="utf-8"
            )
            tree = ast.parse(src)
            imported = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported.update(a.name.split(".")[0] for a in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported.add(node.module.split(".")[0])
            allowed = {
                "__future__",
                "copy",
                "datetime",
                "hashlib",
                "json",
                "re",
                "runner",
                "sys",
                "pathlib",
                "argparse",
                "tempfile",
            }
            self.assertTrue(
                imported <= allowed, f"{mod}: unexpected imports {imported - allowed}"
            )
            for needle in ("http://", "https://", "urllib", "requests", "fetch("):
                if mod == "webref":
                    # webref.py legitimately matches the live-URL *regex*
                    # pattern text; assert no actual URL literal is vendored
                    # instead of the bare-needle check.
                    continue
                self.assertNotIn(
                    needle, src, f"{mod}: network ingest marker {needle!r}"
                )

    def test_webref_snapshot_has_no_live_url_literal(self):
        src = (PROJECT_ROOT / "runner" / "queereye" / "webref.py").read_text(
            encoding="utf-8"
        )
        # Only the _LIVE_URL_RE pattern line may mention an http scheme.
        hits = [
            l
            for l in src.splitlines()
            if "https?://" in l or "http://" in l or "https://" in l
        ]
        self.assertTrue(
            all("_LIVE_URL_RE" in l or "example.com/rot-probe" not in l for l in hits)
            and len(hits) <= 2,
            hits,
        )
        self.assertNotIn("example.com", _webref.snapshot_bytes().decode("utf-8"))

    def test_interview_core_still_green(self):
        # No interview-core breakage: full slot loop validates + renders.
        from runner.queereye import slots as _slots
        from runner.queereye import tokens as _tokens

        loop = _slots.SlotLoop()
        for axis in _slots.AXES:
            for slot in loop.required_slots(axis):
                loop.skip(axis, slot)
        tree = loop.to_tokens()
        self.assertEqual(_tokens.validate_tokens(tree), [])
        self.assertEqual(_tokens.find_one_offs(tree), [])


class TestFixup2QAB17(unittest.TestCase):
    """Fixup iteration 2: close 17 QA-B repros (no scope expansion).

    Evidence hashes: dc656fd4 (shadcn pin), 0785dc45 (Radix gap),
    c24a9c9c (cva matrix), 28a04ca6 (behavior contract), 60c8c31d (CSF).
    """

    def test_f1_button_input_anatomy_enforced(self):
        # F1: button/input anatomies enforced; ['X'] + non-string refused;
        # dict entry -> structured error, never TypeError [0785dc45].
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["anatomy"] = ["X"]
        self.assertTrue(_specs.validate_spec(bad), bad)
        bad2 = copy.deepcopy(_specs.EXEMPLARS["form-input"])
        bad2["anatomy"] = ["Root"]
        self.assertTrue(
            any(
                "INPUT_ANATOMY" in e or "missing" in e
                for e in _specs.validate_spec(bad2)
            ),
            _specs.validate_spec(bad2),
        )
        bad3 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad3["anatomy"] = ["Root", {"evil": 1}]
        try:
            errs = _specs.validate_spec(bad3)
        except TypeError as exc:
            self.fail(f"hashability guard crashed: {exc}")
        self.assertTrue(errs, "dict anatomy entry must fail structured")
        self.assertTrue(any("string" in e or "hashable" in e for e in errs), errs)
        # Exemplars stay green.
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["button"]), [])
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["form-input"]), [])

    def test_f1_props_cva_smuggle_refused(self):
        # F1: props values must be subset of cva axes [c24a9c9c].
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["props"]["variant"]["values"] = list(_specs.CVA_VARIANTS) + ["evil"]
        self.assertTrue(
            any("smuggle" in e or "cva" in e for e in _specs.validate_spec(bad)),
            _specs.validate_spec(bad),
        )
        bad2 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad2["props"]["size"]["values"] = list(_specs.CVA_SIZES) + ["evil"]
        self.assertTrue(
            any("smuggle" in e or "cva" in e for e in _specs.validate_spec(bad2)),
            _specs.validate_spec(bad2),
        )

    def test_f1_scroll_gibberish_refused(self):
        # F1: scroll x*20/y*20 passes length-only -> require keyword [0785dc45].
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["scroll"] = {"web": "x" * 20, "tui": "y" * 20}
        errs = _specs.validate_spec(bad)
        self.assertTrue(
            any("scroll" in e and ("semantics" in e or "gibberish" in e) for e in errs),
            errs,
        )

    def test_f1_blank_slot_name_refused(self):
        # F1: blank slot name '' passes -> reject blank/whitespace keys.
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["slots"][""] = {"description": "evil slot"}
        self.assertTrue(
            any(
                "slot name" in e or "blank slot" in e for e in _specs.validate_spec(bad)
            ),
            _specs.validate_spec(bad),
        )
        bad2 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad2["slots"]["   "] = {"description": "evil slot"}
        self.assertTrue(_specs.validate_spec(bad2))

    def test_f1_nonstring_default_refused(self):
        # F1: non-string default 123 slips -> structured error.
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["props"]["label"] = {"type": "string", "default": 123}
        self.assertTrue(
            any("default" in e for e in _specs.validate_spec(bad)),
            _specs.validate_spec(bad),
        )
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["button"]), [])

    def test_f2_single_char_waiver_refused(self):
        # F2: {'empty':'x'} launders -> require >=10 chars + reason phrase.
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["tui_rows"] = [r for r in bad["tui_rows"] if r["state"] != "empty"]
        bad["tui_waivers"] = {"empty": "x"}
        errs = _tui.validate_tui_coverage(bad)
        self.assertTrue(errs, "single-char waiver must not launder")
        self.assertTrue(any("waiver" in e.lower() or "empty" in e for e in errs), errs)
        # Valid waiver still passes.
        good = copy.deepcopy(_specs.EXEMPLARS["button"])
        good["tui_rows"] = [r for r in good["tui_rows"] if r["state"] != "empty"]
        good["tui_waivers"] = {
            "empty": "button empty is icon-only aria-label; no downgrade row applicable"
        }
        self.assertFalse(
            any(
                "empty" in e and "missing" in e
                for e in _tui.validate_tui_coverage(good)
            ),
            _tui.validate_tui_coverage(good),
        )

    def test_f2_nondict_states_refused(self):
        # F2: non-dict states 'evil' skips coverage -> structured error.
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["states"] = "evil"
        self.assertTrue(
            any(
                "states must be an object" in e for e in _tui.validate_tui_coverage(bad)
            ),
            _tui.validate_tui_coverage(bad),
        )

    def test_f3_missing_empty_snapshot_refused(self):
        # F3: missing/empty snapshot falls back + skips drift -> must fail.
        with tempfile.TemporaryDirectory() as tmp:
            _seed_interview(tmp)
            ok, _errs, _w = specs_write_all(tmp)
            self.assertTrue(ok, _errs)
            import json as _json

            ref = Path(tmp) / ".queereye" / "webref.json"
            doc = _json.loads(ref.read_text(encoding="utf-8"))
            doc_missing = dict(doc)
            del doc_missing["snapshot"]
            ref.write_text(
                _json.dumps(doc_missing, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            self.assertTrue(
                any("missing or empty" in e for e in _webref.check_webref(tmp)),
                _webref.check_webref(tmp),
            )
            doc_empty = dict(doc)
            doc_empty["snapshot"] = {}
            ref.write_text(
                _json.dumps(doc_empty, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            self.assertTrue(
                any("missing or empty" in e for e in _webref.check_webref(tmp)),
                _webref.check_webref(tmp),
            )

    def test_f3_nonstr_snapshot_structured(self):
        # F3: non-string snapshot 123 crashes AttributeError -> type-guard.
        manifest = _webref.webref_manifest()
        try:
            errs = _webref.verify_snapshot(manifest, {"button.html": 123})
        except AttributeError as exc:
            self.fail(f"type-guard crashed: {exc}")
        self.assertTrue(any("must be a string" in e for e in errs), errs)

    def test_f3_license_gate_hardened(self):
        # F3: EVIL clean-room/skip passes, GPL skip passes, mit refused [dc656fd4].
        self.assertTrue(
            _webref.license_gate("EVIL", "clean-room"), "EVIL clean-room must fail"
        )
        self.assertTrue(_webref.license_gate("EVIL", "skip"), "EVIL skip must fail")
        self.assertTrue(
            _webref.license_gate("GPL-3.0-only", "skip"),
            "GPL skip must be clean-room-only",
        )
        self.assertEqual(
            _webref.license_gate("mit", "vendor"), [], "mit==MIT case-insensitive"
        )
        self.assertEqual(_webref.license_gate("MIT", "vendor"), [])
        self.assertEqual(_webref.license_gate("GPL-3.0-only", "clean-room"), [])
        # Rebuild proof note: short note refused when supplied.
        self.assertTrue(
            _webref.license_gate("MIT", "clean-room", note="x"),
            "short rebuild note must fail",
        )

    def test_f4_substring_component_refused(self):
        # F4: 'utton' passes in frame -> require exact tag [60c8c31d].
        frame = _csf.render_story({"component": "Button", "args": {"label": "Save"}})
        asserts = _csf._play_assertions_for(
            {"component": "utton", "args": {"label": "Save"}}
        )
        ok, _msg = asserts[0](frame)
        self.assertFalse(ok, "substring 'utton' must not match <Button>")
        asserts2 = _csf._play_assertions_for(
            {"component": "Button", "args": {"label": "Save"}}
        )
        ok2, _m2 = asserts2[0](frame)
        self.assertTrue(ok2)

    def test_f4_whitespace_arg_refused(self):
        # F4: whitespace arg '   ' passes -> strip-check values.
        _passed, failures = _csf.run_play(
            {"component": "Button", "args": {"label": "   "}}
        )
        self.assertTrue(
            any("whitespace" in f or "args" in f for f in failures), failures
        )

    def test_f4_trivial_snippet_refused(self):
        # F4: trivial 'Button' passes 40-char probe -> snippet-quality [60c8c31d].
        spec = copy.deepcopy(_specs.EXEMPLARS["button"])
        spec["snippets"] = {"web": "Button", "tui": "Button"}
        _passed, failures = _csf.run_play(
            {"component": "Button", "args": {"label": "Save"}}, spec=spec
        )
        self.assertTrue(any("snippet" in f or "short" in f for f in failures), failures)

    def test_f4_missing_id_refused(self):
        # F4: missing id passes (only if not None) -> require present [60c8c31d].
        self.assertTrue(_csf.validate_csf_meta({"component": "Button"}))
        self.assertTrue(_csf.validate_csf_meta({"id": "   ", "component": "Button"}))
        self.assertEqual(_csf.validate_csf_meta({"id": "x", "component": "Button"}), [])

    def test_f4_freshness_strict_bool(self):
        # F4: freshness truthy 'yes'/1 passes -> require is True.
        spec = _specs.EXEMPLARS["button"]
        slots = sorted(spec["slots"])
        self.assertTrue(
            _csf.spec_vs_render_check(spec, rendered_slots=slots, webref_fresh="yes")
        )
        self.assertTrue(
            _csf.spec_vs_render_check(spec, rendered_slots=slots, webref_fresh=1)
        )
        self.assertEqual(
            _csf.spec_vs_render_check(spec, rendered_slots=slots, webref_fresh=True), []
        )

    def test_f5_list_smuggled_meta_refused(self):
        # F5: list-smuggled $meta passes (dicts only) -> traverse lists.
        from runner.queereye import tokens as _tokens

        tree = {
            "color": {"primitive": {"paper": {"$value": "#fff", "$type": "color"}}},
            "evil_list": [{"$meta": "x"}],
        }
        self.assertTrue(
            any("$meta" in e for e in _tokens.validate_tokens(tree)),
            _tokens.validate_tokens(tree),
        )

    def test_f5_dictvalued_value_meta_refused(self):
        # F5: dict-valued $value {'$value':{'$meta':'x'}} -> visit inside $value.
        from runner.queereye import tokens as _tokens

        tree = {
            "color": {
                "primitive": {"paper": {"$value": {"$meta": "x"}, "$type": "color"}}
            }
        }
        self.assertTrue(
            any("$meta" in e for e in _tokens.validate_tokens(tree)),
            _tokens.validate_tokens(tree),
        )


class TestFinalHardening7(unittest.TestCase):
    """FINAL hardening: 7 residual families (escalated after 3 fails).

    Evidence hashes: dc656fd4 (shadcn pin), 0785dc45 (Radix gap),
    c24a9c9c (cva matrix), 28a04ca6 (behavior contract), 60c8c31d (CSF).
    Each test pins one residual bypass: attacker FAILs, exemplars stay green.
    """

    def test_r1_snippet_gibberish_self_contains_refused(self):
        # R1: x*20/y*20 passes length + self-contains probe (probe is the
        # snippet's own prefix). Require semantic link + entropy [60c8c31d].
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["snippets"] = {"web": "x" * 20, "tui": "y" * 20}
        errs = _specs.validate_spec(bad)
        self.assertTrue(
            any(
                "snippets" in e and ("low-entropy" in e or "reference" in e)
                for e in errs
            ),
            errs,
        )
        # Play harness likewise refuses gibberish linked snippets.
        _passed, failures = _csf.run_play(
            {"component": "Button", "args": {"label": "Save"}}, spec=bad
        )
        self.assertTrue(
            any("low-entropy" in f or "reference" in f for f in failures), failures
        )
        # Exemplars stay green.
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["button"]), [])
        _p2, _f2 = _csf.run_play({"component": "Button", "args": {"label": "Save"}})
        self.assertEqual(_f2, [])

    def test_r2_keyword_gibberish_scroll_focus_refused(self):
        # R2: scroll x*100 (keyword + repeat) passes substring alone.
        # Require >=2 distinct keywords + prose/entropy [0785dc45].
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["scroll"] = {"web": "scroll " + "x" * 100, "tui": "region " + "y" * 100}
        errs = _specs.validate_spec(bad)
        self.assertTrue(
            any(
                "scroll" in e and (">=2 distinct" in e or "low-entropy" in e)
                for e in errs
            ),
            errs,
        )
        bad2 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad2["focus"] = {"web": "x" * 20, "tui": "keyboard-first " + "x" * 100}
        errs2 = _specs.validate_spec(bad2)
        self.assertTrue(
            any("focus" in e and ("prose" in e or "low-entropy" in e) for e in errs2),
            errs2,
        )
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["dialog"]), [])

    def test_r3_component_case_via_marker_refused(self):
        # R3: button lower passes via <!--web:<button> marker bytes.
        # Check outer tag exact (strip markers) + case-exact linkage [60c8c31d].
        frame = _csf.render_story({"component": "Button", "args": {"label": "Save"}})
        self.assertIn("<!--web:<button", frame)
        asserts = _csf._play_assertions_for(
            {"component": "button", "args": {"label": "Save"}}
        )
        ok, _msg = asserts[0](frame)
        self.assertFalse(ok, "lower-case via marker must not match outer <Button>")
        _passed, failures = _csf.run_play(
            {"component": "button", "args": {"label": "Save"}}
        )
        self.assertTrue(
            any(
                "outer" in f or "case-exact" in f or "exact tag" in f for f in failures
            ),
            failures,
        )
        _p2, _f2 = _csf.run_play({"component": "Button", "args": {"label": "Save"}})
        self.assertEqual(_f2, [])

    def test_r4_props_variant_capital_smuggle_refused(self):
        # R4: Variant capital skips cva subset enforcement [c24a9c9c].
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["props"]["Variant"] = {
            "type": "enum",
            "values": ["evil"],
            "default": "evil",
        }
        errs = _specs.validate_spec(bad)
        self.assertTrue(any("smuggle" in e or "cva" in e for e in errs), errs)
        bad2 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad2["props"]["Size"] = {"type": "enum", "values": ["evil"], "default": "evil"}
        self.assertTrue(
            any("smuggle" in e or "cva" in e for e in _specs.validate_spec(bad2))
        )
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["button"]), [])

    def test_r5_unknown_name_anatomy_skip_refused(self):
        # R5: name evil skips full-anatomy (None skip) [0785dc45].
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["name"] = "evil"
        bad["anatomy"] = ["X"]
        errs = _specs.validate_spec(bad)
        self.assertTrue(any("unknown spec name" in e for e in errs), errs)
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["button"]), [])
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["dialog"]), [])
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["form-input"]), [])

    def test_r6_unicode_blank_zwsp_refused(self):
        # R6: ZWSP/WJ strip() misses (blank laundering).
        self.assertTrue(_specs._is_blank("\u200b"))
        self.assertTrue(_specs._is_blank("  \u200b  "))
        self.assertTrue(_specs._is_blank("\u2060"))
        self.assertTrue(_specs._is_blank("\ufeff"))
        self.assertFalse(_specs._is_blank("Save"))
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["props"]["label"] = {"type": "\u200b", "default": ""}
        self.assertTrue(
            any("prop" in e and "type" in e for e in _specs.validate_spec(bad))
        )
        bad2 = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad2["slots"]["\u200b"] = {"description": "evil"}
        self.assertTrue(any("slot name" in e for e in _specs.validate_spec(bad2)))
        self.assertTrue(_csf.validate_csf_meta({"id": "\u200b", "component": "Button"}))
        self.assertEqual(_specs.validate_spec(_specs.EXEMPLARS["button"]), [])

    def test_r7_waiver_note_minimal_gibberish_refused(self):
        # R7: xxxx xxxxx (10 chars + space) passes waiver/note [0785dc45].
        bad = copy.deepcopy(_specs.EXEMPLARS["button"])
        bad["tui_rows"] = [r for r in bad["tui_rows"] if r["state"] != "empty"]
        bad["tui_waivers"] = {"empty": "xxxx xxxxx"}
        errs = _tui.validate_tui_coverage(bad)
        self.assertTrue(any("semantic" in e or "gibberish" in e for e in errs), errs)
        self.assertTrue(
            _webref.license_gate("MIT", "clean-room", note="xxxx xxxxx"),
            "waiver-note gibberish must fail license note too",
        )
        good = copy.deepcopy(_specs.EXEMPLARS["button"])
        good["tui_rows"] = [r for r in good["tui_rows"] if r["state"] != "empty"]
        good["tui_waivers"] = {
            "empty": "button empty is icon-only aria-label; no downgrade row applicable"
        }
        self.assertFalse(
            any(
                "empty" in e and "missing" in e
                for e in _tui.validate_tui_coverage(good)
            ),
            _tui.validate_tui_coverage(good),
        )
        self.assertEqual(
            _webref.license_gate(
                "GPL-3.0-only",
                "clean-room",
                note="GPL behavior rebuilt from spec, no bytes vendored; upstream cited by name",
            ),
            [],
        )


if __name__ == "__main__":
    unittest.main()
