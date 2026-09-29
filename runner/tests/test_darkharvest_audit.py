#!/usr/bin/env python3
"""Darkharvest audit regressions (issue #5).

Covers the three layers that made darkharvest ungrounded by construction:
claim-schema normalization (auditor could not see darkharvest claims), the
alpha/beta license cross-check (MIT vs NOASSERTION reached a human as
divergence 0), and self-reported verification fields that must never count.
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
from runner.darkharvest_claims import (  # noqa: E402
    RepoValidator,
    cross_check_repos,
    normalize_dossier_claims,
    sanitize_self_reported,
)
from runner.research_swarm import SwarmRunner  # noqa: E402
from skills.research_cache.hasher import SourceHasher  # noqa: E402


class FakeValidator:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def validate(self, owner_repo):
        self.calls.append(owner_repo)
        return self.result


def _candidate(license_, risk, policy, shash, quote):
    return {
        "repo_id": "DH-01",
        "name": "getpaseo/paseo",
        "url": "https://github.com/getpaseo/paseo",
        "source_hash": shash,
        "verbatim_quote": quote,
        "license": license_,
        "license_risk": risk,
        "harvest_policy": policy,
        "verdicts": [
            {"feature": "worktree isolation", "verdict": "vendor", "reason": "r"}
        ],
    }


class TestNormalization(unittest.TestCase):
    def test_darkharvest_shape_becomes_standard_claims(self):
        dossier = {
            "candidate_repositories": [
                _candidate("MIT", "SAFE", "depend-or-vendor", "abc", "q")
            ]
        }
        claims = normalize_dossier_claims(dossier, "alpha")
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0]["source_hash"], "abc")
        self.assertEqual(claims[0]["verbatim_quote"], "q")

    def test_standard_keys_win_when_present(self):
        dossier = {
            "affirmative_claims": [{"claim_id": "C1", "statement": "s"}],
            "candidate_repositories": [
                _candidate("MIT", "SAFE", "depend-or-vendor", "abc", "q")
            ],
        }
        claims = normalize_dossier_claims(dossier, "alpha")
        self.assertEqual([c["claim_id"] for c in claims], ["C1"])


class TestSelfReported(unittest.TestCase):
    def test_audit_shaped_keys_are_renamed_not_counted(self):
        dossier = {
            "epistemic_audit": {"verified_claims": 15},
            "confidence": "HIGH",
            "scope_id": "s1",
        }
        dossier, renamed = sanitize_self_reported(dossier)
        self.assertIn("epistemic_audit", renamed)
        self.assertIn("confidence", renamed)
        self.assertNotIn("epistemic_audit", dossier)
        self.assertEqual(
            dossier["self_reported_epistemic_audit"]["verified_claims"], 15
        )
        # Nothing audit-shaped remains to be mistaken for verified counts.
        self.assertFalse(set(dossier) & {"epistemic_audit", "confidence"})


class TestLicenseCrossCheck(unittest.TestCase):
    def test_mit_vs_noassertion_is_blocking_and_conservative(self):
        from runner.auditor_engine import _repo_validation_enabled  # noqa: F401

        alpha = {
            "candidate_repositories": [
                _candidate("MIT", "SAFE", "depend-or-vendor", "a", "q")
            ]
        }
        beta = {
            "candidate_repositories": [
                _candidate(
                    "NOASSERTION", "PROHIBITIVE", "clean-room-rebuild-only", "a", "q"
                )
            ]
        }
        findings = cross_check_repos(alpha, beta)
        kinds = {f["kind"] for f in findings}
        self.assertIn("LICENSE_DISAGREEMENT", kinds)
        self.assertTrue(all(f["severity"] == "BLOCKING" for f in findings))
        self.assertEqual(findings[0]["resolution"], "clean-room-rebuild-only")

    def test_agreement_yields_no_findings(self):
        alpha = {
            "candidate_repositories": [
                _candidate("MIT", "SAFE", "depend-or-vendor", "a", "q")
            ]
        }
        beta = {
            "candidate_repositories": [
                _candidate("MIT", "SAFE", "depend-or-vendor", "a", "q")
            ]
        }
        self.assertEqual(cross_check_repos(alpha, beta), [])

    def test_404_is_an_unresolvable_blocking_finding(self):
        alpha = {
            "candidate_repositories": [
                _candidate("MIT", "SAFE", "depend-or-vendor", "a", "q")
            ]
        }
        findings = cross_check_repos(
            alpha, {}, validator=FakeValidator({"exists": False})
        )
        self.assertTrue(any(f["kind"] == "REPO_UNRESOLVABLE" for f in findings))

    def test_offline_fails_open(self):
        alpha = {
            "candidate_repositories": [
                _candidate("MIT", "SAFE", "depend-or-vendor", "a", "q")
            ]
        }
        findings = cross_check_repos(
            alpha,
            {},
            validator=FakeValidator(
                {"exists": None, "license": None, "archived": None}
            ),
        )
        self.assertEqual(findings, [])

    def test_validator_fail_open_on_error(self):
        """Network failure must yield exists=None, never raise (offline-safe)."""
        import urllib.error
        from unittest import mock

        v = RepoValidator(enabled=True, timeout=0.001)
        with mock.patch(
            "urllib.request.urlopen", side_effect=urllib.error.URLError("offline")
        ):
            self.assertIsNone(v.validate("owner/repo")["exists"])

    def test_validator_404_is_not_exists(self):
        import urllib.error
        from unittest import mock

        v = RepoValidator(enabled=True, timeout=0.001)
        err = urllib.error.HTTPError("u", 404, "not found", {}, None)
        with mock.patch("urllib.request.urlopen", side_effect=err):
            self.assertFalse(v.validate("owner/missing")["exists"])


class TestDarkharvestAuditIntegration(unittest.TestCase):
    def _runner_and_scope(self):
        tmp = tempfile.mkdtemp()
        base = Path(tmp) / ".research"
        runner = SwarmRunner(base_dir=base, mock_mode=True, mode="darkharvest")
        sm = runner.state_machine
        sm.init_session("arena")
        sm.set_scopes([{"scope_id": "s1", "title": "t", "objective": "o"}])
        hasher = SourceHasher(base_dir=base)
        shash = hasher.store_source(
            "https://github.com/getpaseo/paseo",
            "Paseo archives a clean worktree with no confirmation.",
            "paseo",
        )
        quote = "Paseo archives a clean worktree with no confirmation."
        scope_dir = sm.get_scope_dir("s1")
        (scope_dir / "alpha_dossier.json").write_text(
            json.dumps(
                {
                    "scope_id": "s1",
                    "candidate_repositories": [
                        _candidate("MIT", "SAFE", "depend-or-vendor", shash, quote)
                    ],
                    "epistemic_audit": {"verified_claims": 15, "confidence": "HIGH"},
                }
            ),
            encoding="utf-8",
        )
        (scope_dir / "beta_dossier.json").write_text(
            json.dumps(
                {
                    "scope_id": "s1",
                    "candidate_repositories": [
                        _candidate(
                            "NOASSERTION",
                            "PROHIBITIVE",
                            "clean-room-rebuild-only",
                            shash,
                            quote,
                        )
                    ],
                }
            ),
            encoding="utf-8",
        )
        return runner, base

    def test_auditor_sees_claims_and_blocks_license_conflict(self):
        runner, base = self._runner_and_scope()
        auditor = EpistemicAuditorEngine(
            base_dir=base,
            repo_validator=FakeValidator(
                {"exists": True, "license": "NOASSERTION", "archived": False}
            ),
        )
        report = auditor.audit_scope("s1", mode="darkharvest")
        summary = report["summary"]

        self.assertGreater(summary["total_claims_audited"], 0)
        self.assertGreaterEqual(summary["verified_passed"], 1)
        self.assertEqual(summary["verdict"], "WARNING_LICENSE_CONFLICT")
        self.assertTrue(
            any(f["kind"] == "LICENSE_DISAGREEMENT" for f in report["harvest_findings"])
        )

    def test_synthesis_section_no_longer_claims_one_hundred_percent(self):
        from runner.auditor_engine import EpistemicAuditorEngine as AE

        lines = AE._render_rejected_section(
            [], {"verified_passed": 0, "verdict": "WARNING_LOW_GROUNDING"}
        )
        text = "\n".join(lines)
        self.assertIn("0 claims were verified", text)
        self.assertNotIn("100%", text)

    def test_synthesis_section_reports_license_conflict(self):
        from runner.auditor_engine import EpistemicAuditorEngine as AE

        lines = AE._render_rejected_section(
            [],
            {
                "verified_passed": 0,
                "verdict": "WARNING_LICENSE_CONFLICT",
                "blocking_findings": 2,
            },
        )
        self.assertIn("blocking license/ground-truth finding", "\n".join(lines))


class TestOrphanScopes(unittest.TestCase):
    def test_orphan_detected_and_not_deleted(self):
        tmp = tempfile.mkdtemp()
        base = Path(tmp) / ".research"
        runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
        sm = runner.state_machine
        sm.init_session("x")
        sm.set_scopes([{"scope_id": "kept", "title": "t", "objective": "o"}])
        stray = sm.get_scope_dir("abandoned")
        stray.mkdir(parents=True, exist_ok=True)
        (stray / "manifest.json").write_text("{}", encoding="utf-8")

        orphans = sm.find_orphan_scopes()
        ids = {o["scope_id"] for o in orphans}
        self.assertIn("abandoned", ids)
        self.assertNotIn("kept", ids)
        # Marked, never deleted.
        self.assertTrue(stray.exists())

class TestLicenseWhitelistPolicy(unittest.TestCase):
    """`license_whitelist` (config) is the darkharvest policy source (phase 01).

    Default-absent behavior must reproduce the built-in permissive set exactly;
    a configured whitelist replaces it (an empty/invalid list falls back rather
    than silently making every license clean-room-only).
    """

    @staticmethod
    def _disagreeing_pair(alpha_license, beta_license):
        return (
            {
                "candidate_repositories": [
                    _candidate(alpha_license, "SAFE", "depend-or-vendor", "a", "q")
                ]
            },
            {
                "candidate_repositories": [
                    _candidate(beta_license, "SAFE", "depend-or-vendor", "a", "q")
                ]
            },
        )

    def test_default_whitelist_matches_builtin_set(self):
        from runner.darkharvest_claims import (
            PERMISSIVE_LICENSES,
            normalize_license_whitelist,
        )

        self.assertEqual(normalize_license_whitelist(None), PERMISSIVE_LICENSES)
        self.assertEqual(normalize_license_whitelist([]), PERMISSIVE_LICENSES)
        # Shape-invalid input (not a list, or all non-strings) falls back ...
        self.assertEqual(normalize_license_whitelist("MPL-2.0"), PERMISSIVE_LICENSES)
        self.assertEqual(normalize_license_whitelist([1, 2]), PERMISSIVE_LICENSES)
        # ... while an explicit list REPLACES the set (case-normalized).
        self.assertEqual(
            normalize_license_whitelist(["mit", "MPL-2.0"]),
            frozenset({"MIT", "MPL-2.0"}),
        )
        self.assertEqual(
            normalize_license_whitelist(["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"]),
            PERMISSIVE_LICENSES,
        )

    def test_configured_whitelist_changes_the_resolution(self):
        alpha, beta = self._disagreeing_pair("MIT", "MPL-2.0")
        # Default: MPL-2.0 is not permissive -> conservative clean-room.
        default_findings = cross_check_repos(alpha, beta)
        self.assertEqual(default_findings[0]["resolution"], "clean-room-rebuild-only")
        # Configured: the user accepts both licenses for depend/vendor.
        licensed = cross_check_repos(
            alpha, beta, license_whitelist=["MIT", "MPL-2.0"]
        )
        self.assertEqual(licensed[0]["resolution"], "depend-or-vendor")

    def test_whitelist_changes_ground_truth_contradiction_findings(self):
        """The whitelist drives the ground-truth license risk check too."""
        alpha = {
            "candidate_repositories": [
                _candidate("MIT", "SAFE", "depend-or-vendor", "a", "q")
            ]
        }
        validator = FakeValidator(
            {"exists": True, "license": "MPL-2.0", "archived": False}
        )
        default_kinds = {
            f["kind"] for f in cross_check_repos(alpha, {}, validator=validator)
        }
        self.assertIn("LICENSE_CONTRADICTS_GROUND_TRUTH", default_kinds)

        allowed_kinds = {
            f["kind"]
            for f in cross_check_repos(
                alpha, {}, validator=validator, license_whitelist=["MPL-2.0"]
            )
        }
        self.assertNotIn("LICENSE_CONTRADICTS_GROUND_TRUTH", allowed_kinds)

    def test_auditor_engine_passes_the_whitelist_through(self):
        from runner.auditor_engine import EpistemicAuditorEngine

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            engine = EpistemicAuditorEngine(
                base_dir=base, license_whitelist=["mpl-2.0"]
            )
            self.assertEqual(engine.license_whitelist, frozenset({"MPL-2.0"}))
            engine_default = EpistemicAuditorEngine(base_dir=base)
            from runner.darkharvest_claims import PERMISSIVE_LICENSES

            self.assertEqual(engine_default.license_whitelist, PERMISSIVE_LICENSES)

    def test_runner_config_reaches_the_auditor(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / ".research"
            base.mkdir(parents=True, exist_ok=True)
            (base / "config.json").write_text(
                json.dumps({"license_whitelist": ["mit", "MPL-2.0"]}),
                encoding="utf-8",
            )
            runner = SwarmRunner(base_dir=base, mock_mode=True, mode="darkharvest")
            self.assertEqual(
                runner.auditor.license_whitelist, frozenset({"MIT", "MPL-2.0"})
            )


if __name__ == "__main__":
    unittest.main()
