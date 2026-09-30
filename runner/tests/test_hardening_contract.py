#!/usr/bin/env python3
"""Phase 05 (hardening-contract, H2-H6) acceptance tests: C1-C5.

Each class maps to one acceptance criterion in
`.roadmap/05-hardening-contract/GOAL.md`. Default-absent behavior is pinned
byte-identical throughout (absent keys, None guards, and clean configs behave
exactly as before).
"""

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _write_config(base: Path, payload: dict) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    cfg_file = base / "config.json"
    cfg_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return cfg_file


def _handle_config(args):
    from runner.mcp_server import _handle_config as h

    return json.loads(h(args))


class TestC1ExpectedHashNormalization(unittest.TestCase):
    """H2: normalized conflict comparison, 8-hex minimum, show+hash decision."""

    def test_case_and_whitespace_only_difference_is_one_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            _write_config(base, {"mode": "research"})
            live = hashlib.sha256((base / "config.json").read_bytes()).hexdigest()
            payload = _handle_config(
                {
                    "mode": "audit",
                    "base_dir": str(base),
                    "expected_hash": "  " + live.upper() + "  ",
                    "expectedHash": live,
                }
            )
            self.assertEqual(payload["status"], "updated", payload)
            self.assertTrue(payload["written_to"])

    def test_genuinely_different_spellings_still_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(base, {"mode": "research"})
            before = cfg_file.read_bytes()
            payload = _handle_config(
                {
                    "mode": "audit",
                    "base_dir": str(base),
                    "expected_hash": "a" * 64,
                    "expectedHash": "b" * 64,
                }
            )
            self.assertEqual(payload["code"], "CONFLICTING_EXPECTED_HASH")
            self.assertFalse(payload["written"])
            self.assertEqual(cfg_file.read_bytes(), before)

    def test_malformed_but_equal_spellings_surface_hash_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(base, {"mode": "research"})
            before = cfg_file.read_bytes()
            payload = _handle_config(
                {
                    "mode": "audit",
                    "base_dir": str(base),
                    "expected_hash": "zzzzzzzz",
                    "expectedHash": "ZZZZZZZZ",
                }
            )
            self.assertEqual(payload["code"], "CONFIG_INVALID_EXPECTED_HASH")
            self.assertFalse(payload["written"])
            self.assertEqual(cfg_file.read_bytes(), before)

    def test_short_guard_rejected_through_mcp(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            _write_config(base, {"mode": "research"})
            payload = _handle_config(
                {"mode": "audit", "base_dir": str(base), "expected_hash": "abcd"}
            )
            self.assertEqual(payload["code"], "CONFIG_INVALID_EXPECTED_HASH")
            self.assertFalse(payload["written"])

    def test_show_wins_over_updates_and_ignores_the_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(base, {"mode": "research"})
            before = cfg_file.read_bytes()
            payload = _handle_config(
                {
                    "show": True,
                    "mode": "audit",
                    "base_dir": str(base),
                    "expected_hash": "deadbeef00",  # bogus: must NOT go stale
                }
            )
            self.assertEqual(payload["status"], "current", payload)
            self.assertEqual(payload["config"]["mode"], "research")
            self.assertEqual(payload["ignored_updates"], ["mode"])
            self.assertEqual(cfg_file.read_bytes(), before)

    def test_show_without_updates_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            _write_config(base, {"mode": "research"})
            payload = _handle_config({"show": True, "base_dir": str(base)})
            self.assertEqual(payload["status"], "current")
            self.assertNotIn("ignored_updates", payload)

    def test_js_resolve_expected_hash_normalizes(self):
        """config-io.js mirrors the normalized conflict rule (Phase-05 H2)."""
        res = subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                """
                import { resolveExpectedHash } from "./plugins/opencode/config-io.js";
                const out = [];
                out.push(resolveExpectedHash({ expected_hash: "ABCDEF12", expectedHash: "abcdef12" }));
                let conflict = null;
                try {
                  resolveExpectedHash({ expected_hash: "a".repeat(8), expectedHash: "b".repeat(8) });
                } catch (e) { conflict = e.code; }
                let malformed = null;
                try {
                  resolveExpectedHash({ expected_hash: "zzzzzzzz", expectedHash: "ZZZZZZZZ" });
                } catch (e) { malformed = e.code; }
                console.log(JSON.stringify({ same: out[0], conflict, malformed }));
                """,
            ],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        data = json.loads(res.stdout.strip().splitlines()[-1])
        self.assertEqual(data["same"], "abcdef12")
        self.assertEqual(data["conflict"], "CONFLICTING_EXPECTED_HASH")
        self.assertEqual(data["malformed"], "CONFIG_INVALID_EXPECTED_HASH")


class TestC2HostAndPackValidation(unittest.TestCase):
    """H3: searxng host presence + domain_pack trim/reject."""

    def test_scheme_without_host_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(base, {"mode": "research"})
            before = cfg_file.read_bytes()
            for bad in ("http://", "https://", "https:///path-only", "http:// "):
                with self.subTest(bad=bad):
                    payload = _handle_config(
                        {"searxng_url": bad, "base_dir": str(base)}
                    )
                    self.assertEqual(payload["code"], "CONFIG_VALIDATION_FAILED")
                    self.assertFalse(payload["written"])
                    self.assertEqual(cfg_file.read_bytes(), before)

    def test_host_with_port_and_path_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            payload = _handle_config(
                {
                    "searxng_url": "https://searx.local:8888/search",
                    "base_dir": str(base),
                }
            )
            self.assertEqual(payload["status"], "updated", payload)

    def test_null_searxng_url_still_means_untouched(self):
        """Default-absent pin: explicit null clears, absent leaves unchanged."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            payload = _handle_config({"searxng_url": None, "base_dir": str(base)})
            self.assertEqual(payload["status"], "updated", payload)
            self.assertIsNone(payload["config"]["searxng_url"])

    def test_blank_and_padded_pack_rejected_at_config_surface(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(base, {"mode": "research"})
            before = cfg_file.read_bytes()
            for bad in ("", "   ", " biopharma", "biopharma ", " biopharma "):
                with self.subTest(bad=bad):
                    payload = _handle_config(
                        {"domain_pack": bad, "base_dir": str(base)}
                    )
                    self.assertEqual(
                        payload["code"], "CONFIG_VALIDATION_FAILED", payload
                    )
                    self.assertFalse(payload["written"])
                    self.assertEqual(cfg_file.read_bytes(), before)

    def test_set_domain_pack_strips_and_activates(self):
        from runner.mcp_server import _handle_set_domain_pack

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            payload = json.loads(
                _handle_set_domain_pack(
                    {"pack": "  biopharma  ", "base_dir": str(base)}
                )
            )
            self.assertEqual(payload["status"], "activated")
            self.assertEqual(payload["domain_pack"], "biopharma")
            data = json.loads((base / "config.json").read_text(encoding="utf-8"))
            self.assertEqual(data["domain_pack"], "biopharma")

    def test_set_domain_pack_rejects_blank(self):
        from runner.mcp_server import _handle_set_domain_pack

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                _handle_set_domain_pack({"pack": "   ", "base_dir": str(tmp)})

    def test_load_domain_pack_strips(self):
        from runner.refinement import load_domain_pack

        self.assertEqual(
            load_domain_pack("  biopharma  ").accept_threshold,
            load_domain_pack("biopharma").accept_threshold,
        )


class TestC3NullCodeUnification(unittest.TestCase):
    """H4: any caller-supplied null where null is banned -> one code."""

    def test_nested_null_reports_null_code_with_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(base, {"mode": "research"})
            before = cfg_file.read_bytes()
            payload = _handle_config(
                {
                    "verify": {"min_fuzzy_confidence": None},
                    "base_dir": str(base),
                }
            )
            self.assertEqual(payload["code"], "NULL_FOR_NON_NULLABLE_KEY")
            self.assertFalse(payload["written"])
            self.assertTrue(
                any("verify.min_fuzzy_confidence" in e for e in payload["errors"]),
                payload,
            )
            self.assertEqual(cfg_file.read_bytes(), before)

    def test_top_level_null_still_reports_null_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            payload = _handle_config({"mode": None, "base_dir": str(base)})
            self.assertEqual(payload["code"], "NULL_FOR_NON_NULLABLE_KEY")
            self.assertFalse(payload["written"])

    def test_nullable_nested_null_still_clears(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            payload = _handle_config(
                {"agents": {"alpha": {"backend": None}}, "base_dir": str(base)}
            )
            self.assertEqual(payload["status"], "updated", payload)

    def test_map_value_null_reports_null_code_with_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            payload = _handle_config(
                {"mcp_servers": {"searxng": None}, "base_dir": str(base)}
            )
            self.assertEqual(payload["code"], "NULL_FOR_NON_NULLABLE_KEY")
            self.assertTrue(
                any("mcp_servers.searxng" in e for e in payload["errors"]), payload
            )

    def test_non_null_violation_keeps_validation_code(self):
        """The null code must not swallow ordinary schema violations."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            payload = _handle_config(
                {"verify": {"min_fuzzy_confidence": 2.0}, "base_dir": str(base)}
            )
            self.assertEqual(payload["code"], "CONFIG_VALIDATION_FAILED")


class TestC4SingleCoercionContract(unittest.TestCase):
    """H5: hasher owns coercion; MCP forwards raw and echoes effective."""

    def test_coerce_helper_is_the_single_rule(self):
        from skills.research_cache.hasher import coerce_min_fuzzy_confidence

        self.assertEqual(coerce_min_fuzzy_confidence("0.95"), 0.95)
        self.assertEqual(coerce_min_fuzzy_confidence(0.95), 0.95)
        self.assertEqual(coerce_min_fuzzy_confidence("high"), 0.88)
        self.assertEqual(coerce_min_fuzzy_confidence(None), 0.88)
        self.assertEqual(coerce_min_fuzzy_confidence(1.5), 1.0)
        self.assertEqual(coerce_min_fuzzy_confidence(-5), 0.0)

    def test_string_config_forwards_to_hasher_and_echoes_effective(self):
        from runner.mcp_server import _handle_verify_quote
        from skills.research_cache.hasher import SourceHasher

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            hasher = SourceHasher(base)
            words = [f"w{i}" for i in range(1, 21)]
            digest = hasher.store_source(
                url="https://example.test/s", content=" ".join(words)
            )
            quote = " ".join(words[:9]) + " nomatch"
            # Hand-edited string threshold (schema-strict saves can never
            # produce this; the coercion contract covers it anyway).
            _write_config(base, {"verify": {"min_fuzzy_confidence": "0.95"}})
            payload = json.loads(
                _handle_verify_quote(
                    {"hash": digest, "quote": quote, "base_dir": str(base)}
                )
            )
            expected = hasher.verify_quote(digest, quote, min_fuzzy_confidence="0.95")
            self.assertEqual(payload["verified"], expected[0])
            self.assertEqual(payload["min_fuzzy_confidence"], 0.95)

    def test_malformed_config_falls_back_and_echoes_default(self):
        from runner.mcp_server import _handle_verify_quote
        from skills.research_cache.hasher import SourceHasher

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            hasher = SourceHasher(base)
            digest = hasher.store_source(
                url="https://example.test/m", content="exact words here today"
            )
            _write_config(base, {"verify": {"min_fuzzy_confidence": "high"}})
            payload = json.loads(
                _handle_verify_quote(
                    {
                        "hash": digest,
                        "quote": "exact words here today",
                        "base_dir": str(base),
                    }
                )
            )
            self.assertTrue(payload["verified"])
            self.assertEqual(payload["min_fuzzy_confidence"], 0.88)


class TestC5WrittenToAbsolute(unittest.TestCase):
    """H6: absolute `written_to` on both updated legs."""

    def test_write_leg_reports_absolute_written_to(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            payload = _handle_config({"mode": "audit", "base_dir": str(base)})
            self.assertEqual(payload["status"], "updated")
            self.assertTrue(os.path.isabs(payload["written_to"]), payload)
            self.assertTrue(Path(payload["written_to"]).is_file())
            self.assertEqual(
                payload["hash"],
                hashlib.sha256(Path(payload["written_to"]).read_bytes()).hexdigest(),
            )

    def test_defensive_leg_reports_absolute_written_to(self):
        from runner.mcp_server import _config_updated_payload
        from skills.swarm_config.configure import DEFAULT_CONFIG

        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "no-such-dir" / "config.json"
            payload = _config_updated_payload(
                missing, {"mode": "audit"}, DEFAULT_CONFIG
            )
            self.assertEqual(payload["status"], "updated")
            self.assertIsNone(payload["hash"])
            self.assertTrue(os.path.isabs(payload["written_to"]), payload)
            self.assertEqual(
                payload["written_to"], str(Path(os.path.realpath(missing)))
            )


if __name__ == "__main__":
    unittest.main()
