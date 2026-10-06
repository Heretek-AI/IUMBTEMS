#!/usr/bin/env python3
"""Queereye phase 01 acceptance: schema, validators, slot-loop, render-drift.

Phase queereye-01-interview-core (run queereye-style-guide).
Evidence hashes (full quotes in the phase dossier):
- DTCG generic tokens [VERIFIED: 7f369895]
- WCAG contrast 4.5:1 / 3:1 [VERIFIED: 9c9c4f32]
- Rasa required_slots loop [VERIFIED: eb45e3dd]
- Leonardo contrast-first generation [VERIFIED: 44295aec]
- Style Dictionary single-source compile [VERIFIED: e3ecfe46]
- DTCG $value + aliasing [VERIFIED: 12c70178]
- OpenCode V2 plural commands key [VERIFIED: 8223a719]
"""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.queereye import contrast as _contrast
from runner.queereye import fs as _fs
from runner.queereye import render as _render
from runner.queereye import slots as _slots
from runner.queereye import tokens as _tokens
from runner.queereye.cli import check_project, compile_project, render_project


def _full_loop():
    loop = _slots.SlotLoop()
    answers = {
        ("brand", "name"): "Acme Studio",
        ("brand", "voice"): "minimal",
        ("brand", "values"): "clarity",
        ("color", "primary"): "ocean",
        ("color", "neutral"): "slate",
        ("color", "accent"): "teal",
        ("type", "family"): "system",
        ("type", "scale"): "1.250",
        ("type", "base_size"): "16",
        ("layout", "density"): "comfortable",
        ("layout", "radius"): "soft",
        ("layout", "grid"): "12",
        ("effects", "motion"): "subtle",
        ("effects", "elevation"): "restrained",
        ("effects", "decoration"): "text-safe-only",
        ("dark_light", "modes"): "both",
        ("dark_light", "surface"): "dimmed brand",
        ("a11y", "text_level"): "AA",
        ("a11y", "large_text_level"): "AA-large",
        ("a11y", "reduced_motion"): "yes",
    }
    for (axis, slot), value in answers.items():
        loop.submit(axis, slot, value)
    return loop


def _write_fresh_project(tmp):
    root = Path(tmp)
    loop = _full_loop()
    _fs.save_interview_state(str(root), loop)
    ok_c, errs_c, _css = compile_project(str(root))
    assert ok_c, errs_c
    ok_r, errs_r, _guide = render_project(str(root))
    assert ok_r, errs_r
    return loop


class TestDtcgSchema(unittest.TestCase):
    """Schema unit: alias resolve, circular-ref MUST-error, type order."""

    def test_snapshot_pin(self):
        self.assertEqual(_tokens.DTCG_SNAPSHOT, "2025.10")

    def test_alias_resolve_chain(self):
        tree = {
            "color": {
                "primitive": {
                    "brand-500": {"$value": "#1d4ed8", "$type": "color"},
                },
                "semantic": {
                    "primary": {
                        "$value": "{color.primitive.brand-500}",
                        "$type": "color",
                    },
                },
                "component": {
                    "$type": "color",
                    "button-background": {"$value": "{color.semantic.primary}"},
                },
            }
        }
        self.assertEqual(
            _tokens.resolve_alias(tree, "color.semantic.primary"), "#1d4ed8"
        )
        self.assertEqual(
            _tokens.resolve_alias(tree, "color.component.button-background"), "#1d4ed8"
        )
        self.assertEqual(_tokens.validate_tokens(tree), [])

    def test_circular_ref_must_error(self):
        tree = {
            "color": {
                "$type": "color",
                "a": {"$value": "{color.b}"},
                "b": {"$value": "{color.a}"},
            }
        }
        with self.assertRaises(_tokens.CircularAliasError):
            _tokens.resolve_alias(tree, "color.a")
        errs = _tokens.validate_tokens(tree)
        self.assertTrue(any("circular" in e for e in errs), errs)

    def test_unknown_alias_errors(self):
        tree = {"color": {"$type": "color", "a": {"$value": "{color.nope}"}}}
        with self.assertRaises(_tokens.UnknownAliasError):
            _tokens.resolve_alias(tree, "color.nope")
        self.assertTrue(_tokens.validate_tokens(tree))

    def test_type_resolution_order(self):
        # Token $type wins over group $type; group $type fills gaps.
        self.assertEqual(_tokens.resolve_type({"$type": "color"}, "dimension"), "color")
        self.assertEqual(_tokens.resolve_type({}, "dimension"), "dimension")
        tree = {
            "type": {
                "component": {
                    "$type": "dimension",
                    "heading-1": {"$value": {"value": 24, "unit": "px"}},
                }
            }
        }
        seen = {".".join(p): t for p, _n, t in _tokens.iter_tokens(tree)}
        self.assertEqual(seen["type.component.heading-1"], "dimension")
        self.assertEqual(_tokens.validate_tokens(tree), [])
        # Missing $type anywhere is an error.
        bad = {"x": {"y": {"$value": "raw"}}}
        self.assertTrue(any("missing $type" in e for e in _tokens.validate_tokens(bad)))

    def test_full_interview_tokens_validate(self):
        loop = _full_loop()
        tree = loop.to_tokens()
        self.assertEqual(_tokens.validate_tokens(tree), [])
        aliased, total, ratio = _tokens.alias_reuse_ratio(tree)
        self.assertGreater(total, 10)
        self.assertGreaterEqual(ratio, 0.5)


class TestContrastGate(unittest.TestCase):
    """Validator unit: Leonardo-style contrast-first gate."""

    def test_thresholds(self):
        self.assertEqual(_contrast.WCAG_AA_NORMAL, 4.5)
        self.assertEqual(_contrast.WCAG_AA_LARGE, 3.0)
        self.assertEqual(_contrast.WCAG_AAA_ENHANCED, 7.0)

    def test_decorative_but_inaccessible_rejected(self):
        ratio, _req, errors = _contrast.validate_pair(
            "#cccccc", "#ffffff", large_text=False, decorative=True
        )
        self.assertLess(ratio, 4.5)
        self.assertTrue(errors, "decorative exemption must not excuse a text pair")
        self.assertTrue(any("decorative" in e for e in errors))

    def test_passing_pair(self):
        _r, _t, errors = _contrast.validate_pair("#0f172a", "#ffffff")
        self.assertEqual(errors, [])

    def test_ratio_first_generation(self):
        fixed = _contrast.ensure_ratio("#cccccc", "#ffffff", 4.5)
        self.assertGreaterEqual(_contrast.contrast_ratio(fixed, "#ffffff"), 4.5)

    def test_full_loop_pairs_all_pass(self):
        loop = _full_loop()
        failing = _contrast.gate_pairs(loop.probe_pairs())
        self.assertEqual(failing, [])


class TestSlotLoop(unittest.TestCase):
    """Rasa-style required_slots loop: all-skip + smuggling -> 0 one-offs."""

    def test_required_slots_per_axis(self):
        loop = _slots.SlotLoop()
        for axis in _slots.AXES:
            slots = loop.required_slots(axis)
            self.assertTrue(slots, axis)
        self.assertEqual(len(_slots.AXES), 7)

    def test_turn_order_and_complete(self):
        loop = _slots.SlotLoop()
        self.assertFalse(loop.is_complete())
        first = loop.next_required_slot()
        self.assertEqual(first[0], "brand")
        loop = _full_loop()
        self.assertTrue(loop.is_complete())
        self.assertIsNone(loop.next_required_slot())

    def test_vague_is_parse_error_with_counter_question(self):
        loop = _slots.SlotLoop()
        with self.assertRaises(_slots.VagueAnswerError) as ctx:
            loop.submit("brand", "name", "whatever")
        self.assertTrue(ctx.exception.counter_question)

    def test_smuggling_probe_yields_zero_one_offs(self):
        loop = _slots.SlotLoop()
        with self.assertRaises(_slots.SmuggledValueError):
            loop.submit("color", "primary", "use #ff0000 please")
        with self.assertRaises(_slots.SmuggledValueError):
            loop.submit("type", "family", "use 'Comic Sans' please")
        # Smuggled answers never land in state.
        self.assertNotIn("primary", loop.values["color"])

    def test_all_skip_completes_with_zero_one_offs(self):
        loop = _slots.SlotLoop()
        for axis in _slots.AXES:
            for slot in loop.required_slots(axis):
                loop.skip(axis, slot)
        self.assertTrue(loop.is_complete())
        tree = loop.to_tokens()
        self.assertEqual(_tokens.validate_tokens(tree), [])
        self.assertEqual(_tokens.find_one_offs(tree), [])
        failing = _contrast.gate_pairs(
            [(n, f, b, l) for n, f, b, l in loop.probe_pairs()]
        )
        self.assertEqual(failing, [])

    def test_contradiction_triggers_repair_not_agreement(self):
        loop = _slots.SlotLoop()
        # Sycophancy probe: low-contrast taste vs AA gate must repair.
        with self.assertRaises(_slots.ContradictionError) as ctx:
            loop.submit("brand", "values", "low contrast faint barely visible")
        # validate_brand_form repairs; message must propose repair.
        self.assertIn("repair", str(ctx.exception).lower())
        # Contradictory a11y downgrade also repairs.
        with self.assertRaises(_slots.ContradictionError):
            loop.submit("a11y", "text_level", "nah 2:1 is fine")

    def test_incremental_resume_after_kill(self):
        with tempfile.TemporaryDirectory() as tmp:
            loop = _slots.SlotLoop()
            loop.submit("brand", "name", "Acme Studio")
            loop.submit("brand", "voice", "minimal")
            loop.submit("brand", "values", "clarity")
            _fs.save_interview_state(tmp, loop)
            self.assertTrue((Path(tmp) / ".queereye" / "tokens.json").is_file())
            self.assertTrue((Path(tmp) / ".queereye" / "interview.json").is_file())
            # Simulate kill: fresh loop resumes from disk.
            resumed = _slots.SlotLoop()
            self.assertTrue(_fs.load_interview_state(tmp, resumed))
            self.assertEqual(resumed.effective("brand", "name"), "Acme Studio")
            nxt = resumed.next_required_slot()
            self.assertEqual((nxt[0], nxt[1]), ("color", "primary"))


class TestFilesystemContract(unittest.TestCase):
    def test_hard_error_outside_queereye(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(_fs.QueereyePathError):
                _fs.resolve_inside(tmp, "../outside.json")
            with self.assertRaises(_fs.QueereyePathError):
                _fs.resolve_inside(tmp, "/tmp/evil.json")
            with self.assertRaises(_fs.QueereyePathError):
                _fs.write_queereye_file(tmp, "../outside.json", "x")

    def test_idempotent_write_only_on_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            wrote, _b, _n = _fs.write_queereye_file(tmp, "tokens.json", '{"a":1}')
            self.assertTrue(wrote)
            wrote2, _b2, _n2 = _fs.write_queereye_file(tmp, "tokens.json", '{"a":1}')
            self.assertFalse(wrote2)

    def test_user_customized_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            _fs.write_queereye_file(tmp, "notes.md", "my words", user_owned=True)
            wrote, backup, note = _fs.write_queereye_file(
                tmp, "notes.md", "other words", user_owned=True
            )
            self.assertFalse(wrote)
            self.assertIsNotNone(backup)
            self.assertTrue(backup.is_file())
            self.assertIn("user-customized", note)
            self.assertEqual(
                (Path(tmp) / ".queereye" / "notes.md").read_text(encoding="utf-8"),
                "my words",
            )


class TestRenderDrift(unittest.TestCase):
    def test_guide_byte_matches_renderer(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_fresh_project(tmp)
            tree = json.loads(
                (Path(tmp) / ".queereye" / "tokens.json").read_text(encoding="utf-8")
            )
            rows = _contrast.probe_report(_render.pairs_from_tokens(tree))
            expected = _render.render_guide(tree, rows)
            actual = (Path(tmp) / ".queereye" / "STYLE_GUIDE.md").read_text(
                encoding="utf-8"
            )
            self.assertEqual(actual, expected)
            ok, errors = check_project(tmp)
            self.assertEqual(errors, [], errors)
            self.assertTrue(ok)

    def test_fifty_edit_check_strict_zero_contradictions(self):
        """50-edit simulation: mutate non-token prose, --check --strict stays green."""
        with tempfile.TemporaryDirectory() as tmp:
            _write_fresh_project(tmp)
            guide_path = Path(tmp) / ".queereye" / "STYLE_GUIDE.md"
            # Simulate 50 unrelated edits elsewhere in the project (not .queereye/).
            for i in range(50):
                (Path(tmp) / f"note-{i}.md").write_text(f"edit {i}\n", encoding="utf-8")
            # Re-render to prove idempotency, then strict-check.
            ok_r, errs_r, _g = render_project(tmp)
            self.assertTrue(ok_r, errs_r)
            ok, errors = check_project(tmp, strict=True)
            self.assertEqual(errors, [], errors)
            self.assertTrue(ok)
            self.assertTrue(guide_path.is_file())

    def test_drift_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_fresh_project(tmp)
            guide = Path(tmp) / ".queereye" / "STYLE_GUIDE.md"
            guide.write_text(
                guide.read_text(encoding="utf-8") + "\nhand edit\n", encoding="utf-8"
            )
            ok, errors = check_project(tmp)
            self.assertFalse(ok)
            self.assertTrue(any("drift" in e for e in errors))

    def test_css_compile_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_fresh_project(tmp)
            css = (Path(tmp) / ".queereye" / "tokens.css").read_text(encoding="utf-8")
            self.assertIn(":root {", css)
            self.assertIn("--color-primitive-brand-500:", css)
            self.assertIn("var(--color-primitive-brand-500)", css)


class TestOpenCodeSurface(unittest.TestCase):
    """A6: /queereye invokes the interviewer in-session (agent pin, subagent false)."""

    def _run_node(self, code):
        return subprocess.run(
            ["node", "--input-type=module", "-e", code],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )

    def _last_json(self, stdout):
        lines = [
            l.strip() for l in stdout.strip().split("\n") if l.strip().startswith("{")
        ]
        return json.loads(lines[-1])

    def test_snippet_queereye_agent_shape(self):
        snippet = json.loads(
            (PROJECT_ROOT / "config" / "opencode-snippet.json").read_text(
                encoding="utf-8"
            )
        )
        # V2 key is `agents` (plural) [VERIFIED: 8223a719].
        self.assertIn("agents", snippet)
        self.assertNotIn("agent", snippet)
        que = snippet["agents"]["queereye"]
        self.assertTrue(que["description"])
        self.assertTrue(que["system"])
        # V2 permissions-array form.
        self.assertIsInstance(que["permissions"], list)
        self.assertTrue(
            all("action" in r and "effect" in r for r in que["permissions"])
        )
        deny = [r for r in que["permissions"] if r["action"] == "subagent"]
        self.assertTrue(any(r["effect"] == "deny" for r in deny))

    def test_command_catalog_pins_agent(self):
        res = self._run_node(
            """
            import { OPENCODE_COMMANDS, commandCatalog } from "./plugins/opencode/index.js";
            const catalog = commandCatalog();
            console.log(JSON.stringify({queereye: catalog.queereye, names: OPENCODE_COMMANDS.map(c => c.name)}));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        data = self._last_json(res.stdout)
        self.assertIn("queereye", data["names"])
        self.assertEqual(data["queereye"]["agent"], "queereye")
        self.assertEqual(data["queereye"]["subagent"], False)
        self.assertEqual(data["queereye"]["subtask"], False)
        self.assertIn("$ARGUMENTS", data["queereye"]["template"])

    def test_command_execute_switches_agent(self):
        res = self._run_node(
            """
            import plugin from "./plugins/opencode/index.js";
            const added = [];
            const switches = [];
            const prompts = [];
            const host = {
              options: {},
              command: {
                list: async () => ({data: []}),
                transform: async (fn) => { fn({add: (d) => added.push(d)}); return {dispose: () => {}}; },
                reload: async () => {}
              },
              tool: {transform: async () => ({dispose: () => {}}), reload: async () => {}},
              session: {
                prompt: async (p) => { prompts.push(p); return {}; },
                switchAgent: async (a) => { switches.push(a); return {}; }
              }
            };
            await plugin.setup(host);
            const q = added.find(c => c.name === "queereye");
            await q.execute({sessionID: "ses_q", prompt: {text: "hint"}, delivery: "steer"});
            console.log(JSON.stringify({switches, promptHasHint: prompts[0]?.text?.includes("hint"), promptAgentKey: Object.prototype.hasOwnProperty.call(prompts[0] || {}, "agent")}));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        data = self._last_json(res.stdout)
        self.assertTrue(data["switches"])
        self.assertEqual(data["switches"][0]["agent"], "queereye")
        self.assertTrue(data["promptHasHint"])
        self.assertFalse(data["promptAgentKey"])


class TestPrimitiveBypassRegression(unittest.TestCase):
    """QA-B fixup: top-level ``primitive`` group must not launder raw values."""

    def test_top_level_primitive_raw_is_one_off(self):
        tree = {"primitive": {"sneaky-oneoff": {"$value": "#ff0000", "$type": "color"}}}
        one_offs = _tokens.find_one_offs(tree)
        self.assertTrue(
            any(p == "primitive.sneaky-oneoff" for p, _r in one_offs), one_offs
        )

    def test_top_level_primitive_rejected_by_compile_and_strict(self):
        with tempfile.TemporaryDirectory() as tmp:
            loop = _full_loop()
            tree = loop.to_tokens()
            tree["primitive"] = {
                "sneaky-oneoff": {"$value": "#ff0000", "$type": "color"}
            }
            _fs.write_queereye_file(
                tmp, "tokens.json", json.dumps(tree, indent=2, sort_keys=True) + "\n"
            )
            # find_one_offs reports it.
            disk = json.loads(
                (Path(tmp) / ".queereye" / "tokens.json").read_text(encoding="utf-8")
            )
            self.assertTrue(
                any(
                    p == "primitive.sneaky-oneoff"
                    for p, _r in _tokens.find_one_offs(disk)
                )
            )
            # compile refuses it (one-off mint is a compile error).
            ok_c, errs_c, _css = compile_project(tmp)
            self.assertFalse(ok_c)
            self.assertTrue(any("one-off" in e for e in errs_c), errs_c)
            # render to satisfy drift, then strict still refuses the one-off.
            _write_fresh = False
            ok_r, errs_r, _g = render_project(tmp)
            # render itself succeeds (render is pure); strict check must fail.
            _ = (ok_r, errs_r, _write_fresh)
            ok_s, errs_s = check_project(tmp, strict=True)
            self.assertFalse(ok_s)
            self.assertTrue(
                any("one-off" in e and "primitive.sneaky-oneoff" in e for e in errs_s),
                errs_s,
            )
            # CSS must not ship the laundered var (compile failed, no write).
            css_path = Path(tmp) / ".queereye" / "tokens.css"
            if css_path.is_file():
                self.assertNotIn(
                    "--primitive-sneaky-oneoff",
                    css_path.read_text(encoding="utf-8"),
                )

    def test_legitimate_primitive_semantic_component_still_exempt(self):
        tree = {
            "color": {
                "primitive": {
                    "brand-500": {"$value": "#1d4ed8", "$type": "color"},
                },
                "semantic": {
                    "primary": {
                        "$value": "{color.primitive.brand-500}",
                        "$type": "color",
                    },
                },
                "component": {
                    "$type": "color",
                    "button-background": {"$value": "{color.semantic.primary}"},
                },
            }
        }
        self.assertEqual(_tokens.find_one_offs(tree), [])
        self.assertFalse(_tokens._is_primitive_path(("primitive", "sneaky-oneoff")))
        self.assertTrue(_tokens._is_primitive_path(("color", "primitive", "brand-500")))
        self.assertFalse(_tokens._is_primitive_path(("primitive", "primitive", "x")))

    def test_no_primitive_network_ingest_after_fix(self):
        import runner.queereye.tokens as mod

        src = Path(mod.__file__).read_text(encoding="utf-8")
        for needle in ("http://", "https://", "urllib", "requests"):
            self.assertNotIn(needle, src)


class TestCorruptHandlingRegression(unittest.TestCase):
    """QA-B fixup: truncated JSON -> structured gate failure, never traceback."""

    def _seed(self, tmp):
        loop = _full_loop()
        _fs.save_interview_state(str(tmp), loop)
        ok_c, errs_c, _css = compile_project(str(tmp))
        self.assertTrue(ok_c, errs_c)
        ok_r, errs_r, _guide = render_project(str(tmp))
        self.assertTrue(ok_r, errs_r)
        return loop

    def test_truncated_tokens_json_structured_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            (Path(tmp) / ".queereye" / "tokens.json").write_text(
                '{"color":{"prim', encoding="utf-8"
            )
            # compile/render/check return (False, [...]) instead of raising.
            ok_c, errs_c, _css = compile_project(str(tmp))
            self.assertFalse(ok_c)
            self.assertTrue(any("corrupt tokens.json" in e for e in errs_c), errs_c)
            ok_r, errs_r, _g = render_project(str(tmp))
            self.assertFalse(ok_r)
            self.assertTrue(any("corrupt tokens.json" in e for e in errs_r), errs_r)
            ok_s, errs_s = check_project(str(tmp), strict=True)
            self.assertFalse(ok_s)
            self.assertTrue(any("corrupt tokens.json" in e for e in errs_s), errs_s)
            # CLI entry points carry the structured banner + rc 1, no traceback.
            from runner.queereye.cli import main as _main

            self.assertEqual(_main(["--project-dir", tmp, "compile"]), 1)
            self.assertEqual(_main(["--project-dir", tmp, "check", "--strict"]), 1)

    def test_truncated_interview_json_structured_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            (Path(tmp) / ".queereye" / "interview.json").write_text(
                '{"values":{"brand', encoding="utf-8"
            )
            loop2 = _slots.SlotLoop()
            with self.assertRaises(_fs.QueereyeCorruptError) as ctx:
                _fs.load_interview_state(str(tmp), loop2)
            self.assertIn("corrupt interview.json", str(ctx.exception))
            # check gate reports the corrupt interview file (structured).
            ok, errors = check_project(str(tmp))
            self.assertFalse(ok)
            self.assertTrue(any("corrupt interview.json" in e for e in errors), errors)

    def test_kill_mid_write_leaves_original_intact(self):
        import os as _os
        from unittest import mock as _mock

        with tempfile.TemporaryDirectory() as tmp:
            _fs.write_queereye_file(tmp, "tokens.json", '{"a":1}')
            target = Path(tmp) / ".queereye" / "tokens.json"
            self.assertEqual(target.read_text(encoding="utf-8"), '{"a":1}')
            with _mock.patch("os.replace", side_effect=OSError("simulated crash")):
                with self.assertRaises(OSError):
                    _fs.write_queereye_file(tmp, "tokens.json", '{"a":2}')
            # Original bytes survive the killed swap.
            self.assertEqual(target.read_text(encoding="utf-8"), '{"a":1}')
            # No stray unique temp files survive.
            self.assertEqual(list(Path(tmp).rglob("*.tmp")), [])
            # A retry after the kill succeeds (idempotent resume).
            wrote, _b, _n = _fs.write_queereye_file(tmp, "tokens.json", '{"a":2}')
            self.assertTrue(wrote)
            self.assertEqual(target.read_text(encoding="utf-8"), '{"a":2}')
            _ = _os  # keep import explicit for audit


class TestArbitraryDomainAllowlistRegression(unittest.TestCase):
    """QA-B retry2: arbitrary-domain ``<anything>.primitive.<name>`` raws
    must NOT be exempt — only the allowlisted axes-derived domains are."""

    def _evil_tree(self, domain):
        return {
            domain: {"primitive": {"sneaky": {"$value": "#ff0000", "$type": "color"}}}
        }

    def test_evil_domain_raw_is_one_off(self):
        tree = self._evil_tree("evil")
        one_offs = _tokens.find_one_offs(tree)
        self.assertTrue(
            any(p == "evil.primitive.sneaky" for p, _r in one_offs), one_offs
        )
        self.assertFalse(_tokens._is_primitive_path(("evil", "primitive", "sneaky")))
        self.assertTrue(
            any("one-off" in r.lower() or "raw" in r.lower() for _p, r in one_offs)
        )

    def test_empty_primitive_case_variants_all_flagged(self):
        for domain in (
            "",
            " ",
            "Primitive",
            "PRIMITIVE",
            "Color",
            "COLOR",
            "évil",
            "evil",
        ):
            with self.subTest(domain=domain):
                tree = self._evil_tree(domain)
                one_offs = _tokens.find_one_offs(tree)
                self.assertTrue(
                    any(p == f"{domain}.primitive.sneaky" for p, _r in one_offs),
                    f"domain {domain!r} must NOT be exempt: {one_offs}",
                )
                self.assertFalse(
                    _tokens._is_primitive_path((domain, "primitive", "sneaky")),
                    f"domain {domain!r} must fail allowlist",
                )

    def test_allowlisted_domains_still_exempt(self):
        for domain in sorted(_tokens.PRIMITIVE_DOMAINS):
            with self.subTest(domain=domain):
                tree = {
                    domain: {
                        "primitive": {"sneaky": {"$value": "#ff0000", "$type": "color"}}
                    }
                }
                # Raw under an allowlisted depth-3 primitive path stays exempt.
                self.assertTrue(
                    _tokens._is_primitive_path((domain, "primitive", "sneaky"))
                )
                self.assertEqual(_tokens.find_one_offs(tree), [])

    def test_allowlist_is_axes_derived_exact(self):
        self.assertEqual(
            _tokens.PRIMITIVE_DOMAINS,
            frozenset({"color", "type", "space", "radius", "motion", "modes"}),
        )
        # Case-sensitive exact: no lower-casing, no blocklist fallback.
        self.assertNotIn("primitive", _tokens.PRIMITIVE_DOMAINS)
        self.assertNotIn("evil", _tokens.PRIMITIVE_DOMAINS)
        self.assertNotIn("", _tokens.PRIMITIVE_DOMAINS)

    def test_evil_compile_refuses_and_no_ship(self):
        with tempfile.TemporaryDirectory() as tmp:
            loop = _full_loop()
            tree = loop.to_tokens()
            tree["evil"] = {
                "primitive": {"sneaky": {"$value": "#ff0000", "$type": "color"}}
            }
            _fs.write_queereye_file(
                tmp, "tokens.json", json.dumps(tree, indent=2, sort_keys=True) + "\n"
            )
            ok_c, errs_c, _css = compile_project(tmp)
            self.assertFalse(ok_c)
            self.assertTrue(
                any("one-off" in e and "evil.primitive.sneaky" in e for e in errs_c),
                errs_c,
            )
            css_path = Path(tmp) / ".queereye" / "tokens.css"
            if css_path.is_file():
                self.assertNotIn(
                    "--evil-primitive-sneaky", css_path.read_text(encoding="utf-8")
                )
            ok_s, errs_s = check_project(tmp, strict=True)
            self.assertFalse(ok_s)
            self.assertTrue(any("evil.primitive.sneaky" in e for e in errs_s), errs_s)


class TestMixedAliasRawRegression(unittest.TestCase):
    """QA-B retry2: mixed raw + alias (``\"#ff0000 {alias}\"``) must NOT
    count as an alias — flagged as one-off/invalid, render refuses."""

    def _base_tree(self):
        return {
            "color": {
                "primitive": {
                    "brand-500": {"$value": "#1d4ed8", "$type": "color"},
                },
                "semantic": {
                    "primary": {
                        "$value": "{color.primitive.brand-500}",
                        "$type": "color",
                    },
                },
            }
        }

    def test_pure_alias_still_exempt(self):
        tree = self._base_tree()
        self.assertEqual(_tokens.find_one_offs(tree), [])
        self.assertTrue(_tokens.is_alias_value("{color.primitive.brand-500}"))
        self.assertTrue(_tokens.is_alias_value("  {color.primitive.brand-500}  "))
        self.assertFalse(_tokens.is_mixed_alias_value("{color.primitive.brand-500}"))
        self.assertEqual(
            _render.alias_to_var_ref("{color.primitive.brand-500}"),
            "var(--color-primitive-brand-500)",
        )

    def test_prefix_mixed_flagged(self):
        tree = self._base_tree()
        tree["color"]["semantic"]["evil"] = {
            "$value": "#ff0000 {color.primitive.brand-500}",
            "$type": "color",
        }
        self.assertFalse(_tokens.is_alias_value("#ff0000 {color.primitive.brand-500}"))
        self.assertTrue(
            _tokens.is_mixed_alias_value("#ff0000 {color.primitive.brand-500}")
        )
        one_offs = _tokens.find_one_offs(tree)
        self.assertTrue(any(p == "color.semantic.evil" for p, _r in one_offs), one_offs)
        self.assertTrue(
            any("mixed" in r for p, r in one_offs if p == "color.semantic.evil"),
            one_offs,
        )
        self.assertTrue(
            any("mixed" in e for e in _tokens.validate_tokens(tree)),
            _tokens.validate_tokens(tree),
        )

    def test_suffix_mixed_flagged(self):
        tree = self._base_tree()
        tree["color"]["semantic"]["evil"] = {
            "$value": "{color.primitive.brand-500} #ff0000",
            "$type": "color",
        }
        self.assertTrue(
            _tokens.is_mixed_alias_value("{color.primitive.brand-500} #ff0000")
        )
        self.assertTrue(
            any(p == "color.semantic.evil" for p, _r in _tokens.find_one_offs(tree))
        )
        self.assertTrue(_tokens.validate_tokens(tree))

    def test_hyphen_affixed_mixed_flagged(self):
        for mixed in (
            "{color.primitive.brand-500}-suffix",
            "prefix-{color.primitive.brand-500}",
            "prefix-{color.primitive.brand-500}-suffix",
        ):
            with self.subTest(mixed=mixed):
                self.assertFalse(_tokens.is_alias_value(mixed), mixed)
                self.assertTrue(_tokens.is_mixed_alias_value(mixed), mixed)
                tree = self._base_tree()
                tree["color"]["semantic"]["evil"] = {
                    "$value": mixed,
                    "$type": "color",
                }
                self.assertTrue(
                    any(
                        p == "color.semantic.evil"
                        for p, _r in _tokens.find_one_offs(tree)
                    ),
                    mixed,
                )

    def test_render_refuses_mixed_structured(self):
        for mixed in (
            "#ff0000 {color.primitive.brand-500}",
            "{color.primitive.brand-500} #ff0000",
            "{color.primitive.brand-500}-suffix",
        ):
            with self.subTest(mixed=mixed):
                with self.assertRaises(ValueError) as ctx:
                    _render.alias_to_var_ref(mixed)
                self.assertIn("mixed", str(ctx.exception).lower())
                tree = self._base_tree()
                tree["color"]["semantic"]["evil"] = {
                    "$value": mixed,
                    "$type": "color",
                }
                with self.assertRaises(ValueError) as ctx2:
                    _render.iter_declarations(tree)
                self.assertIn("color.semantic.evil", str(ctx2.exception))
                self.assertIn("mixed", str(ctx2.exception).lower())

    def test_mixed_compile_refuses_and_no_prefix_ship(self):
        with tempfile.TemporaryDirectory() as tmp:
            loop = _full_loop()
            tree = loop.to_tokens()
            tree["color"]["semantic"]["evil"] = {
                "$value": "#ff0000 {color.primitive.brand-500}",
                "$type": "color",
            }
            _fs.write_queereye_file(
                tmp, "tokens.json", json.dumps(tree, indent=2, sort_keys=True) + "\n"
            )
            disk = json.loads(
                (Path(tmp) / ".queereye" / "tokens.json").read_text(encoding="utf-8")
            )
            self.assertTrue(
                any(p == "color.semantic.evil" for p, _r in _tokens.find_one_offs(disk))
            )
            ok_c, errs_c, _css = compile_project(tmp)
            self.assertFalse(ok_c)
            self.assertTrue(any("color.semantic.evil" in e for e in errs_c), errs_c)
            css_path = Path(tmp) / ".queereye" / "tokens.css"
            if css_path.is_file():
                css = css_path.read_text(encoding="utf-8")
                self.assertNotIn("#ff0000 var(", css)
                self.assertNotIn("--color-semantic-evil", css)
            # Full all-skip loop stays green: 0 one-offs, reuse intact.
            clean = _slots.SlotLoop()
            for axis in _slots.AXES:
                for slot in clean.required_slots(axis):
                    clean.skip(axis, slot)
            clean_tree = clean.to_tokens()
            self.assertEqual(_tokens.find_one_offs(clean_tree), [])
            _a, _t, ratio = _tokens.alias_reuse_ratio(clean_tree)
            self.assertGreaterEqual(ratio, 0.5)

    def test_no_primitive_network_ingest_after_fix(self):
        import runner.queereye.render as rmod
        import runner.queereye.tokens as mod

        for src in (
            Path(mod.__file__).read_text(encoding="utf-8"),
            Path(rmod.__file__).read_text(encoding="utf-8"),
        ):
            for needle in ("http://", "https://", "urllib", "requests"):
                self.assertNotIn(needle, src)


class TestNegativeKnowledge(unittest.TestCase):
    """DTCG 2025.10 is a shape pin + clean-room schema; no network ingest."""

    def test_no_dt_cg_network_ingest(self):
        # NEGATIVE_KNOWLEDGE(dt-cg-schema-fetch): the tree never fetches a
        # remote DTCG JSON schema; validation is the local clean-room
        # validate_tokens (no new runtime deps).
        import runner.queereye.tokens as mod

        src = Path(mod.__file__).read_text(encoding="utf-8")
        for needle in ("http://", "https://", "urllib", "requests", "fetch("):
            self.assertNotIn(needle, src)


if __name__ == "__main__":
    unittest.main()
