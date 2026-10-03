#!/usr/bin/env python3
"""Tests for Phase 04-coverage-treeshake-signals: coverage deltas + bundle weight.

Mock-host only (no live TUI, no real esbuild spawn unless noted): every build
is an injected mock or a precomputed metafile, every budget is tens of
milliseconds, at most zero MCP spawns. Pins: blowup-still-allows (+500%
fixture), missing-esbuild unavailable-skip, malformed-metafile tolerated,
annotation key completeness (always-present keys on both record shapes),
delta math (up/down/flat/unknown), stale-baseline annotates-without-blocking,
and the setup adopt/dispose wiring in plugins/opencode/index.js.

Phase evidence cited in-code per brief:
[VERIFIED: sha256:f42787d2ce436bbd6d55e90a15d45b656290a1a44451fff3318b094a4582ce01]
[VERIFIED: sha256:f2c0843b598ba6f19cc0e208f8d02e0250c70615e3c484474d50635d0b5cdef8]
[VERIFIED: sha256:cd66253fec923d8210d2863f98d9c5669662ac70c3a1939f2bd8ea30ed007644]
[VERIFIED: sha256:da194d498bc256f2b619c406015a3fb600712ec5b8c8ab9001fc38f0a6f5c8cc]
[VERIFIED: sha256:7690b878a654ee4dee2b649b60740bc95d4b746cf786051887153b6f656f2e5e]
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def run_node(code):
    return subprocess.run(
        ["node", "--input-type=module", "-e", code],
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
    )


def last_json_object(stdout):
    lines = [
        line.strip()
        for line in stdout.strip().split("\n")
        if line.strip().startswith("{")
    ]
    return json.loads(lines[-1])


WEIGHT_IMPORT = (
    'import { createHookBus } from "./plugins/opencode/hook-bus.js";\n'
    "import { measureBundle, coverageDelta, parseMetafile, isBaselineStale, loadBaseline,"
    " createWeightSignalsHandler, registerWeightSignals, toWeightRecord, toCoverageRecord,"
    ' WEIGHT_RECORD_KEYS, COVERAGE_RECORD_KEYS } from "./plugins/opencode/weight-signals.js";\n'
)

# Metafile fixture builder: outputs sum to totalBytes over two outputs.
META_BUILDER = """
const meta = (totalBytes) => ({
  inputs: {
    "plugins/opencode/index.js": { bytes: Math.floor(totalBytes / 2), imports: [] },
    "plugins/opencode/hook-bus.js": { bytes: totalBytes - Math.floor(totalBytes / 2), imports: [] },
  },
  outputs: {
    "out/bundle.js": { bytes: Math.floor(totalBytes / 2), inputs: {} },
    "out/bundle2.js": { bytes: totalBytes - Math.floor(totalBytes / 2), inputs: {} },
  },
});
const freshBaseline = (bytes) => ({ bytes, measuredAt: new Date().toISOString() });
const staleBaseline = (bytes) => ({ bytes, measuredAt: "2020-01-01T00:00:00.000Z" });
"""

SETUP_WEIGHT = """
const bus = createHookBus();
const notices = [];
const notify = (s) => { notices.push(s); };
"""


class TestNeverBlocks(unittest.TestCase):
    def test_plus_500pct_blowup_still_allows(self):
        res = run_node(
            WEIGHT_IMPORT
            + META_BUILDER
            + SETUP_WEIGHT
            + """
            const reg = await registerWeightSignals(null, {
              bus, metafile: meta(6000), baseline: freshBaseline(1000),
              notify, timeoutMs: 200,
            });
            const direct = await measureBundle({ metafile: meta(6000), baseline: freshBaseline(1000) });
            const rec = direct.annotations[0];
            const flat = JSON.stringify(direct);
            let threw = false;
            let r = null;
            try {
              r = await bus.emit("pre-commit", {tool: "edit", eventId: "e-blowup"});
            } catch { threw = true; }
            console.log(JSON.stringify({
              threw,
              allowed: direct.allowed,
              hasDeny: flat.includes("deny"),
              emitAllowed: r && r.allowed,
              bytes: rec.bytes,
              deltaBytes: rec.deltaVsBaseline && rec.deltaVsBaseline.bytes,
              deltaPct: rec.deltaVsBaseline && rec.deltaVsBaseline.pct,
              notices: notices.length,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"never-blocks test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["threw"], "blowup must never throw")
        self.assertTrue(
            data["allowed"], "+500% blowup must still allow (advisory-only)"
        )
        self.assertFalse(data["hasDeny"], "no deny verdict anywhere in the result")
        self.assertTrue(data["emitAllowed"], "bus emit must allow on blowup")
        self.assertEqual(data["bytes"], 6000)
        self.assertEqual(data["deltaBytes"], 5000)
        self.assertEqual(data["deltaPct"], 500.0)
        self.assertEqual(data["notices"], 1, "exactly one counts-only toast")


class TestMissingEsbuild(unittest.TestCase):
    def test_missing_esbuild_unavailable_skip(self):
        res = run_node(
            WEIGHT_IMPORT
            + SETUP_WEIGHT
            + """
            const runBuild = async () => ({ status: "missing" });
            const reg = await registerWeightSignals(null, { bus, runBuild, notify, timeoutMs: 200 });
            const mark = bus.getAuditLog().length;
            let threw = false;
            let r = null;
            try {
              r = await bus.emit("pre-commit", {tool: "edit", eventId: "e-miss"});
            } catch { threw = true; }
            const fresh = bus.getAuditLog().slice(mark);
            const direct = await measureBundle({ runBuild });
            console.log(JSON.stringify({
              threw, allowed: r && r.allowed,
              status: direct.annotations[0].status,
              keys: Object.keys(direct.annotations[0]).sort(),
              auditEntries: fresh.length,
              notices: notices.length,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"missing test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["threw"], "missing esbuild must never throw")
        self.assertTrue(data["allowed"], "missing esbuild must fail open")
        self.assertEqual(data["status"], "unavailable")
        self.assertGreaterEqual(
            data["auditEntries"], 1, "unavailable entry must be audit-logged"
        )


class TestMalformedMetafile(unittest.TestCase):
    def test_malformed_variants_tolerated(self):
        res = run_node(
            WEIGHT_IMPORT
            + """
            const variants = [
              "garbage-string", null, 42, [], {},
              { inputs: {}, outputs: 42 },
              { inputs: {}, outputs: {} },
              { inputs: {}, outputs: { "o.js": { bytes: "nan" } } },
            ];
            const out = [];
            for (const m of variants) {
              let threw = false;
              let rec = null;
              try {
                const r = await measureBundle({ metafile: m === null ? { outputs: null } : m });
                rec = r.annotations[0];
                out.push({ allowed: r.allowed, status: rec && rec.status });
              } catch { threw = true; out.push({ threw: true }); }
            }
            const parsed = parseMetafile("nope");
            console.log(JSON.stringify({ out, parsedStatus: parsed.status }));
            """
        )
        self.assertEqual(res.returncode, 0, f"malformed test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        for entry in data["out"]:
            self.assertFalse(
                entry.get("threw", False), "malformed metafile must never throw"
            )
            self.assertTrue(entry["allowed"], "malformed metafile must fail open")
            self.assertEqual(entry["status"], "unavailable")
        self.assertEqual(data["parsedStatus"], "malformed")


class TestKeyCompleteness(unittest.TestCase):
    def test_every_record_carries_complete_keys(self):
        res = run_node(
            WEIGHT_IMPORT
            + META_BUILDER
            + """
            const scanned = toWeightRecord({
              tool: "edit", eventId: "e1", status: "scanned", entry: "x.js",
              bytes: 10, files: 1, topHeaviest: [{file: "x.js", bytes: 10}],
              deltaVsBaseline: {bytes: 1, pct: 10}, baselineStale: false, message: "m",
            });
            const bare = toWeightRecord({});
            const cov = toCoverageRecord({
              tool: "edit", eventId: "e2", scope: "s",
              passedBefore: 1, totalBefore: 2, passedAfter: 2, totalAfter: 2, message: "m",
            });
            const covBare = toCoverageRecord({});
            const cd = coverageDelta({ before: {passed: 1, total: 2}, after: {passed: 2, total: 2}, scope: "s" });
            console.log(JSON.stringify({
              weightKeys: Object.keys(scanned).sort(),
              bareKeys: Object.keys(bare).sort(),
              covKeys: Object.keys(cov).sort(),
              covBareKeys: Object.keys(covBare).sort(),
              expectedWeight: [...WEIGHT_RECORD_KEYS].sort(),
              expectedCov: [...COVERAGE_RECORD_KEYS].sort(),
              cdKeys: Object.keys(cd).sort(),
              cdDelta: cd.delta, cdDirection: cd.direction, cdAllowed: cd.allowed,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"keys test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["weightKeys"], data["expectedWeight"])
        self.assertEqual(
            data["bareKeys"], data["expectedWeight"], "no silent drops on empty input"
        )
        self.assertEqual(data["covKeys"], data["expectedCov"])
        self.assertEqual(data["covBareKeys"], data["expectedCov"])
        self.assertIn("delta", data["cdKeys"])
        self.assertIn("direction", data["cdKeys"])
        self.assertTrue(data["cdAllowed"])


class TestDeltaMath(unittest.TestCase):
    def test_up_down_flat_unknown(self):
        res = run_node(
            WEIGHT_IMPORT
            + """
            const up = coverageDelta({ before: {passed: 80, total: 100}, after: {passed: 90, total: 100}, scope: "s" });
            const down = coverageDelta({ before: {passed: 90, total: 100}, after: {passed: 70, total: 100}, scope: "s" });
            const flat = coverageDelta({ before: {passed: 80, total: 100}, after: {passed: 80, total: 100}, scope: "s" });
            const empty = coverageDelta({ before: {passed: 0, total: 0}, after: {passed: 0, total: 0}, scope: "s" });
            const missing = coverageDelta({});
            console.log(JSON.stringify({
              up: [up.delta, up.direction], down: [down.delta, down.direction],
              flat: [flat.delta, flat.direction],
              empty: [empty.delta, empty.direction, empty.record.status],
              missing: [missing.delta, missing.direction, missing.record.status],
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"delta test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["up"], [10.0, "up"])
        self.assertEqual(data["down"], [-20.0, "down"])
        self.assertEqual(data["flat"], [0.0, "flat"])
        self.assertEqual(data["empty"][1], "unknown")
        self.assertEqual(data["empty"][2], "unavailable")
        self.assertEqual(data["missing"][1], "unknown")


class TestStaleBaseline(unittest.TestCase):
    def test_stale_baseline_annotates_without_blocking(self):
        res = run_node(
            WEIGHT_IMPORT
            + META_BUILDER
            + SETUP_WEIGHT
            + """
            const reg = await registerWeightSignals(null, {
              bus, metafile: meta(1100), baseline: staleBaseline(1000),
              notify, timeoutMs: 200,
            });
            const stale = await measureBundle({ metafile: meta(1100), baseline: staleBaseline(1000) });
            const fresh = await measureBundle({ metafile: meta(1100), baseline: freshBaseline(1000) });
            let threw = false;
            let r = null;
            try {
              r = await bus.emit("pre-commit", {tool: "edit", eventId: "e-stale"});
            } catch { threw = true; }
            const staleNote = stale.annotations.find((a) => a.baselineStale && a.bytes === null);
            console.log(JSON.stringify({
              threw,
              allowed: stale.allowed,
              emitAllowed: r && r.allowed,
              count: stale.annotations.length,
              firstStale: stale.annotations[0].baselineStale,
              deltaBytes: stale.annotations[0].deltaVsBaseline.bytes,
              hasStaleNote: !!staleNote,
              staleMsg: staleNote && staleNote.message,
              freshCount: fresh.annotations.length,
              freshStale: fresh.annotations[0].baselineStale,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"stale test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["threw"])
        self.assertTrue(data["allowed"], "stale baseline must still allow")
        self.assertTrue(data["emitAllowed"])
        self.assertEqual(
            data["count"], 2, "stale baseline appends a stale-baseline annotation"
        )
        self.assertTrue(data["firstStale"])
        self.assertEqual(
            data["deltaBytes"], 100, "deltas still compute against a stale baseline"
        )
        self.assertTrue(data["hasStaleNote"])
        self.assertIn("stale-baseline", data["staleMsg"])
        self.assertIn("user-confirmed", data["staleMsg"])
        self.assertEqual(data["freshCount"], 1, "fresh baseline adds no stale note")
        self.assertFalse(data["freshStale"])


class TestSetupAdoptsWeightSignals(unittest.TestCase):
    def test_setup_adopts_and_disposes_weight_signals(self):
        res = run_node(
            """
            import plugin, { hookBus } from "./plugins/opencode/index.js";
            const before = hookBus.handlerCount("pre-commit");
            const host = {
              options: {},
              command: {
                list: async () => ({data: []}),
                transform: async (fn) => { fn({add: () => {}}); return {dispose: async () => {}}; }
              },
              tool: {
                transform: async (fn) => { fn({add: () => {}}); return {dispose: async () => {}}; }
              },
              session: { prompt: async () => ({}) }
            };
            const cleanup = await plugin.setup(host);
            const after = hookBus.handlerCount("pre-commit");
            const attached = !!host.iumbtemsWeightSignals;
            const events = host.iumbtemsWeightSignals && host.iumbtemsWeightSignals.events;
            await cleanup();
            const closed = hookBus.handlerCount("pre-commit");
            console.log(JSON.stringify({before, after, attached, events, closed}));
            """
        )
        self.assertEqual(res.returncode, 0, f"adopt test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["attached"], "weight-signals must be adopted on setup")
        self.assertEqual(data["events"], ["pre-commit"])
        self.assertGreater(
            data["after"],
            data["before"],
            "pre-commit weight-signals handler subscribed",
        )
        self.assertEqual(
            data["closed"],
            data["before"],
            "cleanup must dispose weight-signals subscriptions",
        )


class TestTamperedBaseline(unittest.TestCase):
    def test_corrupted_baseline_variants_fail_open_without_crash(self):
        res = run_node(
            WEIGHT_IMPORT
            + META_BUILDER
            + """
            const variants = [
              "{not valid json",
              "[]",
              JSON.stringify({ bytes: "not-a-number", measuredAt: "invalid-date" }),
              JSON.stringify({ bytes: null }),
              JSON.stringify({}),
            ];
            const results = [];
            for (const text of variants) {
              let threw = false;
              let direct = null;
              try {
                direct = await measureBundle({ metafile: meta(1000), baselineText: text });
              } catch { threw = true; }
              results.push({
                threw,
                allowed: direct && direct.allowed,
                status: direct && direct.annotations[0] && direct.annotations[0].status,
                delta: direct && direct.annotations[0] && direct.annotations[0].deltaVsBaseline,
              });
            }
            console.log(JSON.stringify({ results }));
            """
        )
        self.assertEqual(res.returncode, 0, f"tampered baseline test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        for r in data["results"]:
            self.assertFalse(r["threw"], "tampered baseline must never throw")
            self.assertTrue(r["allowed"], "tampered baseline must fail open")
            self.assertEqual(r["status"], "scanned")
            self.assertIsNone(r["delta"], "corrupted baseline yields null delta")


if __name__ == "__main__":
    unittest.main()

