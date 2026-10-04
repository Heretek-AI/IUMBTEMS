#!/usr/bin/env python3
"""Malformed negative-knowledge hardening regressions (01-nk-hardening).

Pins A1-A5 + tiebreak R1-R7: live-shaped malformed NK must complete with
WARNING_LOW_GROUNDING (never KeyError), sibling strict-index paths hardened,
tag-spoof neutralized (kind wins), single-dict coerced, invisibles dropped,
prompts carry bad examples, length bounded, A5 sweep broadened.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.auditor_engine import EpistemicAuditorEngine  # noqa: E402
from runner.claim_witness import (  # noqa: E402
    KIND_NEGATIVE_KNOWLEDGE,
    TAG_NEGATIVE_KNOWLEDGE,
    TAG_VERIFIED,
    ClaimWitness,
    NK_MAX_FIELD_LEN,
    claim_has_valid_negative_knowledge,
    claims_from_dossier,
    normalize_claim,
    normalize_negative_knowledge_rows,
)
from runner.refinement import (  # noqa: E402
    compute_brainstorm_score_from_claims,
    compute_epistemic_score_from_claims,
)
from runner.research_swarm import SwarmRunner  # noqa: E402
from runner.state_machine import ResearchStateMachine  # noqa: E402

VALID_NK = {
    "query": "Zero-latency PCIe streaming ZK provers",
    "finding": "No architecture eliminates bus transfer overhead.",
}

# Live-shaped malformed rows: missing keys, None, non-string, empty,
# whitespace-only, and non-dict entries.
MALFORMED_NK = [
    {"query": "Missing finding entirely"},
    {"finding": "Missing query entirely"},
    {"query": None, "finding": "Null query"},
    {"query": "Null finding", "finding": None},
    {"query": 123, "finding": "Non-string query"},
    {"query": "Non-string finding", "finding": ["list"]},
    {"query": "", "finding": "Empty query"},
    {"query": "Whitespace query", "finding": "   "},
    "just a string",
    None,
    42,
]


class TestNormalizeNegativeKnowledgeRows(unittest.TestCase):
    def test_valid_row_passes(self):
        valid, dropped = normalize_negative_knowledge_rows([dict(VALID_NK)])
        self.assertEqual(len(valid), 1)
        self.assertEqual(dropped, 0)

    def test_malformed_matrix_all_dropped(self):
        valid, dropped = normalize_negative_knowledge_rows(list(MALFORMED_NK))
        self.assertEqual(valid, [])
        self.assertEqual(dropped, len(MALFORMED_NK))

    def test_mixed_split(self):
        rows = [dict(VALID_NK), *MALFORMED_NK, {"query": "q2", "finding": "f2"}]
        valid, dropped = normalize_negative_knowledge_rows(rows)
        self.assertEqual(len(valid), 2)
        self.assertEqual(dropped, len(MALFORMED_NK))

    def test_non_list_coerce_or_count(self):
        # R3: single-dict coerces (never vanishes with dropped=0); absent
        # None stays ([], 0); other wrong-typed fields count dropped=1.
        valid, dropped = normalize_negative_knowledge_rows(None)
        self.assertEqual((valid, dropped), ([], 0))
        valid, dropped = normalize_negative_knowledge_rows(
            {"query": "q", "finding": "f"}
        )
        self.assertEqual(len(valid), 1)
        self.assertEqual(dropped, 0)
        self.assertEqual(valid[0]["query"], "q")
        valid, dropped = normalize_negative_knowledge_rows(
            {"query": "orphan, no finding"}
        )
        self.assertEqual((valid, dropped), ([], 1))
        for bad in ("nk", 42, [["q"]]):
            valid, dropped = normalize_negative_knowledge_rows(bad)
            self.assertEqual((valid, dropped), ([], 1), f"field: {bad!r}")

    def test_witness_validity_agrees_with_row_validity(self):
        good = normalize_claim(dict(VALID_NK), kind=KIND_NEGATIVE_KNOWLEDGE)
        self.assertTrue(claim_has_valid_negative_knowledge(good))
        for raw in [r for r in MALFORMED_NK if isinstance(r, dict)]:
            witness = normalize_claim(raw, kind=KIND_NEGATIVE_KNOWLEDGE)
            self.assertFalse(
                claim_has_valid_negative_knowledge(witness), f"row: {raw!r}"
            )

    def test_invisible_only_dropped_and_stripped(self):
        # R4: ZWSP/ZWNJ/ZWJ/BOM-only sides are empty → dropped.
        for invisible in ("\u200b\u200b", "\ufeff", "\u200c\u200d", "\u200b \u200c"):
            valid, dropped = normalize_negative_knowledge_rows(
                [{"query": invisible, "finding": "real"}]
            )
            self.assertEqual((valid, dropped), ([], 1), f"query={invisible!r}")
            valid, dropped = normalize_negative_knowledge_rows(
                [{"query": "real", "finding": invisible}]
            )
            self.assertEqual((valid, dropped), ([], 1), f"finding={invisible!r}")
        # Visible text wrapped in invisibles survives, stripped.
        valid, dropped = normalize_negative_knowledge_rows(
            [{"query": "\u200bq\ufeff", "finding": "f\u200d"}]
        )
        self.assertEqual(dropped, 0)
        self.assertEqual(len(valid), 1)
        self.assertEqual(valid[0]["query"], "q")
        self.assertEqual(valid[0]["finding"], "f")
        self.assertNotIn("\u200b", valid[0]["query"])
        self.assertNotIn("\ufeff", valid[0]["query"])

    def test_statement_shaped_and_numeric_dropped(self):
        # R5: claim-shaped (statement) + numeric/empty/whitespace/non-dict.
        bad_rows = [
            {"statement": "Provers are slow.", "source_hash": "abc"},
            {"query": 123, "finding": "numeric"},
            {"query": "q", "finding": 456},
            {"query": "", "finding": "empty"},
            {"query": "   ", "finding": "ws"},
            "a string row",
            None,
            42,
            ["q", "f"],
        ]
        valid, dropped = normalize_negative_knowledge_rows(bad_rows)
        self.assertEqual(valid, [])
        self.assertEqual(dropped, len(bad_rows))

    def test_duplicate_rows_deduped(self):
        # R2: exact duplicates dedupe — repeat is dropped+counted.
        rows = [dict(VALID_NK), dict(VALID_NK), {"query": "q2", "finding": "f2"}]
        valid, dropped = normalize_negative_knowledge_rows(rows)
        self.assertEqual(len(valid), 2)
        self.assertEqual(dropped, 1)

    def test_long_fields_truncated(self):
        # R6: overlong fields truncate to the cap, still valid.
        big = "x" * (NK_MAX_FIELD_LEN + 100)
        valid, dropped = normalize_negative_knowledge_rows(
            [{"query": big, "finding": big}]
        )
        self.assertEqual(dropped, 0)
        self.assertEqual(len(valid), 1)
        self.assertLessEqual(len(valid[0]["query"]), NK_MAX_FIELD_LEN)
        self.assertLessEqual(len(valid[0]["finding"]), NK_MAX_FIELD_LEN)

    def test_tag_spoof_kind_wins(self):
        # R2: NK row with tag VERIFIED stays NEGATIVE_KNOWLEDGE, never VERIFIED.
        spoofed = dict(VALID_NK)
        spoofed["tag"] = "VERIFIED"
        witness = normalize_claim(spoofed, kind=KIND_NEGATIVE_KNOWLEDGE)
        self.assertEqual(witness.tag, TAG_NEGATIVE_KNOWLEDGE)
        self.assertNotEqual(witness.tag, TAG_VERIFIED)
        self.assertTrue(claim_has_valid_negative_knowledge(witness))


class TestMalformedNKAuditCompletes(unittest.TestCase):
    def _audit_with_nk(
        self, alpha_nk, beta_nk, mode=None, extra_alpha=None, extra_beta=None
    ):
        tmp = tempfile.mkdtemp()
        base = Path(tmp) / ".research"
        sm = ResearchStateMachine(base_dir=base)
        sm.init_session("nk hardening")
        sm.set_scopes([{"scope_id": "scope_nk", "dependencies": []}])
        alpha_dossier = {
            "agent": "Agent Alpha",
            "scope_id": "scope_nk",
            "affirmative_claims": [],
            "inferred_implications": [],
            "negative_knowledge": alpha_nk,
        }
        beta_dossier = {
            "agent": "Agent Beta",
            "scope_id": "scope_nk",
            "falsification_claims": [],
            "methodological_critiques": [],
            "hypotheses": [],
            "negative_knowledge": beta_nk,
        }
        if extra_alpha:
            alpha_dossier.update(extra_alpha)
        if extra_beta:
            beta_dossier.update(extra_beta)
        sm.record_agent_completion("scope_nk", "alpha", alpha_dossier)
        sm.record_agent_completion("scope_nk", "beta", beta_dossier)
        auditor = EpistemicAuditorEngine(base_dir=base)
        report = auditor.audit_scope("scope_nk", mode=mode)
        synthesis = (
            base / "scratchpads" / "scope_nk" / "scope_synthesis.md"
        ).read_text(encoding="utf-8")
        return report, synthesis

    def test_malformed_nk_completes_with_warning_not_crash(self):
        # A4: malformed-NK dossier completes with WARNING_LOW_GROUNDING.
        alpha_nk = [dict(VALID_NK), *MALFORMED_NK]
        report, synthesis = self._audit_with_nk(alpha_nk, [])
        summary = report["summary"]
        self.assertEqual(summary["verdict"], "WARNING_LOW_GROUNDING")
        # A2: only the valid row counts.
        self.assertEqual(summary["negative_knowledge_count"], 1)
        # A1: malformed rows dropped and counted.
        self.assertEqual(summary["dropped_malformed_nk"], len(MALFORMED_NK))
        # Valid row rendered; dropped note present; no KeyError raised.
        self.assertIn(VALID_NK["query"], synthesis)
        self.assertIn(VALID_NK["finding"], synthesis)
        self.assertIn(f"dropped_malformed_nk={len(MALFORMED_NK)}", synthesis)

    def test_scoring_equals_rendering_on_valid_rows_only(self):
        alpha_nk = [dict(VALID_NK), {"query": "orphan query"}]
        beta_nk = [
            {"query": "q-beta", "finding": "f-beta"},
            {"query": None, "finding": None},
        ]
        report, synthesis = self._audit_with_nk(alpha_nk, beta_nk)
        summary = report["summary"]
        self.assertEqual(summary["negative_knowledge_count"], 2)
        self.assertEqual(summary["dropped_malformed_nk"], 2)
        rendered = synthesis.count("[NEGATIVE_KNOWLEDGE:")
        self.assertEqual(rendered, summary["negative_knowledge_count"])

    def test_all_malformed_nk_renders_empty_catalog_with_count(self):
        report, synthesis = self._audit_with_nk(list(MALFORMED_NK), [])
        summary = report["summary"]
        self.assertEqual(summary["verdict"], "WARNING_LOW_GROUNDING")
        self.assertEqual(summary["negative_knowledge_count"], 0)
        self.assertEqual(summary["dropped_malformed_nk"], len(MALFORMED_NK))
        self.assertIn("No negative knowledge declarations logged.", synthesis)

    def test_claims_scorers_ignore_malformed_nk(self):
        witnesses = [
            ClaimWitness(
                claim_id=f"NK{i}",
                kind=KIND_NEGATIVE_KNOWLEDGE,
                tag=TAG_NEGATIVE_KNOWLEDGE,
                statement="nk",
                query=r.get("query") if isinstance(r, dict) else None,
                finding=r.get("finding") if isinstance(r, dict) else None,
            )
            for i, r in enumerate([VALID_NK, *MALFORMED_NK])
        ]
        for scorer in (
            compute_epistemic_score_from_claims,
            compute_brainstorm_score_from_claims,
        ):
            _, breakdown = scorer(witnesses)
            self.assertEqual(
                breakdown["negative_knowledge_count"],
                1,
                f"scorer {scorer.__name__} counted malformed NK",
            )

    def test_single_dict_nk_coerced_not_vanished(self):
        # R3: single-dict NK field coerces — valid dict counts 1/dropped 0,
        # malformed dict counts 0/dropped 1 (never vanished with dropped=0).
        report, synthesis = self._audit_with_nk(
            {"query": "solo q", "finding": "solo f"}, []
        )
        self.assertEqual(report["summary"]["negative_knowledge_count"], 1)
        self.assertEqual(report["summary"]["dropped_malformed_nk"], 0)
        self.assertIn("solo q", synthesis)
        report2, _ = self._audit_with_nk({"query": "orphan, no finding"}, [])
        self.assertEqual(report2["summary"]["negative_knowledge_count"], 0)
        self.assertEqual(report2["summary"]["dropped_malformed_nk"], 1)

    def test_none_sections_do_not_crash(self):
        # R1: None claim sections degrade to 0, audit completes.
        report, _ = self._audit_with_nk(
            [dict(VALID_NK)],
            [],
            extra_alpha={"inferred_implications": None, "affirmative_claims": None},
            extra_beta={
                "falsification_claims": None,
                "methodological_critiques": None,
                "hypotheses": None,
            },
        )
        self.assertIn(
            report["summary"]["verdict"],
            ("WARNING_LOW_GROUNDING", "CERTIFIED", "WARNING_LICENSE_CONFLICT"),
        )

    def test_critiques_non_dict_do_not_crash(self):
        # R1: non-dict/None critiques skipped, audit completes.
        report, _ = self._audit_with_nk(
            [],
            [],
            extra_beta={
                "methodological_critiques": [
                    None,
                    "x",
                    42,
                    {"target_assertion": "t", "critique": "c"},
                    {"target_assertion": None, "critique": 123, "evidence_hash": 456},
                ]
            },
        )
        matrix = report["divergence_matrix"]
        # Only the 2 dict critiques produce matrix rows.
        self.assertEqual(len(matrix), 2)

    def test_tag_spoof_no_phantom_verified(self):
        # R2: spoofed NK (tag VERIFIED) counts as NK, never verified.
        spoofed = dict(VALID_NK)
        spoofed["tag"] = "VERIFIED"
        report, _ = self._audit_with_nk([spoofed], [])
        self.assertEqual(report["summary"]["negative_knowledge_count"], 1)
        self.assertEqual(report["summary"]["verified_passed"], 0)
        # Claims-path scorers agree: no phantom verified.
        dossier = {"negative_knowledge": [spoofed]}
        witnesses = claims_from_dossier(dossier)
        self.assertEqual(len(witnesses), 1)
        self.assertEqual(witnesses[0].tag, TAG_NEGATIVE_KNOWLEDGE)
        for scorer in (
            compute_epistemic_score_from_claims,
            compute_brainstorm_score_from_claims,
        ):
            _, breakdown = scorer(witnesses)
            self.assertEqual(breakdown["verified_passed"], 0)
            self.assertEqual(breakdown["negative_knowledge_count"], 1)

    def test_huge_nk_bounded_synthesis(self):
        # R6: 1M-char fields must not bloat synthesis.
        big = "Q" * 1_000_000
        report, synthesis = self._audit_with_nk([{"query": big, "finding": big}], [])
        self.assertEqual(report["summary"]["negative_knowledge_count"], 1)
        # Synthesis bounded: far below the 2MB raw input.
        self.assertLess(len(synthesis), 20000)
        self.assertLessEqual(len(synthesis), NK_MAX_FIELD_LEN * 2 + 10000)


class TestSiblingCrashSweep(unittest.TestCase):
    def test_mark_rejected_survives_malformed_rows(self):
        from runner.auditor_engine import _mark_rejected_claims
        from runner.claim_witness import STATUS_REJECTED

        good = ClaimWitness(claim_id="C1", kind="CLAIM", tag="VERIFIED", statement="s")
        # Must not raise on non-dict / missing / non-string claim_id.
        _mark_rejected_claims(
            [good],
            [
                None,
                "x",
                42,
                {},
                {"no_id": 1},
                {"claim_id": None},
                {"claim_id": 123},
                {"claim_id": "C1", "audited_tag": "UNVERIFIED_REJECTED"},
            ],
        )
        self.assertEqual(good.tag, "UNVERIFIED_REJECTED")
        self.assertEqual(good.status, STATUS_REJECTED)

    def test_verify_renders_survive_int_hash_none_statement(self):
        eng = EpistemicAuditorEngine.__new__(EpistemicAuditorEngine)
        rows = [
            {
                "audited_tag": "VERIFIED",
                "source_hash": 123456789012345,
                "statement": None,
            },
            {"audited_tag": "VERIFIED", "source_hash": None, "statement": 42},
            "not a dict",
            None,
            {},
        ]
        lines = eng._render_verified_section(rows, rows)
        text = "\n".join(lines)
        # No literal "None" from None sides; int hash rendered as prefix.
        self.assertNotIn("None", text)
        self.assertIn("12345678", text)

    def test_rejected_render_survives_none_sides(self):
        eng = EpistemicAuditorEngine.__new__(EpistemicAuditorEngine)
        rows = [
            {"audited_tag": "UNVERIFIED_REJECTED", "statement": None, "reason": None},
            {"audited_tag": "UNVERIFIED_REJECTED", "statement": 7, "reason": 8},
        ]
        lines = eng._render_rejected_section(rows, {})
        text = "\n".join(lines)
        self.assertNotIn("None", text)

    def test_verify_claims_survives_non_dict(self):
        import tempfile

        tmp = tempfile.mkdtemp()
        base = Path(tmp) / ".research"
        eng = EpistemicAuditorEngine(base_dir=base)
        audited, v, r = eng._verify_claims(
            [
                None,
                "x",
                42,
                {"claim_id": None, "source_hash": 123, "verbatim_quote": None},
            ],
            constitution=None,
        )
        # All four degrade to rejections, no crash.
        self.assertEqual(v, 0)
        self.assertEqual(r, 4)
        self.assertEqual(len(audited), 4)

    def test_brainstorm_scorer_survives_non_witness(self):
        # R1: non-witness entries (None/string/int) degrade to skip, never
        # AttributeError on `.status`/`.tag`.
        witnesses = [
            None,
            "x",
            42,
            ClaimWitness(
                claim_id="H1",
                kind="HYPOTHESIS",
                tag="HYPOTHESIS",
                statement="h",
                falsification="measurable probe",
            ),
        ]
        _, breakdown = compute_brainstorm_score_from_claims(witnesses)
        self.assertEqual(breakdown["hypothesis_count"], 1)

    def test_brainstorm_scorer_survives_int_falsification_parents(self):
        # R1: int falsification must not crash `.strip()`; int parent_claims
        # must not earn well-formed credit or crash.
        witnesses = [
            ClaimWitness(
                claim_id="H1",
                kind="HYPOTHESIS",
                tag="HYPOTHESIS",
                statement="h",
                falsification=42,
            ),
            ClaimWitness(
                claim_id="I1",
                kind="INFERENCE",
                tag="INFERRED",
                statement="i",
                parent_claims=42,
            ),
        ]
        # Must not raise; neither int side earns well-formed credit.
        _, breakdown = compute_brainstorm_score_from_claims(witnesses)
        self.assertEqual(breakdown["hypothesis_count"], 1)
        self.assertEqual(breakdown["inferred_count"], 1)
        self.assertEqual(breakdown.get("well_formed_count", 0), 0)

    def test_brainstorm_scorer_dedupe_agrees_with_ingest(self):
        # R2: invisible-variant + exact duplicates dedupe on the cleaned key,
        # mirroring normalize_negative_knowledge_rows — scorers agree.
        # Hand-built witnesses bypass normalize_claim cleaning, so the scorer
        # itself must normalize (raw-key code counted 3 here, cleaned counts 1).
        witnesses = [
            ClaimWitness(
                claim_id="NK1",
                kind=KIND_NEGATIVE_KNOWLEDGE,
                tag=TAG_NEGATIVE_KNOWLEDGE,
                statement="nk",
                query="Zero-latency PCIe streaming ZK provers",
                finding="No architecture eliminates bus transfer overhead.",
            ),
            ClaimWitness(
                claim_id="NK2",
                kind=KIND_NEGATIVE_KNOWLEDGE,
                tag=TAG_NEGATIVE_KNOWLEDGE,
                statement="nk",
                query="\u200bZero-latency PCIe streaming ZK provers\ufeff",
                finding="No architecture eliminates bus transfer overhead.",
            ),
            ClaimWitness(
                claim_id="NK3",
                kind=KIND_NEGATIVE_KNOWLEDGE,
                tag=TAG_NEGATIVE_KNOWLEDGE,
                statement="nk",
                query="Zero-latency PCIe streaming ZK provers",
                finding="No architecture eliminates bus transfer overhead.",
            ),
        ]
        for scorer in (
            compute_epistemic_score_from_claims,
            compute_brainstorm_score_from_claims,
        ):
            _, breakdown = scorer(witnesses)
            self.assertEqual(
                breakdown["negative_knowledge_count"],
                1,
                f"scorer {scorer.__name__} dedupe disagrees with ingest",
            )

    def test_claim_verdict_survives_non_witness(self):
        # R1: claim_verdict degrades on None/string/unhashable-hash, never
        # AttributeError/TypeError.
        from runner.refinement import claim_verdict

        for bad in (
            None,
            "x",
            42,
            ClaimWitness(
                claim_id="C1",
                kind="CLAIM",
                tag="VERIFIED",
                statement="s",
                source_hash={"un": "hashable"},
            ),
        ):
            verdict = claim_verdict(bad)
            self.assertIn(verdict["verdict"], ("ACCEPTED", "REJECTED"))

    def test_rejected_render_survives_non_dict_summary(self):
        # R1: non-dict summary degrades to {}, never AttributeError on `.get`.
        eng = EpistemicAuditorEngine.__new__(EpistemicAuditorEngine)
        lines = eng._render_rejected_section([], "not a dict")
        self.assertTrue(any("0 claims were verified" in ln for ln in lines))


class TestNoStrictNkIndex(unittest.TestCase):
    def test_auditor_has_no_strict_untrusted_index(self):
        # R7: broadened beyond the original 4 NK tokens — no strict indexing
        # on untrusted dossier/audit rows may remain in auditor_engine.py.
        text = (PROJECT_ROOT / "runner" / "auditor_engine.py").read_text(
            encoding="utf-8"
        )
        banned = (
            "n['query']",
            'n["query"]',
            "n['finding']",
            'n["finding"]',
            'r["claim_id"]',
            "r['claim_id']",
            'crit["',
            "crit['",
            '["repo"]',
            "['repo']",
            '["query"]',
            "['query']",
            '["finding"]',
            "['finding']",
            '["statement"]',
            "['statement']",
            '["source_hash"]',
            "['source_hash']",
            'claim["',
            "claim['",
            'item["',
            "item['",
        )
        for token in banned:
            self.assertNotIn(token, text, f"banned strict index: {token}")
        # Guards must be present: isinstance checks on untrusted rows.
        for guard in (
            "isinstance(crit",
            "isinstance(claim",
            "isinstance(r, dict)",
            "isinstance(alpha_claims",
            "isinstance(critiques",
            "_safe_list_len",
            "_safe_str",
        ):
            self.assertIn(guard, text, f"missing defensive guard: {guard}")

    def test_prompts_carry_bad_examples_and_spam_note(self):
        # R5: both prompts show statement-shaped + numeric/empty/whitespace/
        # non-dict bad examples and the dropped-no-penalty spam note.
        for prompt in ("prompts/agent_brainstormer.md", "prompts/agent_darkharvest.md"):
            text = (PROJECT_ROOT / prompt).read_text(encoding="utf-8")
            flat = " ".join(text.split())
            for token in (
                '"statement"',
                "123",
                '""',
                "Whitespace-only",
                "just a string",
                "dropped",
                "duplicates",
                "deduped",
                "2000 chars",
            ):
                self.assertIn(token, flat, f"{prompt} missing {token!r}")


class TestMockModesStillGreen(unittest.TestCase):
    def _mock_run(self, mode):
        tmp = tempfile.mkdtemp()
        base = Path(tmp) / ".research"
        runner = SwarmRunner(base_dir=base, mock_mode=True, mode=mode)
        status = runner.run_swarm("Where do we go from here?")
        self.assertEqual(status, "completed")

    def test_mock_brainstorm_green(self):
        self._mock_run("brainstorm")

    def test_mock_darkharvest_green(self):
        self._mock_run("darkharvest")


class TestR8PcrbHardening(unittest.TestCase):
    """R8 (tiebreak-2 F1): _witness_for isinstance-guards, never TypeError."""

    def _witness(self, **kw):
        base = dict(
            claim_id="C1",
            kind="CLAIM",
            tag="VERIFIED",
            statement="s",
            source_hash="h",
            verbatim_quote="q",
        )
        base.update(kw)
        return ClaimWitness(**base)

    def test_int_dict_list_hash_quote_degrade_to_reject_never_typeerror(self):
        from runner.pcrb import _witness_for

        class DummyHasher:
            def __init__(self):
                self.calls = 0

            def verify_quote(self, h, q):
                self.calls += 1
                return True, 1.0, "ok"

        for bad_hash in (123, {"un": "hashable"}, ["h"], 0, "", None):
            for bad_quote in ("real quote", 42, {"q": 1}, ["q"], "", None):
                # Skip the fully-valid str/str case (covered below).
                if (
                    isinstance(bad_hash, str)
                    and bad_hash
                    and isinstance(bad_quote, str)
                    and bad_quote
                ):
                    continue
                hasher = DummyHasher()
                needed: set = set()
                c = self._witness(source_hash=bad_hash, verbatim_quote=bad_quote)
                try:
                    w = _witness_for(c, hasher, needed)
                except (TypeError, AttributeError):
                    self.fail(
                        f"_witness_for raised on hash={bad_hash!r} quote={bad_quote!r}"
                    )
                self.assertIsNone(w["confidence"])
                # Non-str hashes never enter the bundle set (no unhashable).
                for h in needed:
                    self.assertIsInstance(h, str)
                # Non-str sides never reach the hasher.
                if (
                    not isinstance(bad_hash, str)
                    or not bad_hash
                    or not isinstance(bad_quote, str)
                    or not bad_quote
                ):
                    self.assertEqual(
                        hasher.calls, 0, f"hasher called for {bad_hash!r}/{bad_quote!r}"
                    )

    def test_valid_str_hash_quote_still_bundles_on_pass(self):
        from runner.pcrb import _witness_for

        class PassHasher:
            def verify_quote(self, h, q):
                return True, 0.99, "ok"

        needed: set = set()
        c = self._witness(source_hash="abc123", verbatim_quote="real quote")
        w = _witness_for(c, PassHasher(), needed)
        self.assertAlmostEqual(w["confidence"], 0.99)
        self.assertIn("abc123", needed)

    def test_non_witness_input_never_typeerror(self):
        from runner.pcrb import _witness_for

        class NeverHasher:
            def verify_quote(self, h, q):  # pragma: no cover
                raise AssertionError("must not be called")

        for bad in (None, "x", 42):
            w = _witness_for(bad, NeverHasher(), set())
            self.assertIsNone(w["confidence"])


class TestR9ClaimStoreHardening(unittest.TestCase):
    """R9 (tiebreak-2 F2): _upsert_claim coerce-or-drop, never sqlite error."""

    def test_non_string_hash_statement_quote_never_sqlite_error(self):
        import sqlite3

        from runner.claim_store import ClaimStore

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            store = ClaimStore(base)
            cur = store.conn.cursor()
            variants = [
                dict(source_hash=123, statement="s", verbatim_quote="q"),
                dict(source_hash={"un": "hashable"}, statement="s", verbatim_quote="q"),
                dict(source_hash=["h"], statement="s", verbatim_quote="q"),
                dict(source_hash="h1", statement={"s": 1}, verbatim_quote="q"),
                dict(source_hash="h2", statement=42, verbatim_quote="q"),
                dict(source_hash="h3", statement="s", verbatim_quote={"q": 1}),
                dict(source_hash="h4", statement="s", verbatim_quote=["q"]),
                dict(source_hash="h5", statement="s", verbatim_quote=123),
                dict(
                    source_hash="h6",
                    statement="s",
                    verbatim_quote="q",
                    query={"q": 1},
                    finding=42,
                ),
                dict(
                    source_hash="h7",
                    statement="s",
                    verbatim_quote="q",
                    parent_claims=42,
                ),
            ]
            for i, kw in enumerate(variants):
                c = ClaimWitness(
                    claim_id=f"C{i}",
                    kind="CLAIM",
                    tag="VERIFIED",
                    statement=kw.get("statement", "s"),
                    source_hash=kw.get("source_hash"),
                    source_url=kw.get("source_url"),
                    verbatim_quote=kw.get("verbatim_quote"),
                    query=kw.get("query"),
                    finding=kw.get("finding"),
                    parent_claims=kw.get("parent_claims", []),
                )
                try:
                    store._upsert_claim(cur, "scope_01", "alpha_dossier.json", c)
                except (sqlite3.ProgrammingError, TypeError):
                    self.fail(f"_upsert_claim raised on {kw!r}")
            store.conn.commit()
            n = store.conn.execute("SELECT COUNT(*) AS n FROM claims").fetchone()["n"]
            self.assertEqual(n, len(variants))
            # All stored TEXT fields are str/None (no dict survivors).
            rows = store.conn.execute(
                "SELECT source_hash, statement, verbatim_quote FROM claims"
            ).fetchall()
            for r in rows:
                for k in ("source_hash", "statement", "verbatim_quote"):
                    self.assertTrue(
                        r[k] is None or isinstance(r[k], (str, int, float)),
                        f"{k}={r[k]!r} not coercible",
                    )
            store.close()

    def test_index_dossier_with_malformed_claims_completes(self):
        from runner.claim_store import ClaimStore

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            store = ClaimStore(base)
            dossier = {
                "affirmative_claims": [
                    {
                        "claim_id": "A1",
                        "statement": "s",
                        "source_hash": {"bad": 1},
                        "verbatim_quote": ["q"],
                    },
                    {
                        "claim_id": "A2",
                        "statement": {"bad": 1},
                        "source_hash": 123,
                        "verbatim_quote": 456,
                    },
                ]
            }
            n = store.index_dossier("scope_01", "alpha_dossier.json", dossier)
            self.assertEqual(n, 2)
            store.close()


class TestR10ValidatorTypeChecks(unittest.TestCase):
    """R10 (tiebreak-2 F3): validator isinstance+nonempty == scorer."""

    def _nk(self, **kw):
        base = dict(
            claim_id="NK1",
            kind=KIND_NEGATIVE_KNOWLEDGE,
            tag=TAG_NEGATIVE_KNOWLEDGE,
            statement="nk",
            query="q",
            finding="f",
        )
        base.update(kw)
        return ClaimWitness(**base)

    def test_int_query_finding_rejected(self):
        from runner.refinement import check_invariants

        for bad_q in (123, 0, {"q": 1}, ["q"], "", "   ", None):
            c = self._nk(query=bad_q, finding="real finding")
            rules = {v.rule for v in check_invariants([c])}
            self.assertIn("NEG_KNOWLEDGE_REQUIRES_QUERY", rules, f"query={bad_q!r}")
        for bad_f in (456, 0, {"f": 1}, ["f"], "", "   ", None):
            c = self._nk(query="real query", finding=bad_f)
            rules = {v.rule for v in check_invariants([c])}
            self.assertIn("NEG_KNOWLEDGE_REQUIRES_FINDING", rules, f"finding={bad_f!r}")

    def test_int_parent_falsification_rejected(self):
        from runner.claim_witness import (
            KIND_HYPOTHESIS,
            KIND_INFERENCE,
            TAG_HYPOTHESIS,
            TAG_INFERRED,
        )
        from runner.refinement import check_invariants

        for bad_p in (42, "parent-id-string", None, "   ", {"p": 1}):
            # Note: a bare string parent is coerced to [string] by
            # normalize_claim, but a hand-built witness carrying a bare
            # string/int must still be rejected (validator==scorer: scorer
            # requires list/tuple for well_formed).
            c = ClaimWitness(
                claim_id="I1",
                kind=KIND_INFERENCE,
                tag=TAG_INFERRED,
                statement="i",
                parent_claims=bad_p,
                deductive_logic="because",
            )
            # String case: normalize_claim would coerce, but hand-built bare
            # string is not list/tuple → still rejected here.
            rules = {v.rule for v in check_invariants([c])}
            self.assertIn("INFERRED_REQUIRES_PARENTS", rules, f"parents={bad_p!r}")
        for bad_f in (42, 0, {"f": 1}, ["f"], "", "   ", None):
            c = ClaimWitness(
                claim_id="H1",
                kind=KIND_HYPOTHESIS,
                tag=TAG_HYPOTHESIS,
                statement="h",
                falsification=bad_f,
            )
            rules = {v.rule for v in check_invariants([c])}
            self.assertIn("HYPOTHESIS_REQUIRES_FALSIFICATION", rules, f"fals={bad_f!r}")

    def test_dict_hash_rejected_without_hasher_bypass(self):
        from runner.refinement import check_invariants

        for bad_h in ({"un": "hashable"}, ["h"], 123, 0, "", None):
            c = ClaimWitness(
                claim_id="C1",
                kind="CLAIM",
                tag="VERIFIED",
                statement="s",
                source_hash=bad_h,
                verbatim_quote="real quote",
            )
            # No hasher: dict/int hash must still be REJECTED via
            # VERIFIED_REQUIRES_HASH (no bypass through the early return).
            rules = {v.rule for v in check_invariants([c], hasher=None)}
            self.assertIn("VERIFIED_REQUIRES_HASH", rules, f"hash={bad_h!r}")
        for bad_q in (42, {"q": 1}, ["q"], "", None):
            c = ClaimWitness(
                claim_id="C2",
                kind="CLAIM",
                tag="VERIFIED",
                statement="s",
                source_hash="abchash",
                verbatim_quote=bad_q,
            )
            rules = {v.rule for v in check_invariants([c], hasher=None)}
            self.assertIn("VERIFIED_REQUIRES_QUOTE", rules, f"quote={bad_q!r}")

    def test_validator_agrees_with_scorer_on_int_sides(self):
        from runner.refinement import (
            check_invariants,
            compute_brainstorm_score_from_claims,
            compute_epistemic_score_from_claims,
        )

        # NK int query: scorer counts 0, validator must fire.
        c = self._nk(query=123, finding="real")
        for scorer in (
            compute_epistemic_score_from_claims,
            compute_brainstorm_score_from_claims,
        ):
            _, br = scorer([c])
            self.assertEqual(br["negative_knowledge_count"], 0)
        self.assertTrue(check_invariants([c]))


class TestR11DedupeFullKey(unittest.TestCase):
    """R11 (tiebreak-2 F4a): full pre-truncate dedupe key."""

    def test_duplicates_still_dedupe(self):
        rows = [dict(query="q", finding="f"), dict(query="q", finding="f")]
        valid, dropped = normalize_negative_knowledge_rows(rows)
        self.assertEqual(len(valid), 1)
        self.assertEqual(dropped, 1)

    def test_distinct_past_2k_stay_valid_2(self):
        # Pin: prefix+X vs prefix+Y → valid=2 (no truncate-collapse).
        prefix = "P" * NK_MAX_FIELD_LEN
        rows = [
            {"query": prefix + "X", "finding": "F"},
            {"query": prefix + "Y", "finding": "F"},
        ]
        valid, dropped = normalize_negative_knowledge_rows(rows)
        self.assertEqual(len(valid), 2, "distinct past-2k must not collapse")
        self.assertEqual(
            dropped, 0, "distinct rows must not inflate dropped (no forgery)"
        )
        # Truncated for render/storage (bounded) even though dedupe used full.
        for v in valid:
            self.assertLessEqual(len(v["query"]), NK_MAX_FIELD_LEN)

    def test_dropped_distinguishes_malformed_vs_duplicate(self):
        # Malformed → dropped; duplicate → dropped; distinct → not dropped.
        _, d_mal = normalize_negative_knowledge_rows([{"query": "orphan"}])
        self.assertEqual(d_mal, 1)
        _, d_dup = normalize_negative_knowledge_rows(
            [dict(query="q", finding="f"), dict(query="q", finding="f")]
        )
        self.assertEqual(d_dup, 1)
        prefix = "Q" * NK_MAX_FIELD_LEN
        _, d_distinct = normalize_negative_knowledge_rows(
            [
                {"query": prefix + "X", "finding": "F"},
                {"query": prefix + "Y", "finding": "F"},
            ]
        )
        self.assertEqual(d_distinct, 0)

    def test_scorer_agrees_on_past_2k(self):
        from runner.refinement import (
            compute_brainstorm_score_from_claims,
            compute_epistemic_score_from_claims,
        )

        prefix = "S" * NK_MAX_FIELD_LEN
        witnesses = [
            ClaimWitness(
                claim_id="NK1",
                kind=KIND_NEGATIVE_KNOWLEDGE,
                tag=TAG_NEGATIVE_KNOWLEDGE,
                statement="nk",
                query=prefix + "X",
                finding="F",
            ),
            ClaimWitness(
                claim_id="NK2",
                kind=KIND_NEGATIVE_KNOWLEDGE,
                tag=TAG_NEGATIVE_KNOWLEDGE,
                statement="nk",
                query=prefix + "Y",
                finding="F",
            ),
        ]
        for scorer in (
            compute_epistemic_score_from_claims,
            compute_brainstorm_score_from_claims,
        ):
            _, br = scorer(witnesses)
            self.assertEqual(br["negative_knowledge_count"], 2, scorer.__name__)

    def test_ingest_and_scorer_agree_via_dossier(self):
        from runner.refinement import compute_brainstorm_score_from_claims

        prefix = "D" * NK_MAX_FIELD_LEN
        dossier = {
            "negative_knowledge": [
                {"query": prefix + "X", "finding": "F"},
                {"query": prefix + "Y", "finding": "F"},
            ]
        }
        valid, dropped = normalize_negative_knowledge_rows(
            dossier["negative_knowledge"]
        )
        self.assertEqual(len(valid), 2)
        self.assertEqual(dropped, 0)
        witnesses = claims_from_dossier(dossier)
        self.assertEqual(len(witnesses), 2)
        _, br = compute_brainstorm_score_from_claims(witnesses)
        self.assertEqual(br["negative_knowledge_count"], 2)


class TestNoTruthinessBypass(unittest.TestCase):
    """Ban-test expansion (tiebreak-2): pcrb/claim_store/refinement guards."""

    def test_refinement_has_no_bare_truthiness(self):
        text = (PROJECT_ROOT / "runner" / "refinement.py").read_text(encoding="utf-8")
        banned = (
            "if not c.source_hash:",
            "if not c.verbatim_quote:",
            "if not c.parent_claims:",
            "if not c.deductive_logic:",
            "if not c.falsification:",
            "if not c.query:",
            "if not c.finding:",
            "c.source_hash and c.verbatim_quote",
        )
        for token in banned:
            self.assertNotIn(token, text, f"banned truthiness: {token}")
        for guard in (
            "isinstance(_sh, str)",
            "isinstance(_q, str)",
            "isinstance(_parents, (list, tuple))",
            "isinstance(_logic, str)",
            "isinstance(_fals, str)",
            "_is_nonempty_str(getattr(c,",
        ):
            self.assertIn(guard, text, f"missing R10 guard: {guard}")

    def test_pcrb_has_isinstance_guards(self):
        text = (PROJECT_ROOT / "runner" / "pcrb.py").read_text(encoding="utf-8")
        banned = (
            "if not c.source_hash:",
            "if c.verbatim_quote:",
            "hasher.verify_quote(c.source_hash",
            "needed_hashes.add(c.source_hash)",
        )
        for token in banned:
            self.assertNotIn(token, text, f"banned pcrb pattern: {token}")
        for guard in ("isinstance(_sh, str)", "isinstance(_q, str)"):
            self.assertIn(guard, text, f"missing R8 guard: {guard}")

    def test_claim_store_has_coercion(self):
        text = (PROJECT_ROOT / "runner" / "claim_store.py").read_text(encoding="utf-8")
        for guard in ("_coerce_text", "isinstance(hash_s, str)"):
            self.assertIn(guard, text, f"missing R9 guard: {guard}")
        self.assertNotIn(
            "if c.source_hash:", text, "banned bare truthiness in claim_store"
        )


if __name__ == "__main__":
    unittest.main()
