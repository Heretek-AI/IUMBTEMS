#!/usr/bin/env python3
"""Canonical CONFIG schema + validated single-writer persistence (phase 01).

Covers the phase-01 acceptance criteria:

* A1 — `schemas/config.schema.json` is generated from `runner/schemas.py`, the
  default config validates, and the shared fixture corpus (rejecting enum,
  type, range, minLength and pattern violations) yields the expected verdicts.
* A2 — crash-safety (a failure between temp-write and rename leaves the
  original byte-identical) and lock contention (two concurrent writers never
  tear the file or lose each other's keys). NOTE: the full `discover` run is
  blocked in this sandbox by pre-existing failures/hangs in
  `test_search_provider` (`TestRunPathFailFast`/`TestMcpRunStatus`), identical
  on pristine HEAD; phase-owned suites are the verification bar.
* A3 — `expected_hash` mismatch is rejected with a structured error and no
  write; a match (full hash or ≥8-hex prefix) proceeds.
* A4 — MCP `iumbtems_config` accepts every canonical key, rejects invalid
  values before writing, and its advertised input schema matches the GENERATED
  artifact `schemas/config.schema.json` (R2; not the deepcopy source).
* A5 — honest field wiring: `verify.min_fuzzy_confidence` changes verification
  through the MCP surface; `divergence_threshold` is advisory and emitted only
  for non-default values (R3); `output_dir` is deprecated and inert.
* A6 — legacy pin migration is covered in `test_swarm_config.py` (unchanged),
  including R1's refusal to persist schema-rejected files.

Rework (retry 1) regressions: R2/R3/R5/R6/R7/R8 live here; R1/R4 also have
writer-level regressions in `test_swarm_config.py`.
"""

import io
import json
import math
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.mcp_server import CONFIG_TOOL_CONTROL_ARGS  # noqa: E402
from runner.schemas import CONFIG, CONFIG_DEFAULTS  # noqa: E402
from runner.schema_validate import validate  # noqa: E402
from skills.research_cache.hasher import SourceHasher  # noqa: E402
from skills.swarm_config.configure import (  # noqa: E402
    DEFAULT_CONFIG,
    config_hash,
    load_config,
    validate_config,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
VALIDATION_CASES = json.loads(
    (FIXTURES / "config_validation_cases.json").read_text(encoding="utf-8")
)["cases"]

CONTROL_ARGS = set(CONFIG_TOOL_CONTROL_ARGS)

# H1: every keyword the parity comparator deep-compares at each schema node.
# `items` / `additionalProperties` recurse as schema nodes; `default` compares
# by value (deep: dict/list defaults compare element-wise via !=).
COMPARE_KEYWORDS = (
    "type",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "pattern",
    "default",
)

# One representative valid value per canonical key; the test asserts this map
# covers the schema exactly, so a new key cannot slip in without a test.
VALID_UPDATES = {
    "search_engine": "brave",
    "max_iterations": 3,
    "divergence_threshold": 0.5,
    "mode": "audit",
    "backend": "opencode",
    "cache_raw_markdown": False,
    "cache_ttl_days": 14,
    "search_timeout_s": 3.5,
    "searxng_url": "http://localhost:8080",
    "license_whitelist": ["MIT"],
    "output_dir": "/tmp/renamed-workspace",
    "allocation": "auction",
    "domain_pack": "biopharma",
    "verify": {"min_fuzzy_confidence": 0.9},
    "agents": {
        "alpha": {
            "backend": ["claude", "-p"],
            "model": "example/model",
            "opencode_agent": "brainstormer",
        }
    },
    "opencode_auto": False,
    "opencode_agent": "darkharvester",
    "mcp_servers": {"searxng": False, "firecrawl": True},
}

# One clearly invalid value per canonical key.
INVALID_UPDATES = {
    "search_engine": "google",
    "max_iterations": 9,
    "divergence_threshold": "high",
    "mode": "swarm",
    "backend": "gemini",
    "cache_raw_markdown": "yes",
    "cache_ttl_days": -1,
    "search_timeout_s": 0,
    "searxng_url": 42,
    "license_whitelist": "MIT",
    "output_dir": 42,
    "allocation": "lottery",
    "domain_pack": 7,
    "verify": {"min_fuzzy_confidence": 2.0},
    "agents": "claude -p",
    "opencode_auto": "yes",
    "opencode_agent": 5,
    "mcp_servers": "enabled",
}


def _write_config(base: Path, payload: dict) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    cfg_file = base / "config.json"
    cfg_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return cfg_file


class TestCanonicalSchema(unittest.TestCase):
    def test_generated_config_schema_in_sync(self):
        from scripts.gen_schemas import check

        self.assertEqual(check(), 0)

    def test_default_config_matches_canonical_defaults(self):
        self.assertEqual(DEFAULT_CONFIG, CONFIG_DEFAULTS)
        self.assertEqual(validate(CONFIG_DEFAULTS, CONFIG), [])
        self.assertEqual(validate_config(DEFAULT_CONFIG), [])

    def test_every_default_is_declared_in_the_schema(self):
        self.assertEqual(set(CONFIG_DEFAULTS), set(CONFIG["properties"]))
        for key, value in CONFIG_DEFAULTS.items():
            self.assertEqual(CONFIG["properties"][key].get("default"), value, key)

    def test_per_key_annotations_present(self):
        scopes = {"run", "retrieval", "dispatch", "audit", "cache", "layout"}
        restarts = {"next-run", "none"}
        for key, subschema in CONFIG["properties"].items():
            self.assertIsInstance(subschema.get("x-label"), str, key)
            self.assertIn(subschema.get("x-scope"), scopes, key)
            self.assertIn(subschema.get("x-restart"), restarts, key)
            self.assertIsInstance(subschema.get("description"), str, key)

    def test_output_dir_is_flagged_deprecated(self):
        self.assertTrue(CONFIG["properties"]["output_dir"].get("deprecated"))
        self.assertEqual(CONFIG["properties"]["output_dir"]["x-restart"], "none")

    def test_fixture_corpus_verdicts(self):
        for case in VALIDATION_CASES:
            with self.subTest(case=case["name"]):
                problems = validate(case["config"], CONFIG)
                self.assertEqual(
                    not problems,
                    case["valid"],
                    f"{case['name']}: {problems}",
                )
                if not case["valid"] and case.get("expect"):
                    self.assertTrue(
                        any(case["expect"] in p for p in problems),
                        f"{case['name']}: {case['expect']!r} not in {problems}",
                    )

    def test_non_finite_numbers_are_rejected(self):
        # Python's json accepts bare NaN/Infinity; neither can satisfy a bounded
        # contract, and NaN would slip past ordinary comparisons.
        for bad in (math.nan, math.inf, -math.inf):
            with self.subTest(value=bad):
                problems = validate(
                    {**CONFIG_DEFAULTS, "divergence_threshold": bad}, CONFIG
                )
                self.assertTrue(problems)

    def test_searxng_url_and_domain_pack_are_constrained(self):
        """R7 choice: constrain (non-empty pack id; http(s) scheme for SearXNG)."""
        for bad in ("localhost:8080", "ftp://host/", "  "):
            with self.subTest(value=bad):
                self.assertTrue(validate({"searxng_url": bad}, CONFIG))
        self.assertTrue(validate({"domain_pack": ""}, CONFIG))
        self.assertEqual(
            validate({"searxng_url": "https://searx.internal:8080"}, CONFIG), []
        )
        self.assertEqual(validate({"domain_pack": "biopharma"}, CONFIG), [])
        self.assertEqual(
            validate({"searxng_url": None, "domain_pack": None}, CONFIG), []
        )


class TestMcpConfigSurface(unittest.TestCase):
    """`iumbtems_config` accepts the full canonical key set, rejects garbage."""

    def _call(self, args):
        from runner.mcp_server import _handle_config

        return json.loads(_handle_config(args))

    def test_advertised_schema_parity_with_generated_artifact(self):
        """R2: compare against the GENERATED artifact, never the deepcopy source."""
        from runner.mcp_server import build_tools, config_tool_input_schema

        artifact_path = PROJECT_ROOT / "schemas" / "config.schema.json"
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        advertised = config_tool_input_schema()
        spec = next(t for t in build_tools() if t.name == "iumbtems_config")
        self.assertEqual(spec.input_schema, advertised)

        problems = []
        self._compare_properties(artifact, advertised, "", problems)
        self.assertEqual(problems, [])
        advertised_keys = set(advertised["properties"]) - CONTROL_ARGS
        self.assertEqual(advertised_keys, set(artifact["properties"]))
        # The artifact is the generated mirror of the canonical module.
        self.assertEqual(set(artifact["properties"]), set(CONFIG["properties"]))
        # R4: both spellings are advertised and documented.
        self.assertIn("expected_hash", advertised["properties"])
        self.assertIn("expectedHash", advertised["properties"])
        self.assertIn(
            "expected_hash",
            advertised["properties"]["expectedHash"]["description"],
        )

    def _compare_schema_node(self, sub, advertised_node, path, problems):
        """Deep-compare one schema node, recursing into subschemas.

        H1: besides the scalar keywords, `properties` recurses per key,
        `items` recurses as `{path}[]`, and `additionalProperties` recurses
        as `{path}.*`. A canonical subschema missing on the advertised side
        is a drift report, never a silent skip.
        """
        for keyword in COMPARE_KEYWORDS:
            if sub.get(keyword) != advertised_node.get(keyword):
                problems.append(
                    f"{path}: {keyword} {sub.get(keyword)!r} != "
                    f"{advertised_node.get(keyword)!r}"
                )
        if isinstance(sub.get("properties"), dict):
            if not isinstance(advertised_node.get("properties"), dict):
                problems.append(f"{path}: properties schema missing on advertised side")
            else:
                self._compare_properties(sub, advertised_node, f"{path}.", problems)
        for keyword, suffix in (("items", "[]"), ("additionalProperties", ".*")):
            sub_node = sub.get(keyword)
            if isinstance(sub_node, dict):
                adv_node = advertised_node.get(keyword)
                if not isinstance(adv_node, dict):
                    problems.append(
                        f"{path}{suffix}: {keyword} schema missing on advertised side"
                    )
                else:
                    self._compare_schema_node(
                        sub_node, adv_node, f"{path}{suffix}", problems
                    )

    def _compare_properties(self, canonical, advertised, path, problems):
        for key, sub in (canonical.get("properties") or {}).items():
            adv = (advertised.get("properties") or {}).get(key)
            if adv is None:
                problems.append(f"missing advertised key: {path}{key}")
                continue
            self._compare_schema_node(sub, adv, f"{path}{key}", problems)

    def test_parity_comparator_is_not_vacuous(self):
        """R2: the comparator must bite when the advertised surface drifts."""
        from runner.mcp_server import config_tool_input_schema

        artifact = json.loads(
            (PROJECT_ROOT / "schemas" / "config.schema.json").read_text(
                encoding="utf-8"
            )
        )
        dropped = config_tool_input_schema()
        dropped["properties"].pop("verify")
        problems = []
        self._compare_properties(artifact, dropped, "", problems)
        self.assertTrue(any("missing advertised key" in p for p in problems))

        drifted = config_tool_input_schema()
        drifted["properties"]["searxng_url"].pop("pattern")
        problems = []
        self._compare_properties(artifact, drifted, "", problems)
        self.assertTrue(any("searxng_url: pattern" in p for p in problems))

    def test_parity_comparator_catches_items_additionalProperties_default_drift(self):
        """H1: each newly walked keyword bites when the advertised side drifts.

        Every sub-case mutates a FRESH advertised schema exactly once, so a
        green sub-case proves its own keyword is compared (never vacuous via
        a shared broken fixture).
        """
        from runner.mcp_server import config_tool_input_schema

        artifact = json.loads(
            (PROJECT_ROOT / "schemas" / "config.schema.json").read_text(
                encoding="utf-8"
            )
        )

        def complained_of(mutator, needle):
            advertised = config_tool_input_schema()
            mutator(advertised["properties"])
            problems = []
            self._compare_properties(artifact, advertised, "", problems)
            self.assertTrue(
                any(needle in p for p in problems),
                f"{needle!r} not in {problems}",
            )

        # `items` drift: top-level (license_whitelist) and nested
        # (agents.alpha.backend); then a dropped `items` subschema.
        complained_of(
            lambda props: props["license_whitelist"].__setitem__(
                "items", {"type": "integer"}
            ),
            "license_whitelist[]: type",
        )
        complained_of(
            lambda props: props["agents"]["properties"]["alpha"]["properties"][
                "backend"
            ].__setitem__("items", {"type": "integer"}),
            "agents.alpha.backend[]: type",
        )
        complained_of(
            lambda props: props["license_whitelist"].pop("items"),
            "license_whitelist[]: items schema missing",
        )

        # `additionalProperties` drift (mcp_servers) and a dropped subschema.
        complained_of(
            lambda props: props["mcp_servers"].__setitem__(
                "additionalProperties", {"type": "string"}
            ),
            "mcp_servers.*: type",
        )
        complained_of(
            lambda props: props["mcp_servers"].pop("additionalProperties"),
            "mcp_servers.*: additionalProperties schema missing",
        )

        # `default` drift: top-level (mode) and nested
        # (verify.min_fuzzy_confidence); then a dropped `default`.
        complained_of(
            lambda props: props["mode"].__setitem__("default", "scout"),
            "mode: default",
        )
        complained_of(
            lambda props: props["verify"]["properties"][
                "min_fuzzy_confidence"
            ].__setitem__("default", 0.5),
            "verify.min_fuzzy_confidence: default",
        )
        complained_of(
            lambda props: props["mode"].pop("default"),
            "mode: default",
        )

    def test_valid_update_map_covers_every_canonical_key(self):
        self.assertEqual(set(VALID_UPDATES), set(CONFIG["properties"]))
        self.assertEqual(set(INVALID_UPDATES), set(CONFIG["properties"]))

    def test_every_canonical_key_is_accepted_and_persisted(self):
        for key, value in VALID_UPDATES.items():
            with self.subTest(key=key):
                with tempfile.TemporaryDirectory() as tmp:
                    payload = self._call({key: value, "base_dir": tmp})
                    self.assertEqual(payload["status"], "updated", payload)
                    on_disk = load_config(tmp)
                    if key == "agents":
                        # Deep-merge: the provided role wins, defaults survive.
                        self.assertEqual(
                            on_disk["agents"]["alpha"]["model"], "example/model"
                        )
                    else:
                        self.assertEqual(on_disk[key], value, key)

    def test_invalid_values_rejected_before_write(self):
        for key, value in INVALID_UPDATES.items():
            with self.subTest(key=key):
                with tempfile.TemporaryDirectory() as tmp:
                    payload = self._call({key: value, "base_dir": tmp})
                    self.assertEqual(payload["status"], "error", payload)
                    self.assertEqual(payload["code"], "CONFIG_VALIDATION_FAILED")
                    self.assertFalse(payload["written"])
                    self.assertTrue(payload["errors"])
                    self.assertFalse((Path(tmp) / "config.json").exists())

    def test_unknown_key_rejected_with_accepted_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = self._call({"not_a_key": 1, "base_dir": tmp})
            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["code"], "UNKNOWN_CONFIG_KEY")
            self.assertFalse(payload["written"])
            self.assertIn("not_a_key", payload["errors"][0])
            self.assertEqual(set(payload["accepted_keys"]), set(CONFIG["properties"]))
            self.assertFalse((Path(tmp) / "config.json").exists())

    def test_legacy_aliases_still_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = self._call({"engine": "firecrawl", "depth": 4, "base_dir": tmp})
            self.assertEqual(payload["status"], "updated")
            on_disk = load_config(tmp)
            self.assertEqual(on_disk["search_engine"], "firecrawl")
            self.assertEqual(on_disk["max_iterations"], 4)

    def test_show_path_is_unchanged_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = self._call({"base_dir": tmp})
            self.assertEqual(payload["status"], "current")
            self.assertFalse(payload["migrated"])
            self.assertEqual(payload["config"], load_config(tmp))
            self.assertFalse((Path(tmp) / "config.json").exists())
            shown = self._call({"base_dir": tmp, "show": True})
            self.assertEqual(shown["status"], "current")
            # R11: the legacy-pin case must NOT write (the old test was vacuous
            # here). Seed a pin, snapshot the bytes, and prove the show leg
            # leaves them byte-identical while still reporting the migration.
            cfg_file = _write_config(
                Path(tmp), {"agents": {"alpha": {"backend": ["claude", "-p"]}}}
            )
            before = cfg_file.read_bytes()
            pinned = self._call({"base_dir": tmp})
            self.assertEqual(pinned["status"], "current")
            self.assertTrue(pinned["migrated"])
            self.assertEqual(cfg_file.read_bytes(), before)

    def test_write_leg_heals_legacy_pin_and_persists(self):
        # R11 preserves phase-01 A6: a write still migrates the legacy pin on disk.
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(
                base, {"agents": {"alpha": {"backend": ["claude", "-p"]}}}
            )
            payload = self._call({"max_iterations": 2, "base_dir": tmp})
            self.assertEqual(payload["status"], "updated", payload)
            healed = json.loads(cfg_file.read_text(encoding="utf-8"))
            self.assertIsNone(healed["agents"]["alpha"]["backend"])
            self.assertEqual(healed["max_iterations"], 2)

    def test_guarded_write_on_legacy_pin_succeeds_and_heals(self):
        # F1/R12: the wizard always sends `expected_hash`. With no heal-before-
        # save, the guard still matches so the write is `updated` (never a false
        # `stale`) and the pin is migrated on disk.
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(
                base, {"agents": {"alpha": {"backend": ["claude", "-p"]}}}
            )
            start_hash = config_hash(tmp)
            payload = self._call(
                {"max_iterations": 3, "expected_hash": start_hash, "base_dir": tmp}
            )
            self.assertEqual(payload["status"], "updated", payload)
            healed = json.loads(cfg_file.read_text(encoding="utf-8"))
            self.assertIsNone(healed["agents"]["alpha"]["backend"])
            self.assertEqual(healed["max_iterations"], 3)

    def test_invalid_pin_file_show_reports_no_migration_and_write_blocked(self):
        # R12/R11: an invalid file is never healed, and a write that would leave
        # it invalid is rejected without touching the bytes.
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(
                base,
                {
                    "max_iterations": 99,
                    "agents": {"alpha": {"backend": ["claude", "-p"]}},
                },
            )
            before = cfg_file.read_bytes()
            shown = self._call({"base_dir": tmp})
            self.assertEqual(shown["status"], "current")
            self.assertFalse(shown["migrated"])
            self.assertEqual(cfg_file.read_bytes(), before)
            blocked = self._call({"mode": "audit", "base_dir": tmp})
            self.assertEqual(blocked["status"], "error")
            self.assertEqual(blocked["code"], "CONFIG_VALIDATION_FAILED")
            self.assertFalse(blocked["written"])
            self.assertEqual(cfg_file.read_bytes(), before)

    def test_null_clears_a_nullable_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._call({"searxng_url": "http://localhost:8080", "base_dir": tmp})
            payload = self._call({"searxng_url": None, "base_dir": tmp})
            self.assertEqual(payload["status"], "updated")
            self.assertIsNone(load_config(tmp)["searxng_url"])

    def test_searxng_url_scheme_and_domain_pack_nonempty_enforced(self):
        """R7 constraints are enforced before any write at the MCP surface."""
        with tempfile.TemporaryDirectory() as tmp:
            payload = self._call({"searxng_url": "localhost:8080", "base_dir": tmp})
            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["code"], "CONFIG_VALIDATION_FAILED")
            payload = self._call({"domain_pack": "", "base_dir": tmp})
            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["code"], "CONFIG_VALIDATION_FAILED")
            self.assertFalse((Path(tmp) / "config.json").exists())

    def test_stale_expected_hash_returns_snapshot_without_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            updated = self._call({"mode": "scout", "base_dir": tmp})
            stale = updated["hash"]
            self.assertEqual(len(stale), 64)
            # External writer lands a newer version.
            _write_config(Path(tmp), {"mode": "audit"})
            before = (Path(tmp) / "config.json").read_bytes()
            payload = self._call(
                {"mode": "research", "expected_hash": stale, "base_dir": tmp}
            )
            self.assertEqual(payload["status"], "stale")
            self.assertFalse(payload["written"])
            self.assertEqual(payload["expected_hash"], stale)
            self.assertEqual(payload["current_hash"], config_hash(tmp))
            self.assertEqual(payload["config"]["mode"], "audit")
            # R5: no absolute workspace path in the stale payload.
            self.assertNotIn("path", payload)
            self.assertEqual((Path(tmp) / "config.json").read_bytes(), before)

    def test_conflicting_expected_hash_spellings_are_rejected(self):
        """R4: never silently prefer one spelling over the other."""
        with tempfile.TemporaryDirectory() as tmp:
            created = self._call({"mode": "scout", "base_dir": tmp})
            live = created["hash"]
            before = (Path(tmp) / "config.json").read_bytes()
            payload = self._call(
                {
                    "mode": "research",
                    "expected_hash": live,
                    "expectedHash": "0" * 8,
                    "base_dir": tmp,
                }
            )
            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["code"], "CONFLICTING_EXPECTED_HASH")
            self.assertFalse(payload["written"])
            self.assertEqual((Path(tmp) / "config.json").read_bytes(), before)
            # Equal spellings are accepted and apply the guard.
            ok = self._call(
                {
                    "mode": "research",
                    "expected_hash": live,
                    "expectedHash": live,
                    "base_dir": tmp,
                }
            )
            self.assertEqual(ok["status"], "updated")

    def test_four_hex_expected_hash_is_rejected(self):
        """R4: minimum guard prefix is 8 hex chars."""
        with tempfile.TemporaryDirectory() as tmp:
            created = self._call({"mode": "scout", "base_dir": tmp})
            four_hex = created["hash"][:4]
            before = (Path(tmp) / "config.json").read_bytes()
            payload = self._call(
                {"mode": "research", "expected_hash": four_hex, "base_dir": tmp}
            )
            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["code"], "CONFIG_INVALID_EXPECTED_HASH")
            self.assertFalse(payload["written"])
            self.assertEqual((Path(tmp) / "config.json").read_bytes(), before)

    def test_null_for_non_nullable_keys_is_rejected(self):
        """R8: null is an explicit error, never a masked no-op."""
        for key in ("search_engine", "max_iterations", "agents", "verify"):
            with self.subTest(key=key):
                with tempfile.TemporaryDirectory() as tmp:
                    payload = self._call({key: None, "base_dir": tmp})
                    self.assertEqual(payload["status"], "error", payload)
                    self.assertEqual(payload["code"], "NULL_FOR_NON_NULLABLE_KEY")
                    self.assertFalse(payload["written"])
                    self.assertIn(key, payload["errors"][0])
                    self.assertIn("cache_ttl_days", payload["nullable_keys"])
                    self.assertNotIn(key, payload["nullable_keys"])
                    self.assertFalse((Path(tmp) / "config.json").exists())

    def test_invalid_file_is_not_healed_and_blocks_writes(self):
        """R1 at the MCP surface: a schema-rejected file is never persisted."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            cfg_file = _write_config(
                base,
                {
                    "max_iterations": 99,
                    "agents": {"alpha": {"backend": ["claude", "-p"]}},
                },
            )
            before = cfg_file.read_bytes()
            current = self._call({"base_dir": tmp})
            self.assertEqual(current["status"], "current")
            self.assertFalse(current["migrated"])
            self.assertEqual(cfg_file.read_bytes(), before)

            # One valid write fixes both the invalid value and the pin.
            fixed = self._call({"max_iterations": 2, "base_dir": tmp})
            self.assertEqual(fixed["status"], "updated")
            healed = json.loads(cfg_file.read_text(encoding="utf-8"))
            self.assertEqual(healed["max_iterations"], 2)
            self.assertIsNone(healed["agents"]["alpha"]["backend"])

    def test_updated_payload_is_single_read_coherent(self):
        """R10: `updated` config + hash come from ONE read of the written bytes.

        Regression against the pre-R10 shape (`load_config()` then
        `config_hash()` as two independent reads): a write landing between the
        two would pair an era-A config with an era-B hash. We inject exactly
        that write into `config_hash`; a single-read implementation never calls
        it, so the returned config/hash stay coherent with the bytes on disk.
        """
        import hashlib

        from skills.swarm_config import configure

        with tempfile.TemporaryDirectory() as tmp:
            original = configure.config_hash

            def torn(base):
                # Simulate a concurrent writer landing era-B between the old
                # shape's two reads, immediately before the hash read.
                cfg = Path(base) / "config.json"
                data = json.loads(cfg.read_text(encoding="utf-8"))
                data["mode"] = "audit"
                cfg.write_text(json.dumps(data), encoding="utf-8")
                return original(base)

            configure.config_hash = torn
            try:
                payload = self._call({"mode": "scout", "base_dir": tmp})
            finally:
                configure.config_hash = original

            self.assertEqual(payload["status"], "updated")
            written = (Path(tmp) / "config.json").read_bytes()
            # The hash covers the bytes the config was derived from ...
            self.assertEqual(payload["hash"], hashlib.sha256(written).hexdigest())
            # ... and the config is that same era (never scout + audit-hash).
            self.assertEqual(payload["config"]["mode"], json.loads(written)["mode"])
            self.assertEqual(payload["config"], load_config(tmp))

    def test_output_dir_deprecation_is_inert(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            elsewhere = base / "some-other-workspace"
            payload = self._call({"output_dir": str(elsewhere), "base_dir": str(base)})
            self.assertEqual(payload["status"], "updated")
            # The value persists for backward compatibility ...
            self.assertEqual(load_config(str(base))["output_dir"], str(elsewhere))
            # ... but nothing moves: the workspace is still base_dir.
            self.assertTrue((base / "config.json").exists())
            self.assertFalse(elsewhere.exists())


class TestVerifyThresholdConsumer(unittest.TestCase):
    """`verify.min_fuzzy_confidence` is a real parameter behind a real consumer."""

    @staticmethod
    def _seed(base: Path):
        hasher = SourceHasher(base)
        words = [f"w{i}" for i in range(1, 21)]
        content = " ".join(words)
        digest = hasher.store_source(url="https://example.test/q", content=content)
        # 9 of 10 quote words match a contiguous source window -> 0.90 overlap.
        quote = " ".join(words[:9]) + " nomatch"
        return digest, quote

    def _verify(self, base: Path, digest: str, quote: str):
        from runner.mcp_server import _handle_verify_quote

        return json.loads(
            _handle_verify_quote(
                {"hash": digest, "quote": quote, "base_dir": str(base)}
            )
        )

    def test_default_threshold_behavior_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            digest, quote = self._seed(base)
            payload = self._verify(base, digest, quote)
            # Byte-identical decision to the unconfigured hasher default.
            expected = SourceHasher(base).verify_quote(digest, quote)
            self.assertEqual(payload["verified"], expected[0])
            self.assertEqual(payload["confidence"], expected[1])
            self.assertEqual(payload["min_fuzzy_confidence"], 0.88)

    def test_configured_threshold_changes_the_decision(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            digest, quote = self._seed(base)
            self.assertTrue(self._verify(base, digest, quote)["verified"])

            from runner.mcp_server import _handle_config, _handle_verify_quote

            json.loads(
                _handle_config(
                    {
                        "verify": {"min_fuzzy_confidence": 0.95},
                        "base_dir": str(base),
                    }
                )
            )
            strict_payload = json.loads(
                _handle_verify_quote(
                    {"hash": digest, "quote": quote, "base_dir": str(base)}
                )
            )
            self.assertFalse(strict_payload["verified"])
            self.assertEqual(strict_payload["min_fuzzy_confidence"], 0.95)

            # Back to the default: the same quote verifies again.
            json.loads(
                _handle_config(
                    {
                        "verify": {"min_fuzzy_confidence": 0.88},
                        "base_dir": str(base),
                    }
                )
            )
            self.assertTrue(self._verify(base, digest, quote)["verified"])

    def test_unreachable_threshold_can_never_fabricate_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            digest, quote = self._seed(base)
            passed, _, _ = SourceHasher(base).verify_quote(
                digest, quote, min_fuzzy_confidence=1.5
            )
            self.assertFalse(passed)

    def test_verify_quote_clamps_the_threshold(self):
        """R6: the clamp lives in `verify_quote` (single enforcement point)."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            hasher = SourceHasher(base)
            words = [f"w{i}" for i in range(1, 21)]
            digest = hasher.store_source(
                url="https://example.test/c", content=" ".join(words)
            )
            # 3 of 4 quote words match a source window -> best overlap 0.75.
            partial = "w1 w2 w3 nomatch"
            self.assertFalse(hasher.verify_quote(digest, partial)[0])
            # Above 1.0 clamps down to 1.0: still no fabricated pass.
            self.assertFalse(
                hasher.verify_quote(digest, partial, min_fuzzy_confidence=1.5)[0]
            )
            # Below 0 clamps up to 0.0: a sub-default overlap then passes.
            self.assertTrue(
                hasher.verify_quote(digest, partial, min_fuzzy_confidence=-5)[0]
            )
            # Malformed values fall back to the strict default.
            self.assertFalse(
                hasher.verify_quote(digest, partial, min_fuzzy_confidence="high")[0]
            )


class TestAuditThresholdConsumer(unittest.TestCase):
    """The auditor (a real swarm consumer) honors the configured threshold."""

    def _engine(self, base, threshold):
        from runner.auditor_engine import EpistemicAuditorEngine

        return EpistemicAuditorEngine(
            base_dir=base, min_fuzzy_confidence=threshold, repo_validator=None
        )

    def test_auditor_rejects_at_a_stricter_threshold(self):
        from runner.state_machine import ResearchStateMachine

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            words = [f"w{i}" for i in range(1, 21)]
            hasher = SourceHasher(base)
            digest = hasher.store_source(
                url="https://example.test/a", content=" ".join(words)
            )
            quote = " ".join(words[:9]) + " nomatch"
            sm = ResearchStateMachine(base_dir=base)
            sm.init_session("objective", session_id="s1")
            sm.set_scopes([{"scope_id": "sc1", "title": "t", "objective": "o"}])
            dossier = {
                "scope_id": "sc1",
                "affirmative_claims": [
                    {
                        "claim_id": "C1",
                        "tag": "VERIFIED",
                        "statement": "s",
                        "source_hash": digest,
                        "verbatim_quote": quote,
                    }
                ],
            }
            sm.record_agent_completion("sc1", "alpha", dossier)
            sm.record_agent_completion("sc1", "beta", {"scope_id": "sc1"})

            lenient = self._engine(base, 0.88).audit_scope("sc1")
            self.assertEqual(lenient["summary"]["verified_passed"], 1)
            strict = self._engine(base, 0.95).audit_scope("sc1")
            self.assertEqual(strict["summary"]["verified_passed"], 0)
            self.assertEqual(strict["summary"]["unverified_rejected"], 1)


class TestDivergenceAdvisory(unittest.TestCase):
    """`divergence_threshold`: emitted only when non-default, never a decision.

    R3: default/absent threshold runs must stay byte-identical to before the key
    existed — no manifest field, no synthesis bullet, no banner line.
    """

    def _run(self, threshold):
        from runner.research_swarm import SwarmRunner

        tmp = tempfile.mkdtemp()
        base = Path(tmp) / ".research"
        base.mkdir(parents=True)
        if threshold is not None:
            _write_config(base, {"divergence_threshold": threshold})
        runner = SwarmRunner(base_dir=base, mock_mode=True, mode="research")
        buf = io.StringIO()
        with redirect_stdout(buf):
            runner.run_swarm("Evaluate hardware prover latency")
        manifest = runner.state_machine.load_global_manifest()
        audit = json.loads(
            (base / "scratchpads" / "scope_01_latency" / "audit_report.json").read_text(
                encoding="utf-8"
            )
        )
        report = (base / "final_synthesis.md").read_text(encoding="utf-8")
        return manifest, audit["summary"], report, buf.getvalue()

    def test_default_threshold_emits_nothing(self):
        for threshold in (None, 0.75):
            with self.subTest(threshold=threshold):
                manifest, _, report, output = self._run(threshold)
                self.assertNotIn("divergence_threshold", manifest)
                self.assertNotIn("Advisory Divergence Threshold", report)
                self.assertNotIn("Divergence threshold (advisory)", output)

    def test_configured_threshold_is_recorded_but_changes_no_decision(self):
        manifest_default, summary_default, report_default, out_default = self._run(None)
        manifest_custom, summary_custom, report_custom, out_custom = self._run(0.95)

        # Recorded in the manifest, the run summary, and the banner.
        self.assertEqual(manifest_custom["divergence_threshold"], 0.95)
        self.assertIn("Advisory Divergence Threshold", report_custom)
        self.assertIn("0.95", report_custom)
        self.assertIn("Divergence threshold (advisory): 0.95", out_custom)

        # No decision changed: the audit summaries are equal.
        self.assertEqual(summary_default, summary_custom)

        # Removing the (only) non-default bullet makes the reports identical
        # (modulo wall-clock stamps).
        stripped = "\n".join(
            line
            for line in report_custom.splitlines()
            if "Advisory Divergence Threshold" not in line
        )

        def _normalized(report):
            report = re.sub(r"`session-\d{8}-\d{6}`", "`session-<ts>`", report)
            return re.sub(r"`\d{4}-\d{2}-\d{2}T[^`]*`", "`<ts>`", report)

        self.assertEqual(_normalized(report_default), _normalized(stripped))


if __name__ == "__main__":
    unittest.main()
