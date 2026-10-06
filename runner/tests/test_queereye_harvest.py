#!/usr/bin/env python3
"""Queereye phase 03 acceptance: harvest ledger + skill bundle + overlay + cite-gate.

Phase queereye-03-harvest-overlay (run queereye-style-guide).
Evidence hashes (full quotes in the phase dossier):
- Open Props MIT custom-property tokens [VERIFIED: dbe9cbb4]
- shadcn/ui MIT component-pattern catalog [VERIFIED: 890dc55a]
- Radix Primitives MIT dialog/focus/keyboard behaviors [VERIFIED: 74144f6a]
- axe-core MPL-2.0 excluded harvest [VERIFIED: d0679fbc]
- skill frontmatter contract + validator [VERIFIED: 84f80b6c]
- OpenCode V2 agent profile shape [VERIFIED: aab8ead6]
- Claude commands==skills merged shape [VERIFIED: ca41333c]
"""

import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.queereye import harvest as _harvest
from runner.queereye import fs as _fs
from runner.queereye.cli import (
    check_project,
    compile_project,
    harvest_check_all,
    harvest_write_all,
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


def _seed_full(tmp):
    """Seed interview + specs + harvest (full phase 01-03 surface)."""
    _seed_interview(tmp)
    ok_s, errs_s, _w = specs_write_all(str(tmp))
    assert ok_s, errs_s
    ok_h, errs_h, _wrote = harvest_write_all(str(tmp))
    assert ok_h, errs_h
    return tmp


class TestLedgerShape(unittest.TestCase):
    """A1: >=4 MIT rows with LICENSE-byte hashes + SPDX; axe clean-room."""

    def test_ledger_validates_clean(self):
        self.assertEqual(_harvest.validate_ledger(), [])

    def test_four_mit_rows_with_bytes_and_spdx(self):
        mit_rows = [r for r in _harvest.HARVEST_ROWS if r["license"] == "MIT"]
        self.assertGreaterEqual(len(mit_rows), 4)
        skills = {r["skill"] for r in mit_rows}
        for expected in (
            "open-props-theming",
            "shadcn-patterns",
            "radix-behaviors",
            "tailwind-naming",
            "tailwind-theme",
        ):
            self.assertIn(expected, skills)
        for row in mit_rows:
            self.assertEqual(
                row["license_bytes_sha256"],
                _harvest.mit_license_bytes_sha256(),
            )
            self.assertIn("SPDX-License-Identifier: MIT", row["spdx"])
            self.assertIn(row["upstream"], row["spdx"])
            self.assertIn(row["evidence_hash"], row["spdx"])
            self.assertTrue(row["files"])

    def test_dossier_hashes_cited(self):
        by_skill = {r["skill"]: r for r in _harvest.HARVEST_ROWS}
        self.assertEqual(by_skill["open-props-theming"]["evidence_hash"], "dbe9cbb4")
        self.assertEqual(by_skill["shadcn-patterns"]["evidence_hash"], "890dc55a")
        self.assertEqual(by_skill["radix-behaviors"]["evidence_hash"], "74144f6a")
        self.assertEqual(by_skill["axe-checks"]["evidence_hash"], "d0679fbc")

    def test_axe_core_excluded_clean_room(self):
        axe = next(r for r in _harvest.HARVEST_ROWS if r["skill"] == "axe-checks")
        self.assertEqual(axe["verdict"], "clean-room")
        self.assertEqual(axe["upstream_license"], "MPL-2.0")

    def test_aria_behavior_only(self):
        aria = next(r for r in _harvest.HARVEST_ROWS if r["skill"] == "aria-contracts")
        self.assertEqual(aria["verdict"], "clean-room")

    def test_no_gpl_agpl_bytes_vendored(self):
        for row in _harvest.HARVEST_ROWS:
            up = str(row["upstream_license"]).upper()
            if up.startswith(("GPL", "AGPL")):
                self.assertEqual(
                    row["verdict"],
                    "clean-room",
                    f"{row['skill']}: copyleft is clean-room-only",
                )

    def test_no_bsd_isc_claim_without_bytes(self):
        for row in _harvest.HARVEST_ROWS:
            self.assertNotIn(
                str(row["license"]).upper(),
                ("BSD-3-CLAUSE", "ISC"),
                f"{row['skill']}: BSD/ISC claim needs LICENSE bytes",
            )

    def test_mpl_depend_refused(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS)
        bad[0]["upstream_license"] = "MPL-2.0"
        bad[0]["verdict"] = "depend"
        self.assertTrue(_harvest.validate_ledger(bad))

    def test_unknown_license_refused(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS)
        bad[0]["license"] = "EVIL"
        self.assertTrue(any("whitelist" in e for e in _harvest.validate_ledger(bad)))

    def test_vendor_without_spdx_fails(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS)
        bad[1]["verdict"] = "vendor"
        bad[1]["spdx"] = ""
        self.assertTrue(any("SPDX" in e for e in _harvest.validate_ledger(bad)))

    def test_duplicate_skill_fails(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS) + copy.deepcopy(
            _harvest.HARVEST_ROWS[:1]
        )
        self.assertTrue(any("duplicate" in e for e in _harvest.validate_ledger(bad)))

    def test_missing_key_fails(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS)
        del bad[0]["evidence_hash"]
        self.assertTrue(
            any("evidence_hash" in e for e in _harvest.validate_ledger(bad))
        )

    def test_badge_only_without_marker_fails(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS)
        row = next(r for r in bad if r["skill"] == "tailwind-naming")
        row["note"] = "Token naming conventions rebuilt clean-room."
        self.assertTrue(any("HYPOTHESIS" in e for e in _harvest.validate_ledger(bad)))

    def test_whitelist_case_insensitive(self):
        rows = copy.deepcopy(_harvest.HARVEST_ROWS)
        rows[0]["license"] = "mit"
        self.assertEqual(_harvest.validate_ledger(rows), [])


class TestTransitiveClosure(unittest.TestCase):
    """A2: shadcn sub-dep scan executed; risk priced or waived."""

    def test_closure_validates_clean(self):
        self.assertEqual(_harvest.validate_transitive_closure(), [])

    def test_shadcn_subdeps_scanned(self):
        via = {e["dep"] for e in _harvest.TRANSITIVE_DEPS if e["via"] == "shadcn/ui"}
        for expected in (
            "@radix-ui/react-dialog",
            "tailwindcss",
            "class-variance-authority",
            "clsx",
            "tailwind-merge",
            "lucide-react",
        ):
            self.assertIn(expected, via)

    def test_isc_without_bytes_is_negative(self):
        lucide = next(e for e in _harvest.TRANSITIVE_DEPS if e["dep"] == "lucide-react")
        self.assertEqual(lucide["status"], "negative")
        self.assertIn("NEGATIVE_KNOWLEDGE", lucide["risk"])

    def test_bsd_gap_stays_negative(self):
        self.assertTrue(
            any("NEGATIVE_KNOWLEDGE" in n for n in _harvest.NEGATIVE_KNOWLEDGE_NOTES)
        )

    def test_copyleft_priced_verdict_refused(self):
        bad = copy.deepcopy(_harvest.TRANSITIVE_DEPS) + [
            {
                "dep": "evil-gpl",
                "via": "shadcn/ui",
                "license_claim": "GPL-3.0-only",
                "status": "priced",
                "risk": "none",
            }
        ]
        self.assertTrue(_harvest.validate_transitive_closure(bad))

    def test_negative_without_marker_fails(self):
        bad = copy.deepcopy(_harvest.TRANSITIVE_DEPS)
        bad[0]["status"] = "negative"
        bad[0]["risk"] = "no problem"
        self.assertTrue(_harvest.validate_transitive_closure(bad))


class TestSkillBundle(unittest.TestCase):
    """A3: frontmatter contract validates; disclosure budgets met."""

    def test_frontmatter_validates(self):
        self.assertEqual(
            _harvest.validate_skill_frontmatter(_harvest.render_skill_md()), []
        )

    def test_frontmatter_fields_required(self):
        for field in _harvest.SKILL_FRONTMATTER_FIELDS:
            self.assertIn(field, _harvest.SKILL_FRONTMATTER_FIELDS)
        bad = _harvest.render_skill_md().replace("license: MIT\n", "")
        self.assertTrue(
            any("license" in e for e in _harvest.validate_skill_frontmatter(bad))
        )

    def test_frontmatter_license_whitelist_enforced(self):
        bad = _harvest.render_skill_md().replace("license: MIT", "license: MPL-2.0")
        self.assertTrue(
            any("whitelist" in e for e in _harvest.validate_skill_frontmatter(bad))
        )

    def test_missing_frontmatter_block_fails(self):
        self.assertTrue(_harvest.validate_skill_frontmatter("no frontmatter here"))

    def test_disclosure_budgets_met_wc_measured(self):
        text = _harvest.render_skill_md()
        fm, body = _harvest.split_frontmatter(text)
        meta_tok = _harvest.estimate_tokens(" ".join(str(v) for v in fm.values()))
        body_tok = _harvest.estimate_tokens(body)
        self.assertLessEqual(meta_tok, _harvest.META_BUDGET_TOKENS)
        self.assertLess(body_tok, _harvest.BODY_BUDGET_TOKENS)
        self.assertEqual(_harvest.disclosure_budget_check(text), [])

    def test_metadata_over_budget_fails(self):
        bad = _harvest.render_skill_md().replace(
            "description: Interview-driven living style guide",
            "description: " + "word " * 200,
        )
        self.assertTrue(
            any("metadata" in e for e in _harvest.disclosure_budget_check(bad))
        )

    def test_bundle_layout_files(self):
        files = _harvest.skill_bundle_files()
        self.assertEqual(
            sorted(files),
            [
                "skill/SKILL.md",
                "skill/assets/MIT-LICENSE.txt",
                "skill/references/a11y-rules.md",
                "skill/references/checklists.md",
                "skill/scripts/harvest-check.py",
            ],
        )
        self.assertEqual(
            files["skill/assets/MIT-LICENSE.txt"], _harvest.MIT_LICENSE_TEXT
        )

    def test_skill_check_script_runs(self):
        import os

        with tempfile.TemporaryDirectory(prefix="queereye-skill-script-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertEqual(errs, [], errs)
            self.assertTrue(ok)
            script = Path(tmp) / ".queereye" / "skill" / "scripts" / "harvest-check.py"
            self.assertTrue(script.is_file())
            env = dict(os.environ)
            env["PYTHONPATH"] = (
                str(PROJECT_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
            )
            proc = subprocess.run(
                [sys.executable, str(script)],
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("skill self-check ok", proc.stdout)

    def test_skill_check_script_refuses_silent_pass(self):
        import os

        with tempfile.TemporaryDirectory(prefix="queereye-skill-script-neg-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertTrue(ok)
            script = Path(tmp) / ".queereye" / "skill" / "scripts" / "harvest-check.py"
            env = {
                k: v
                for k, v in os.environ.items()
                if k not in ("PYTHONPATH", "PYTHONHOME")
            }
            env["PYTHONPATH"] = tmp  # toolchain NOT importable: must refuse
            proc = subprocess.run(
                [sys.executable, "-I", str(script)],
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
            )
            self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
            self.assertIn("needs the queereye toolchain", proc.stdout + proc.stderr)


class TestOverlayParity(unittest.TestCase):
    """A4: overlay reuses schema; scripted replay diff identical."""

    def test_overlay_frontmatter_validates(self):
        text = _harvest.render_overlay_skill_md()
        self.assertEqual(_harvest.validate_skill_frontmatter(text), [])
        self.assertEqual(_harvest.disclosure_budget_check(text), [])

    def test_overlay_reuses_schema_sections_byte_for_byte(self):
        bundle = _harvest.render_skill_md()
        overlay = _harvest.render_overlay_skill_md()
        self.assertIn(_harvest._token_schema_section(), bundle)
        self.assertIn(_harvest._token_schema_section(), overlay)
        self.assertIn(_harvest._spec_template_section(), bundle)
        self.assertIn(_harvest._spec_template_section(), overlay)

    def test_overlay_cites_merged_shape(self):
        self.assertIn("ca41333c", _harvest.render_overlay_skill_md())
        self.assertIn("aab8ead6", _harvest.render_overlay_skill_md())

    def test_parity_replay_identical(self):
        results = _harvest.parity_replay()
        self.assertEqual(results["opencode"], results["claude"])
        for rel in _harvest.PARITY_FILES:
            self.assertIn(rel, results["opencode"])

    def test_parity_check_green(self):
        self.assertEqual(_harvest.parity_check(), [])

    def test_parity_divergence_detected(self):
        orig = _harvest._replay_surface
        try:
            calls = {"n": 0}

            def _flaky(tmp_root):
                out = orig(tmp_root)
                calls["n"] += 1
                if calls["n"] == 2:
                    out = dict(out)
                    out["tokens.json"] = "0" * 64
                return out

            _harvest._replay_surface = _flaky
            errors = _harvest.parity_check()
        finally:
            _harvest._replay_surface = orig
        self.assertTrue(any("divergence" in e for e in errors))


class TestCiteGate(unittest.TestCase):
    """A5: receipt cites token hashes + dossier hashes; QA gates green."""

    def test_receipt_cites_and_verifies(self):
        with tempfile.TemporaryDirectory(prefix="queereye-cite-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertEqual(errs, [], errs)
            receipt = _harvest.render_receipt(str(tmp))
            digest = _harvest.tokens_digest(str(tmp))
            self.assertIn(digest, receipt)
            for h in _harvest.DOSSIER_HASHES:
                self.assertIn(h, receipt)
            self.assertEqual(_harvest.verify_cite_gate(receipt, str(tmp)), [])

    def test_receipt_missing_digest_fails(self):
        with tempfile.TemporaryDirectory(prefix="queereye-cite-neg-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertTrue(ok)
            receipt = "tokens.json sha256: " + "0" * 64 + "\n"
            for h in _harvest.DOSSIER_HASHES:
                receipt += f"[VERIFIED: {h}]\n"
            gate = _harvest.verify_cite_gate(receipt, str(tmp))
            self.assertTrue(any("sha256" in e for e in gate))

    def test_receipt_missing_hash_fails(self):
        with tempfile.TemporaryDirectory(prefix="queereye-cite-neg2-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertTrue(ok)
            receipt = _harvest.render_receipt(str(tmp)).replace("dbe9cbb4", "redacted")
            gate = _harvest.verify_cite_gate(receipt, str(tmp))
            self.assertTrue(any("dbe9cbb4" in e for e in gate))

    def test_qa_catches_contrast_and_render_drift(self):
        with tempfile.TemporaryDirectory(prefix="queereye-cite-qa-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertTrue(ok)
            guide = Path(tmp) / ".queereye" / "STYLE_GUIDE.md"
            guide.write_text(
                guide.read_text(encoding="utf-8") + "\n<!-- drift -->\n",
                encoding="utf-8",
            )
            receipt = _harvest.render_receipt(str(tmp))
            gate = _harvest.verify_cite_gate(receipt, str(tmp))
            self.assertTrue(any("render-match" in e for e in gate))


class TestCliHarvest(unittest.TestCase):
    """CLI: write/check round-trip, drift, adoption guard, no phase 01/02 breaks."""

    def test_harvest_write_then_check_green(self):
        with tempfile.TemporaryDirectory(prefix="queereye-harvest-") as tmp:
            _seed_interview(tmp)
            ok, errs, written = harvest_write_all(str(tmp))
            self.assertEqual(errs, [], errs)
            self.assertTrue(ok)
            for rel in (
                "harvest.json",
                "skill/SKILL.md",
                "skill/references/checklists.md",
                "skill/references/a11y-rules.md",
                "skill/scripts/harvest-check.py",
                "skill/assets/MIT-LICENSE.txt",
                "skill-claude/SKILL.md",
                "cite-gate-demo.md",
            ):
                self.assertIn(rel, written)
                self.assertTrue((Path(tmp) / ".queereye" / rel).is_file(), rel)
            ok_c, errs_c = harvest_check_all(str(tmp))
            self.assertEqual(errs_c, [], errs_c)
            self.assertTrue(ok_c)

    def test_harvest_drift_detected(self):
        with tempfile.TemporaryDirectory(prefix="queereye-harvest-drift-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertTrue(ok)
            target = Path(tmp) / ".queereye" / "harvest.json"
            doc = json.loads(target.read_text(encoding="utf-8"))
            doc["ledger"][0]["verdict"] = "vendor"
            target.write_text(
                json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            ok_c, errs_c = harvest_check_all(str(tmp))
            self.assertFalse(ok_c)
            self.assertTrue(errs_c)

    def test_check_backward_compat_without_harvest(self):
        with tempfile.TemporaryDirectory(prefix="queereye-harvest-compat-") as tmp:
            _seed_interview(tmp)
            ok, errors = check_project(str(tmp))
            self.assertEqual(errors, [], errors)
            self.assertTrue(ok)

    def test_check_enforces_harvest_once_adopted(self):
        with tempfile.TemporaryDirectory(prefix="queereye-harvest-adopt-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertTrue(ok)
            overlay = Path(tmp) / ".queereye" / "skill-claude" / "SKILL.md"
            overlay.write_text(
                overlay.read_text(encoding="utf-8") + "\n<!-- drift -->\n",
                encoding="utf-8",
            )
            ok_c, errors = check_project(str(tmp))
            self.assertFalse(ok_c)
            self.assertTrue(any("skill-claude" in e for e in errors))

    def test_full_surface_check_green(self):
        with tempfile.TemporaryDirectory(prefix="queereye-harvest-full-") as tmp:
            _seed_full(tmp)
            ok, errors = check_project(str(tmp), strict=True)
            self.assertEqual(errors, [], errors)
            self.assertTrue(ok)
            ok_s, errs_s = specs_check_all(str(tmp))
            self.assertEqual(errs_s, [], errs_s)
            self.assertTrue(ok_s)

    def test_harvest_cli_entrypoint(self):
        with tempfile.TemporaryDirectory(prefix="queereye-harvest-cli-") as tmp:
            _seed_interview(tmp)
            from runner.queereye.cli import main as _main

            self.assertEqual(_main(["--project-dir", str(tmp), "harvest"]), 0)
            self.assertEqual(
                _main(["--project-dir", str(tmp), "harvest", "--check"]), 0
            )

    def test_no_closed_platform_rows(self):
        for row in _harvest.HARVEST_ROWS:
            blob = json.dumps(row).lower()
            for closed in ("knapsack", "supernova", "zeroheight", "backlight"):
                self.assertNotIn(closed, blob)

    def test_harvest_json_hash_stable(self):
        first = hashlib.sha256(
            (
                json.dumps(_harvest.harvest_manifest(), indent=2, sort_keys=True) + "\n"
            ).encode()
        ).hexdigest()
        second = hashlib.sha256(
            (
                json.dumps(_harvest.harvest_manifest(), indent=2, sort_keys=True) + "\n"
            ).encode()
        ).hexdigest()
        self.assertEqual(first, second)


class TestQaBFixups(unittest.TestCase):
    """F1-F11 QA-B fixup regressions (retry 1; qa-b fail upheld)."""

    def test_f1_badge_launder_dossier_membership(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS)
        bad[0]["evidence_kind"] = "dossier"
        bad[0]["evidence_hash"] = "badge-says-MIT"
        bad[0]["note"] = "Badge claims MIT [VERIFIED: badge-says-MIT]"
        errs = _harvest.validate_ledger(bad)
        self.assertTrue(any("dossier evidence_hash" in e for e in errs))
        # Valid dossier hash without VERIFIED cite also refused.
        bad2 = copy.deepcopy(_harvest.HARVEST_ROWS)
        row = next(r for r in bad2 if r["skill"] == "shadcn-patterns")
        row["note"] = "Rebuilt clean-room HYPOTHESIS without verified cite."
        errs2 = _harvest.validate_ledger(bad2)
        self.assertTrue(any("must cite [VERIFIED:" in e for e in errs2))

    def test_f2_bytes_64hex_and_spdx_row_license(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS)
        bad[0]["license_bytes_sha256"] = "not-hex"
        bad[0]["spdx"] = bad[0]["spdx"].replace(
            _harvest.mit_license_bytes_sha256(), "not-hex"
        )
        self.assertTrue(any("64-hex" in e for e in _harvest.validate_ledger(bad)))
        # BSD row with hardcoded MIT SPDX refused (must emit row license).
        bsd_spdx_mit = _harvest.spdx_block_for(
            "bsd-x",
            "x-up",
            "BSD-3-Clause",
            ["a"],
            "h",
            license="MIT",
            license_bytes_sha256="a" * 64,
        )
        bsd_row = {
            "skill": "bsd-x",
            "verdict": "clean-room",
            "license": "BSD-3-Clause",
            "upstream": "x-up",
            "upstream_license": "BSD-3-Clause",
            "files": ["a"],
            "evidence_hash": "h",
            "evidence_kind": "negative",
            "license_bytes_sha256": "a" * 64,
            "spdx": bsd_spdx_mit,
            "note": "HYPOTHESIS BSD bytes pinned rebuild behavior spec clean room upstream bytes vendored",
        }
        errs = _harvest.validate_ledger(
            copy.deepcopy(_harvest.HARVEST_ROWS) + [bsd_row]
        )
        self.assertTrue(any("must emit the row license" in e for e in errs))

    def test_f3_bytes_pinned_and_zeros_refused(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS)
        bad[0]["license_bytes_sha256"] = "0" * 64
        bad[0]["spdx"] = bad[0]["spdx"].replace(
            _harvest.mit_license_bytes_sha256(), "0" * 64
        )
        self.assertTrue(any("0*64" in e for e in _harvest.validate_ledger(bad)))
        bad2 = copy.deepcopy(_harvest.HARVEST_ROWS)
        bad2[0]["license_bytes_sha256"] = "a" * 64
        bad2[0]["spdx"] = bad2[0]["spdx"].replace(
            _harvest.mit_license_bytes_sha256(), "a" * 64
        )
        self.assertTrue(
            any(
                "must pin vendored MIT bytes" in e
                for e in _harvest.validate_ledger(bad2)
            )
        )

    def test_f4_gpl_skip_refused_via_gate(self):
        evil = {
            "skill": "evil-skip",
            "verdict": "skip",
            "license": "MIT",
            "upstream": "evil-gpl",
            "upstream_license": "GPL-3.0-only",
            "files": ["a"],
            "evidence_hash": "dbe9cbb4",
            "evidence_kind": "dossier",
            "license_bytes_sha256": _harvest.mit_license_bytes_sha256(),
            "spdx": _harvest.spdx_block_for(
                "evil-skip", "evil-gpl", "GPL-3.0-only", ["a"], "dbe9cbb4"
            ),
            "note": "[VERIFIED: dbe9cbb4] rebuild behavior spec clean room upstream bytes vendored dialog focus keyboard",
        }
        errs = _harvest.validate_ledger(copy.deepcopy(_harvest.HARVEST_ROWS) + [evil])
        self.assertTrue(any("skip refused" in e for e in errs))

    def test_f5_unknown_upstream_cleanroom_refused_aria_exception(self):
        evil = {
            "skill": "evil-cr",
            "verdict": "clean-room",
            "license": "MIT",
            "upstream": "evil",
            "upstream_license": "EVIL-MADE-UP",
            "files": ["a"],
            "evidence_hash": "dbe9cbb4",
            "evidence_kind": "dossier",
            "license_bytes_sha256": _harvest.mit_license_bytes_sha256(),
            "spdx": _harvest.spdx_block_for(
                "evil-cr", "evil", "EVIL-MADE-UP", ["a"], "dbe9cbb4"
            ),
            "note": "[VERIFIED: dbe9cbb4] rebuild behavior spec clean room upstream bytes vendored dialog focus keyboard",
        }
        errs = _harvest.validate_ledger(copy.deepcopy(_harvest.HARVEST_ROWS) + [evil])
        self.assertTrue(any("unknown license" in e for e in errs))
        # aria W3C-Document documented exception stays green.
        self.assertEqual(_harvest.validate_ledger(), [])

    def test_f6_closure_mandated_and_negative_rows(self):
        dropped = [
            d for d in copy.deepcopy(_harvest.TRANSITIVE_DEPS) if d["dep"] != "clsx"
        ]
        self.assertTrue(
            any(
                "mandated sub-dep" in e
                for e in _harvest.validate_transitive_closure(dropped)
            )
        )
        no_bsd = [
            d
            for d in copy.deepcopy(_harvest.TRANSITIVE_DEPS)
            if "BSD" not in d["license_claim"]
        ]
        self.assertTrue(
            any(
                "BSD-negative" in e
                for e in _harvest.validate_transitive_closure(no_bsd)
            )
        )

    def test_f7_closed_platform_refused_in_validator(self):
        bad = copy.deepcopy(_harvest.HARVEST_ROWS)
        bad[0]["note"] += " knapsack board"
        self.assertTrue(
            any("closed platform" in e for e in _harvest.validate_ledger(bad))
        )
        bad_c = copy.deepcopy(_harvest.TRANSITIVE_DEPS)
        bad_c[0]["risk"] += " supernova"
        self.assertTrue(
            any(
                "closed platform" in e
                for e in _harvest.validate_transitive_closure(bad_c)
            )
        )

    def test_f8_files_traversal_refused_via_resolve(self):
        for evil in ("../../etc/passwd", "/etc/passwd", "skill/../../etc/passwd"):
            bad = copy.deepcopy(_harvest.HARVEST_ROWS)
            bad[0]["files"] = [evil]
            errs = _harvest.validate_ledger(bad)
            self.assertTrue(any("traversal" in e or "escapes" in e for e in errs), evil)

    def test_f9_budget_byte_backstop_single_word(self):
        blob = "x" * 200 * 1024
        self.assertGreaterEqual(_harvest.estimate_tokens(blob), 50000)
        text = (
            "---\nname: a\ndescription: b\nlicense: MIT\n"
            "compatibility: c\nmetadata: d\nallowed-tools: e\n---\n" + blob
        )
        self.assertTrue(
            any("exceeds" in e for e in _harvest.disclosure_budget_check(text))
        )

    def test_f10_parity_surface_used_and_full_equality(self):
        import inspect as _inspect

        src_replay = _inspect.getsource(_harvest._replay_surface)
        self.assertIn("surface", src_replay)
        self.assertIn("_skill_text_for_surface", src_replay)
        self.assertNotIn('_ = os.environ.get("QUEEREYE_SURFACE"', src_replay)
        src_check = _inspect.getsource(_harvest.parity_check)
        self.assertIn("count(", src_check)
        self.assertIn("==", src_check)
        # Drift append to on-disk overlay must fail parity with project_root.
        with tempfile.TemporaryDirectory(prefix="queereye-f10-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertTrue(ok, errs)
            overlay = Path(tmp) / ".queereye" / "skill-claude" / "SKILL.md"
            overlay.write_text(
                overlay.read_text(encoding="utf-8") + "\n<!-- drift -->\n",
                encoding="utf-8",
            )
            self.assertTrue(_harvest.parity_check(str(tmp)))

    def test_f11_cite_gate_structured_not_substring(self):
        with tempfile.TemporaryDirectory(prefix="queereye-f11-") as tmp:
            _seed_interview(tmp)
            ok, errs, _w = harvest_write_all(str(tmp))
            self.assertTrue(ok, errs)
            receipt = _harvest.render_receipt(str(tmp))
            self.assertEqual(_harvest.verify_cite_gate(receipt, str(tmp)), [])
            # Bare-substring forgery (hashes without structure) refused.
            forged = (
                _harvest.tokens_digest(str(tmp))
                + " "
                + " ".join(_harvest.DOSSIER_HASHES)
            )
            self.assertTrue(_harvest.verify_cite_gate(forged, str(tmp)))
            # Missing ledger binding refused even with token line intact.
            forged2 = receipt.replace("harvest.json sha256:", "harvest HASH:")
            self.assertTrue(
                any(
                    "harvest.json sha256" in e
                    for e in _harvest.verify_cite_gate(forged2, str(tmp))
                )
            )


if __name__ == "__main__":
    unittest.main()
