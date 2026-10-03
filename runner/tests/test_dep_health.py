#!/usr/bin/env python3
"""Tests for Phase 03-dep-health-gate: programmer-time dep warnings + QA gate.

Mock-host only (no live TUI, no real npm/OSV): every runner is injected,
every budget is tens of milliseconds, at most zero MCP spawns. Pins:
never-blocks (critical-CVE fixture still allows), offline-unavailable-recorded,
absent-pass, missing-report-fail, unrecorded-findings-fail, annotation key
completeness (eleven always-present keys), OSV timeout bound, the repo
baseline shape (npm scanned, pip absent, 2x :latest advisories, actions
clean), and the setup adopt/dispose wiring in plugins/opencode/index.js.

Phase evidence cited in-code per brief:
[VERIFIED: sha256:7690b878a654ee4dee2b649b60740bc95d4b746cf786051887153b6f656f2e5e]
[VERIFIED: sha256:1fd0c2b8b0d37d553f1f841cea4e4b60d92cdf873257172a726d482954dddf8f]
[VERIFIED: sha256:7b62111192e07c73547a125eeab7ff98f2d1305a04149f1ab51c66a41a3e3f95]
[VERIFIED: sha256:c381a646894ce66669432e847f0afd647ea5ff00ac64a01cf91f325f5515e601]
[VERIFIED: sha256:ae16788a0a85caed3983dbc70455eaa05857827c837a5f5999242ef32b0a16a7]
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


DEP_IMPORT = (
    'import { createHookBus } from "./plugins/opencode/hook-bus.js";\n'
    'import { checkDeps, depHealthCoverage, createDepHealthHandler, registerDepHealth, toDepFinding } from "./plugins/opencode/dep-health.js";\n'
)

MOCK_CLEAN_RUNNERS = """
const runOutdated = async () => ({status: "ok", json: {}});
const runAudit = async () => ({status: "ok", json: {advisories: {}}});
const queryOsv = async () => ({status: "ok", vulns: []});
"""

MOCK_CRITICAL_RUNNERS = """
const runOutdated = async () => ({status: "ok", json: {
  "left-pad": {current: "1.0.0", wanted: "1.3.0", latest: "1.3.0"},
}});
const runAudit = async () => ({status: "ok", json: {vulnerabilities: {
  "left-pad": {severity: "critical", range: "1.0.0", fixAvailable: "1.3.0",
    via: [{title: "CVE-2099-0001 prototype pollution", url: "https://example.invalid/cve"}]},
}}});
const queryOsv = async () => ({status: "ok", vulns: [
  {id: "GHSA-xxxx-yyyy", summary: "critical RCE",
   affected: [{ranges: [{events: [{introduced: "0"}, {fixed: "2.0.0"}]}]}]},
]});
"""

MOCK_OFFLINE_RUNNERS = """
const runOutdated = async () => { throw new Error("ENOTFOUND registry.npmjs.org"); };
const runAudit = async () => ({status: "error", message: "EAI_AGAIN"});
const queryOsv = async () => ({status: "error", message: "fetch failed"});
"""

SETUP_DEP = """
const bus = createHookBus();
const notices = [];
const notify = (s) => { notices.push(s); };
const reg = await registerDepHealth(null, { bus, runOutdated, runAudit, queryOsv, notify, osvTimeoutMs: 200 });
"""


class TestNeverBlocks(unittest.TestCase):
    def test_critical_fixture_still_allows(self):
        res = run_node(
            DEP_IMPORT
            + MOCK_CRITICAL_RUNNERS
            + SETUP_DEP
            + """
            const manifests = { packageJson: JSON.stringify({dependencies: {"left-pad": "1.0.0"}}) };
            const direct = await checkDeps({ manifests, runOutdated, runAudit, queryOsv, osvTimeoutMs: 200, tool: "edit", eventId: "e-crit" });
            const flat = JSON.stringify(direct);
            const r = await bus.emit("pre-tool-use", {tool: "edit", eventId: "e-crit"});
            const audit = bus.getAuditLog();
            const findingAudits = audit.filter((a) => a.tool === "edit" && a.eventId === "e-crit");
            console.log(JSON.stringify({
              allowed: direct.allowed,
              hasDeny: flat.includes("deny"),
              npmStatus: direct.ecosystems.npm.status,
              severities: direct.ecosystems.npm.findings.map((f) => f.severity),
              emitAllowed: r.allowed,
              notices: notices.length,
              notice: notices[0] && notices[0].message,
              findingAudits: findingAudits.length,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"never-blocks test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"], "critical CVE must still allow (all-advisory)")
        self.assertFalse(data["hasDeny"], "no deny verdict anywhere in the result")
        self.assertEqual(data["npmStatus"], "scanned")
        self.assertIn(
            "critical", data["severities"], "critical severity must be recorded"
        )
        self.assertTrue(
            data["emitAllowed"], "critical findings must not block the caller"
        )
        self.assertEqual(data["notices"], 1, "exactly one toast summary per scan")
        self.assertIn("finding", data["notice"])
        # Toast summarizes counts only: no package names, no CVE text.
        self.assertNotIn("left-pad", data["notice"])
        self.assertNotIn("CVE-2099-0001", data["notice"])
        self.assertGreaterEqual(
            data["findingAudits"], 2, "findings must be audit-logged on the bus"
        )


class TestOfflineUnavailable(unittest.TestCase):
    def test_offline_records_unavailable_and_allows(self):
        res = run_node(
            DEP_IMPORT
            + MOCK_OFFLINE_RUNNERS
            + SETUP_DEP
            + """
            const manifests = { packageJson: JSON.stringify({dependencies: {"left-pad": "1.0.0"}}) };
            let threw = false;
            let direct = null;
            try {
              direct = await checkDeps({ manifests, runOutdated, runAudit, queryOsv, osvTimeoutMs: 200 });
            } catch { threw = true; }
            let r = null;
            try {
              r = await bus.emit("pre-tool-use", {tool: "edit", eventId: "e-off"});
            } catch { threw = true; }
            console.log(JSON.stringify({
              threw, allowed: direct && direct.allowed,
              npmStatus: direct && direct.ecosystems.npm.status,
              recorded: direct && direct.ecosystems.npm.findings.length,
              sources: direct && direct.ecosystems.npm.findings.map((f) => f.source),
              emitAllowed: r && r.allowed,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"offline test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["threw"], "offline run must never throw")
        self.assertTrue(data["allowed"], "offline run must fail open")
        self.assertEqual(data["npmStatus"], "unavailable")
        self.assertGreaterEqual(data["recorded"], 1, "unavailability must be RECORDED")
        self.assertIn("unavailable", data["sources"])
        self.assertTrue(data["emitAllowed"])
        # The recorded outage passes the mechanical gate.
        res2 = run_node(
            DEP_IMPORT
            + """
            const cov = depHealthCoverage({
              npm: {status: "unavailable", findings: [{ecosystem: "npm", source: "unavailable"}]},
              pip: {status: "absent", findings: []},
              containers: {status: "absent", findings: []},
              actions: {status: "absent", findings: []},
            });
            console.log(JSON.stringify({pass: cov.pass, fails: cov.gaps.filter((g) => g.fail)}));
            """
        )
        self.assertEqual(res2.returncode, 0, f"gate test failed: {res2.stderr}")
        data2 = last_json_object(res2.stdout)
        self.assertTrue(data2["pass"], "unavailable(recorded) must pass the gate")
        self.assertEqual(data2["fails"], [])


class TestCoverageMatrix(unittest.TestCase):
    def test_matrix(self):
        res = run_node(
            DEP_IMPORT
            + """
            const scanned = depHealthCoverage({
              npm: {status: "scanned", findings: []},
              pip: {status: "absent", findings: []},
              containers: {status: "scanned", findings: [{ecosystem: "containers"}]},
              actions: {status: "scanned", findings: []},
            });
            const absentNote = depHealthCoverage({
              npm: {status: "scanned", findings: []},
              pip: {status: "absent", findings: []},
              containers: {status: "absent", findings: []},
              actions: {status: "absent", findings: []},
            });
            const missing = depHealthCoverage({npm: {status: "scanned", findings: []}});
            const unrecorded = depHealthCoverage({
              npm: {status: "scanned"},
              pip: {status: "absent", findings: []},
              containers: {status: "absent", findings: []},
              actions: {status: "absent", findings: []},
            });
            const unrecordedFlag = depHealthCoverage({
              npm: {status: "scanned", findings: [], recorded: false},
              pip: {status: "absent", findings: []},
              containers: {status: "absent", findings: []},
              actions: {status: "absent", findings: []},
            });
            const emptyUnavailable = depHealthCoverage({
              npm: {status: "unavailable", findings: []},
              pip: {status: "absent", findings: []},
              containers: {status: "absent", findings: []},
              actions: {status: "absent", findings: []},
            });
            console.log(JSON.stringify({
              scannedPass: scanned.pass, scannedGaps: scanned.gaps,
              absentPass: absentNote.pass,
              absentNotes: absentNote.gaps.filter((g) => !g.fail).length,
              missingPass: missing.pass,
              missingFails: missing.gaps.filter((g) => g.fail).map((g) => g.ecosystem),
              unrecordedPass: unrecorded.pass,
              flagPass: unrecordedFlag.pass,
              emptyUnavailablePass: emptyUnavailable.pass,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"matrix test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["scannedPass"], "scanned/clean must pass")
        self.assertEqual(
            [g for g in data["scannedGaps"] if g["fail"]],
            [],
            "scanned/clean must carry no failing gaps",
        )
        self.assertTrue(data["absentPass"], "absent must pass-with-note")
        self.assertGreaterEqual(data["absentNotes"], 1, "absent must leave a note")
        self.assertFalse(data["missingPass"], "missing report must fail")
        self.assertEqual(
            set(data["missingFails"]),
            {"pip", "containers", "actions"},
            "every missing ecosystem must be named",
        )
        self.assertFalse(data["unrecordedPass"], "unrecorded findings must fail")
        self.assertFalse(data["flagPass"], "recorded:false must fail")
        self.assertFalse(
            data["emptyUnavailablePass"],
            "unavailable with zero entries is unrecorded and must fail",
        )


class TestAnnotationKeys(unittest.TestCase):
    def test_every_finding_key_always_present(self):
        res = run_node(
            DEP_IMPORT
            + """
            const bare = toDepFinding({});
            const full = toDepFinding({tool: "edit", eventId: "e-k", ecosystem: "pip",
              package: "requests", installed: "2.0", wanted: "2.1", latest: "2.2",
              severity: "HIGH", advisory: "CVE-x", fixedIn: "2.1", source: "osv.dev"});
            const direct = await checkDeps({
              manifests: {packageJson: JSON.stringify({dependencies: {a: "1.0.0"}})},
              runOutdated: async () => ({status: "ok", json: {}}),
              runAudit: async () => ({status: "ok", json: {}}),
              queryOsv: async () => ({status: "error", message: "down"}),
              osvTimeoutMs: 200,
            });
            console.log(JSON.stringify({
              bareKeys: Object.keys(bare).sort(),
              fullSeverity: full.severity,
              npmKeys: direct.ecosystems.npm.findings.length
                ? Object.keys(direct.ecosystems.npm.findings[0]).sort() : [],
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"keys test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        required = {
            "tool",
            "eventId",
            "ecosystem",
            "package",
            "installed",
            "wanted",
            "latest",
            "severity",
            "advisory",
            "fixedIn",
            "source",
        }
        self.assertTrue(
            required.issubset(set(data["bareKeys"])),
            f"bare finding missing keys: {required - set(data['bareKeys'])}",
        )
        self.assertEqual(
            data["fullSeverity"], "high", "severity normalises to lowercase"
        )
        # Findings from a real scan path carry the same eleven keys.
        if data["npmKeys"]:
            self.assertTrue(required.issubset(set(data["npmKeys"])))


class TestOsvTimeoutBound(unittest.TestCase):
    def test_hung_feed_resolves_inside_budget(self):
        res = run_node(
            DEP_IMPORT
            + """
            const runOutdated = async () => ({status: "ok", json: {}});
            const runAudit = async () => ({status: "ok", json: {}});
            const queryOsv = () => new Promise(() => {});
            const t0 = Date.now();
            const direct = await checkDeps({
              manifests: {packageJson: JSON.stringify({dependencies: {a: "1.0.0"}})},
              runOutdated, runAudit, queryOsv, osvTimeoutMs: 60,
            });
            const elapsed = Date.now() - t0;
            console.log(JSON.stringify({
              allowed: direct.allowed, elapsed,
              npmStatus: direct.ecosystems.npm.status,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"osv-timeout test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"])
        self.assertLess(
            data["elapsed"],
            2000,
            "hung OSV feed must resolve near the slow-tier budget",
        )
        self.assertEqual(
            data["npmStatus"],
            "scanned",
            "local signals decide npm; a hung feed must not flip scanned",
        )


class TestRepoBaseline(unittest.TestCase):
    def test_baseline_shape(self):
        res = run_node(
            DEP_IMPORT
            + MOCK_CLEAN_RUNNERS
            + """
            const direct = await checkDeps({
              root: ".", runOutdated, runAudit, queryOsv, osvTimeoutMs: 200,
            });
            const containers = direct.ecosystems.containers;
            const actions = direct.ecosystems.actions;
            const pkgs = containers.findings.map((f) => f.package || "");
            console.log(JSON.stringify({
              allowed: direct.allowed,
              npm: direct.ecosystems.npm.status,
              pip: direct.ecosystems.pip.status,
              containers: containers.status,
              containerCount: containers.findings.length,
              hasSearxng: pkgs.some((p) => p.includes("searxng")),
              hasFirecrawl: pkgs.some((p) => p.includes("firecrawl")),
              containerSources: [...new Set(containers.findings.map((f) => f.source))],
              actions: actions.status,
              actionCount: actions.findings.length,
              keys: containers.findings.length ? Object.keys(containers.findings[0]).sort() : [],
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"baseline test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"])
        self.assertEqual(data["npm"], "scanned", "repo has package.json: npm scanned")
        self.assertEqual(data["pip"], "absent", "repo has no pip manifests: pip absent")
        self.assertEqual(data["containers"], "scanned")
        self.assertGreaterEqual(
            data["containerCount"], 2, "the 2x :latest advisories (searxng + firecrawl)"
        )
        self.assertTrue(data["hasSearxng"], "searxng :latest advisory recorded")
        self.assertTrue(data["hasFirecrawl"], "firecrawl :latest advisory recorded")
        self.assertTrue(
            data["actions"] == "scanned" and data["actionCount"] == 0,
            "majors-pinned workflows scan clean",
        )
        required = {
            "tool",
            "eventId",
            "ecosystem",
            "package",
            "installed",
            "wanted",
            "latest",
            "severity",
            "advisory",
            "fixedIn",
            "source",
        }
        self.assertTrue(required.issubset(set(data["keys"])))


class TestParsers(unittest.TestCase):
    def test_actions_unpinned_flagged(self):
        res = run_node(
            'import { parseActionPins, parseContainerImages, isFloatingImage, parsePipDeps } from "./plugins/opencode/dep-health.js";\n'
            + """
            const pins = parseActionPins("steps:\\n  - uses: actions/checkout@v4\\n  - uses: foo/bar@main\\n  - uses: baz/qux\\n");
            const imgs = parseContainerImages("services:\\n  a:\\n    image: searxng/searxng:latest\\n  b:\\n    image: redis:7-alpine\\n");
            const pip = parsePipDeps("requests>=2.0\\n# comment\\nflask==3.0; python_version>'3.8'\\n");
            console.log(JSON.stringify({
              pinned: pins.map((p) => p.pinned),
              floating: imgs.map(isFloatingImage),
              pipNames: pip.map((d) => d.name),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"parser test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(
            data["pinned"],
            [True, False, False],
            "majors pinned; branch/missing refs flagged",
        )
        self.assertEqual(data["floating"], [True, False])
        self.assertEqual(data["pipNames"], ["requests", "flask"])


class TestSetupAdoptsDepHealth(unittest.TestCase):
    def test_setup_adopts_and_disposes_dep_health(self):
        res = run_node(
            """
            import plugin, { hookBus } from "./plugins/opencode/index.js";
            const before = {
              pre: hookBus.handlerCount("pre-tool-use"),
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
              commit: hookBus.handlerCount("pre-commit"),
            };
            const attached = !!host.iumbtemsDepHealth;
            await cleanup();
            const closed = {
              pre: hookBus.handlerCount("pre-tool-use"),
              commit: hookBus.handlerCount("pre-commit"),
            };
            console.log(JSON.stringify({before, after, attached, closed}));
            """
        )
        self.assertEqual(res.returncode, 0, f"adopt test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["attached"], "dep-health must be adopted on setup")
        self.assertGreater(
            data["after"]["pre"],
            data["before"]["pre"],
            "pre-tool-use dep-health handler subscribed",
        )
        self.assertGreater(
            data["after"]["commit"],
            data["before"]["commit"],
            "pre-commit dep-health handler subscribed",
        )
        self.assertEqual(
            data["closed"],
            data["before"],
            "cleanup must dispose dep-health subscriptions",
        )


class TestOsvFaultInjection(unittest.TestCase):
    def test_offline_feed_throw_records_unavailable_and_allows(self):
        res = run_node(
            DEP_IMPORT
            + """
            const queryOsv = async () => { throw new Error("OSV network failure (DNS unreachable)"); };
            let direct = null;
            let threw = false;
            try {
              direct = await checkDeps({
                manifests: { pipTexts: ["requests==2.28.1"] },
                queryOsv,
                osvTimeoutMs: 100,
              });
            } catch { threw = true; }
            console.log(JSON.stringify({
              threw,
              allowed: direct && direct.allowed,
              pipStatus: direct && direct.ecosystems.pip.status,
              findingCount: direct && direct.ecosystems.pip.findings.length,
              source: direct && direct.ecosystems.pip.findings[0] && direct.ecosystems.pip.findings[0].source,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"offline throw test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["threw"], "offline feed throw must never throw")
        self.assertTrue(data["allowed"], "offline feed throw must fail open")
        self.assertEqual(data["pipStatus"], "unavailable")
        self.assertGreaterEqual(data["findingCount"], 1)
        self.assertEqual(data["source"], "unavailable")

    def test_100k_vulns_bomb_capped_and_fast(self):
        res = run_node(
            DEP_IMPORT
            + """
            const vulns = Array.from({ length: 100000 }, (_, i) => ({
              id: "GHSA-bomb-" + i,
              summary: "critical bomb " + i,
              severity: [{ score: "9.8" }],
            }));
            const queryOsv = async () => ({ status: "ok", vulns });
            const runOutdated = async () => ({ status: "ok", json: {} });
            const runAudit = async () => ({ status: "ok", json: {} });
            const bus = createHookBus();
            const notices = [];
            const notify = (s) => { notices.push(s); };
            const reg = await registerDepHealth(null, {
              bus, runOutdated, runAudit, queryOsv, notify, osvTimeoutMs: 500,
            });
            const t0 = Date.now();
            const direct = await checkDeps({
              manifests: { pipTexts: ["requests==2.28.1"] },
              queryOsv,
              osvTimeoutMs: 500,
            });
            const emitRes = await bus.emit("pre-tool-use", { tool: "edit", eventId: "e-bomb" });
            const elapsed = Date.now() - t0;
            const findingCount = direct.ecosystems.pip.findings.length;
            const noticeMsg = notices[0] ? notices[0].message : "";
            console.log(JSON.stringify({
              allowed: direct.allowed,
              emitAllowed: emitRes.allowed,
              findingCount,
              elapsed,
              notices: notices.length,
              noticeMsg,
              hasBombIdInToast: noticeMsg.includes("GHSA-bomb"),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"100k bomb test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"])
        self.assertTrue(data["emitAllowed"])
        self.assertEqual(data["findingCount"], 50, "findings must be capped at MAX_DEP_FINDINGS (50)")
        self.assertLess(data["elapsed"], 2000, "100k bomb must complete in milliseconds")
        self.assertEqual(data["notices"], 1, "exactly one summary toast")
        self.assertFalse(data["hasBombIdInToast"], "toast must be counts-only; no vuln IDs")

    def test_never_resolving_query_times_out_and_allows(self):
        res = run_node(
            DEP_IMPORT
            + """
            const queryOsv = () => new Promise(() => {});
            const t0 = Date.now();
            const direct = await checkDeps({
              manifests: { pipTexts: ["flask==2.0.1"] },
              queryOsv,
              osvTimeoutMs: 80,
            });
            const elapsed = Date.now() - t0;
            console.log(JSON.stringify({
              allowed: direct.allowed,
              elapsed,
              pipStatus: direct.ecosystems.pip.status,
              findingCount: direct.ecosystems.pip.findings.length,
              source: direct.ecosystems.pip.findings[0] && direct.ecosystems.pip.findings[0].source,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"hung query test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"])
        self.assertLess(data["elapsed"], 2000, "hung query must settle near budget")
        self.assertEqual(data["pipStatus"], "unavailable")
        self.assertGreaterEqual(data["findingCount"], 1)
        self.assertEqual(data["source"], "unavailable")


if __name__ == "__main__":
    unittest.main()

