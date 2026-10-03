#!/usr/bin/env python3
"""Tests for Phase 02-lsp-bridge: CLI-based JS/TS analysis behind the hook bus.

Mock-host only (no live TUI, no real Biome spawn): the analyzer is an
injected mock, every budget is tens of milliseconds, at most zero MCP
spawns. Pins: dirty-file advisory (findings + allowed:true), clean-file
empty, analyzer-missing skip (single audit entry, silent), never-deny
(severe findings still allow), audit-shape (tool/eventId keys on every
annotation), slow-overrun (timeout annotation, caller unblocked), and the
setup adopt/dispose wiring in plugins/opencode/index.js.

Phase evidence cited in-code per brief:
[VERIFIED: sha256:f2c0843b598ba6f19cc0e208f8d02e0250c70615e3c484474d50635d0b5cdef8]
[VERIFIED: sha256:640ab94a0408cef8cc14fb2cbf52f041021a1ce012590b41e8063075a21b2c8f]
[VERIFIED: sha256:69cacc4b62c2c1fccd5f5f3cf4d78398eb7310ceeb36e9ef423868e530771d90]
[VERIFIED: sha256:2b08ae78a2475e7d3b3427ba089542f8bd76635b87ab397066af8c0355651fbd]
[VERIFIED: sha256:7cbceba66852b3d8405d78833d0ce1dad7a25423af59cbacdea2790ba83e4b2a]
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


BRIDGE_IMPORT = (
    'import { createHookBus } from "./plugins/opencode/hook-bus.js";\n'
    'import { analyzePayload, createBridgeHandler, registerAnalysisBridge } from "./plugins/opencode/analysis-bridge.js";\n'
)

MOCK_TWO_FINDINGS = """
const runAnalyzer = async (files) => ({
  status: "ok",
  findings: [
    { rule: "lint/suspicious/noDebugger", file: files[0], line: 3, message: "Unexpected debugger statement.", severity: "error" },
    { rule: "lint/style/useConst", file: files[0], line: 1, message: "This let could be const.", severity: "warning" },
  ],
});
"""

SETUP_BRIDGE = """
const bus = createHookBus();
const notices = [];
const notify = (s) => { notices.push(s); };
const reg = await registerAnalysisBridge(null, { bus, runAnalyzer, notify, timeoutMs: 200 });
"""


class TestDirtyFileAdvisory(unittest.TestCase):
    def test_dirty_file_yields_findings_and_allows(self):
        res = run_node(
            BRIDGE_IMPORT
            + MOCK_TWO_FINDINGS
            + SETUP_BRIDGE
            + """
            const r = await bus.emit("pre-tool-use", {tool: "edit", eventId: "e-dirty", file: "src/app.ts"});
            const audit = bus.getAuditLog();
            const findingAudits = audit.filter((a) => a.event === "notification" && a.tool === "edit" && a.eventId === "e-dirty");
            console.log(JSON.stringify({
              allowed: r.allowed,
              notices: notices.length,
              notice: notices[0] && notices[0].message,
              findingAudits: findingAudits.length,
              reasons: findingAudits.map((a) => a.reason || ""),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"dirty advisory test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"], "dirty file must still allow (all-advisory)")
        self.assertEqual(data["notices"], 1, "exactly one toast summary per analysis")
        self.assertIn("2 finding", data["notice"])
        # Toast summarizes counts only: no rule ids, no finding text.
        self.assertNotIn("noDebugger", data["notice"])
        self.assertNotIn("debugger statement", data["notice"])
        self.assertEqual(
            data["findingAudits"], 2, "every finding audit-logged on the bus"
        )
        self.assertTrue(
            any("lint/suspicious/noDebugger" in reason for reason in data["reasons"]),
            "finding rule must ride in the audit entry reason",
        )
        self.assertTrue(
            any("lint/style/useConst" in reason for reason in data["reasons"]),
            "every finding rule must be audit-logged",
        )


class TestCleanFileEmpty(unittest.TestCase):
    def test_clean_file_no_annotations(self):
        res = run_node(
            BRIDGE_IMPORT
            + """
            const runAnalyzer = async () => ({status: "ok", findings: []});
            """
            + SETUP_BRIDGE
            + """
            const direct = await analyzePayload({tool: "edit", eventId: "e-clean", file: "src/ok.ts"}, {runAnalyzer, timeoutMs: 200});
            const r = await bus.emit("post-tool-use", {tool: "edit", eventId: "e-clean", file: "src/ok.ts"});
            console.log(JSON.stringify({
              allowed: direct.allowed, annotations: direct.annotations,
              emitAllowed: r.allowed, notices: notices.length,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"clean test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"])
        self.assertEqual(data["annotations"], [])
        self.assertTrue(data["emitAllowed"])
        self.assertEqual(data["notices"], 0, "clean file must not toast")


class TestAnalyzerMissingSkip(unittest.TestCase):
    def test_missing_analyzer_single_audit_silent_skip(self):
        res = run_node(
            BRIDGE_IMPORT
            + """
            const runAnalyzer = async () => ({status: "missing"});
            """
            + SETUP_BRIDGE
            + """
            const mark = bus.getAuditLog().length;
            let threw = false;
            let r = null;
            try {
              r = await bus.emit("pre-tool-use", {tool: "edit", eventId: "e-miss", file: "src/app.ts"});
            } catch { threw = true; }
            const fresh = bus.getAuditLog().slice(mark);
            console.log(JSON.stringify({
              threw, allowed: r && r.allowed,
              fresh: fresh.length,
              outcomes: fresh.map((a) => a.outcome),
              reasons: fresh.map((a) => a.reason || ""),
              notices: notices.length,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"missing test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["threw"], "analyzer-missing must never throw")
        self.assertTrue(data["allowed"], "analyzer-missing must fail open")
        self.assertEqual(data["fresh"], 1, "exactly one audit entry for the skip")
        self.assertEqual(data["outcomes"], ["allow"])
        self.assertTrue(any("analyzer" in reason for reason in data["reasons"]))
        self.assertEqual(
            data["notices"], 0, "missing analyzer must stay silent (no toast)"
        )


class TestNeverDeny(unittest.TestCase):
    def test_severe_findings_still_allow(self):
        res = run_node(
            BRIDGE_IMPORT
            + """
            const runAnalyzer = async (files) => ({
              status: "ok",
              findings: [
                { rule: "biome/critical-sev", file: files[0], line: 1, message: "catastrophic", severity: "error" },
                { rule: "biome/blocker", file: files[0], line: 2, message: "deny-shaped", severity: "error" },
              ],
            });
            const bus = createHookBus();
            const handler = createBridgeHandler(bus, {runAnalyzer, timeoutMs: 200});
            bus.on("pre-tool-use", handler, {tier: "fast", name: "analysis-bridge"});
            const direct = await handler({tool: "edit", eventId: "e-sev", file: "src/app.ts"});
            const r = await bus.emit("pre-commit", {tool: "edit", eventId: "e-sev", file: "src/app.ts"});
            const verdict = typeof direct === "string" ? direct : direct && direct.verdict;
            console.log(JSON.stringify({
              directAllowed: direct !== false && verdict !== "deny",
              verdict, emitAllowed: r.allowed,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"never-deny test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["directAllowed"], "bridge handler must never return deny")
        self.assertNotEqual(data["verdict"], "deny")
        self.assertNotEqual(data["verdict"], False)
        self.assertTrue(
            data["emitAllowed"], "severe findings must not block the caller"
        )


class TestAuditShape(unittest.TestCase):
    def test_every_annotation_carries_required_keys(self):
        res = run_node(
            BRIDGE_IMPORT
            + MOCK_TWO_FINDINGS
            + """
            const direct = await analyzePayload(
              {tool: "edit", eventId: "e-shape", file: "src/app.ts"},
              {runAnalyzer, timeoutMs: 200},
            );
            const keys = direct.annotations.map((a) => Object.keys(a).sort());
            const bus2 = createHookBus();
            await registerAnalysisBridge(null, {bus: bus2, runAnalyzer, notify: () => {}, timeoutMs: 200});
            await bus2.emit("pre-tool-use", {tool: "edit", eventId: "e-shape", file: "src/app.ts"});
            const records = bus2.getAuditLog().filter((a) => a.event === "notification");
            console.log(JSON.stringify({
              allowed: direct.allowed, keys,
              annotations: direct.annotations,
              recordKeys: records.map((a) => Object.keys(a).sort()),
              recordTools: records.map((a) => [a.tool, a.eventId]),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"audit-shape test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"])
        required = {"tool", "eventId", "rule", "file", "line", "message", "severity"}
        self.assertEqual(len(data["annotations"]), 2)
        for key_set in data["keys"]:
            self.assertTrue(
                required.issubset(set(key_set)),
                f"annotation missing keys: {required - set(key_set)}",
            )
        for ann in data["annotations"]:
            self.assertEqual(ann["tool"], "edit")
            self.assertEqual(ann["eventId"], "e-shape")
        self.assertEqual(len(data["recordKeys"]), 2, "both findings audit-logged")
        for key_set in data["recordKeys"]:
            self.assertIn("tool", key_set)
            self.assertIn("eventId", key_set)
        for tool, event_id in data["recordTools"]:
            self.assertEqual(tool, "edit")
            self.assertEqual(event_id, "e-shape")


class TestSlowOverrun(unittest.TestCase):
    def test_overrun_degrades_to_timeout_caller_unblocked(self):
        res = run_node(
            BRIDGE_IMPORT
            + """
            const runAnalyzer = () => new Promise(() => {});
            const t0 = Date.now();
            const direct = await analyzePayload(
              {tool: "edit", eventId: "e-slow", file: "src/app.ts"},
              {runAnalyzer, timeoutMs: 60},
            );
            const elapsed = Date.now() - t0;
            const bus2 = createHookBus();
            const handler = createBridgeHandler(bus2, {runAnalyzer, timeoutMs: 60, notify: () => {}});
            bus2.on("pre-tool-use", handler, {tier: "fast", name: "analysis-bridge"});
            const t1 = Date.now();
            const r = await bus2.emit("pre-tool-use", {tool: "edit", eventId: "e-slow2", file: "src/app.ts"}, {fastTimeoutMs: 300});
            const emitElapsed = Date.now() - t1;
            console.log(JSON.stringify({
              allowed: direct.allowed, elapsed,
              rules: direct.annotations.map((a) => a.rule),
              keys: direct.annotations.length ? Object.keys(direct.annotations[0]).sort() : [],
              emitAllowed: r.allowed, emitElapsed,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"overrun test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"], "overrun must fail open")
        self.assertLess(
            data["elapsed"], 2000, "analyzer overrun must resolve near the fast budget"
        )
        self.assertEqual(data["rules"], ["analysis-bridge/timeout"])
        self.assertTrue(
            {"tool", "eventId", "rule", "file", "line", "message", "severity"}.issubset(
                set(data["keys"])
            )
        )
        self.assertTrue(data["emitAllowed"], "bus caller stays unblocked on overrun")
        self.assertLess(data["emitElapsed"], 2000)


class TestSetupAdoptsBridge(unittest.TestCase):
    def test_setup_adopts_and_disposes_bridge(self):
        res = run_node(
            """
            import plugin, { hookBus } from "./plugins/opencode/index.js";
            const before = {
              pre: hookBus.handlerCount("pre-tool-use"),
              post: hookBus.handlerCount("post-tool-use"),
              commit: hookBus.handlerCount("pre-commit"),
            };
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
            const after = {
              pre: hookBus.handlerCount("pre-tool-use"),
              post: hookBus.handlerCount("post-tool-use"),
              commit: hookBus.handlerCount("pre-commit"),
            };
            const attached = !!host.iumbtemsAnalysisBridge;
            await cleanup();
            const closed = {
              pre: hookBus.handlerCount("pre-tool-use"),
              post: hookBus.handlerCount("post-tool-use"),
              commit: hookBus.handlerCount("pre-commit"),
            };
            console.log(JSON.stringify({before, after, attached, closed}));
            """
        )
        self.assertEqual(res.returncode, 0, f"adopt test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["attached"], "bridge must be adopted on setup")
        self.assertGreater(
            data["after"]["pre"],
            data["before"]["pre"],
            "pre-tool-use bridge handler subscribed",
        )
        self.assertGreater(
            data["after"]["post"],
            data["before"]["post"],
            "post-tool-use bridge handler subscribed",
        )
        self.assertGreater(
            data["after"]["commit"],
            data["before"]["commit"],
            "pre-commit bridge handler subscribed",
        )
        self.assertEqual(
            data["closed"], data["before"], "cleanup must dispose bridge subscriptions"
        )


if __name__ == "__main__":
    unittest.main()
