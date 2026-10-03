#!/usr/bin/env python3
"""Tests for Phase 01-hook-bus-spec: six-event blockable hook bus.

Mock-host only (no live TUI): bus unit tests (order, fast/slow timeouts,
fail-open, audit completeness, all-six-events blockable), the pre-commit gate
on the settings-RPC write path (stale-write preservation), registrar-adopt
(bus adopted + disposed alongside the existing four), and parity-doc pointer
resolution.

Phase evidence cited in-code per brief:
[VERIFIED: sha256:52ac5b4d26062cfc6093440faa415ab152f8acd0d18c4496eb0087ed18a27d76]
[VERIFIED: sha256:06fff10d7c9d77a86c42d6f412b22de46a6f6bba89dea23a863075bdd3d98bda]
Gate-0 parents: 08229740d0a7f752b0c388876ec1588e513f2b3bc8130a72771bee9593d92665,
131bcb343879bfadcba9a40719ddd0b77540eb21f4cdc937d18b1b2943579afa.
"""

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

SIX_EVENTS = [
    "pre-tool-use",
    "post-tool-use",
    "pre-commit",
    "stop",
    "notification",
    "session-start",
]


def run_node(code):
    return subprocess.run(
        ["node", "--input-type=module", "-e", code],
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
    )


def last_json_object(stdout):
    lines = [l.strip() for l in stdout.strip().split("\n") if l.strip().startswith("{")]
    return json.loads(lines[-1])


BUS_IMPORT = 'import { createHookBus } from "./plugins/opencode/hook-bus.js";\n'


class TestHookBusSixDenyBlocks(unittest.TestCase):
    def test_each_event_deny_blocks(self):
        # Functional: every one of the six events has a deny-blocks path.
        res = run_node(
            BUS_IMPORT
            + f"""
            const results = [];
            for (const event of {json.dumps(SIX_EVENTS)}) {{
              const bus = createHookBus();
              bus.on(event, () => "deny", {{tier: "fast"}});
              const r = await bus.emit(event, {{tool: "webfetch", eventId: "e1"}});
              results.push({{event, allowed: r.allowed}});
            }}
            console.log(JSON.stringify({{results}}));
            """
        )
        self.assertEqual(res.returncode, 0, f"deny-blocks test failed: {res.stderr}")
        for row in last_json_object(res.stdout)["results"]:
            self.assertFalse(row["allowed"], f"{row['event']} deny did not block")

    def test_allow_passes(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("pre-tool-use", () => "allow", {tier: "fast"});
            const r = await bus.emit("pre-tool-use", {tool: "webfetch"});
            console.log(JSON.stringify({allowed: r.allowed}));
            """
        )
        self.assertEqual(res.returncode, 0, f"allow test failed: {res.stderr}")
        self.assertTrue(last_json_object(res.stdout)["allowed"])

    def test_slow_deny_inside_budget_blocks(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("stop", async () => {
              await new Promise((r) => setTimeout(r, 200));
              return "deny";
            }, {tier: "slow"});
            const r = await bus.emit("stop", {});
            console.log(JSON.stringify({allowed: r.allowed}));
            """
        )
        self.assertEqual(res.returncode, 0, f"slow-deny test failed: {res.stderr}")
        self.assertFalse(last_json_object(res.stdout)["allowed"])


class TestHookBusTimeouts(unittest.TestCase):
    def test_slow_overrun_degrades_to_advisory(self):
        # Slow handler exceeding the slow budget: fail-open allow + advisory
        # annotation + timeout audit entry (never bricks, never throws).
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("pre-tool-use", async () => {
              await new Promise((r) => setTimeout(r, 300));
              return "deny";
            }, {tier: "slow"});
            const r = await bus.emit("pre-tool-use", {tool: "webfetch"}, {slowTimeoutMs: 50});
            const audit = bus.getAuditLog();
            console.log(JSON.stringify({
              allowed: r.allowed,
              annotations: r.annotations.length,
              outcomes: audit.map((a) => a.outcome)
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"slow-overrun test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"], "slow overrun must fail open")
        self.assertGreaterEqual(data["annotations"], 1)
        self.assertIn("timeout", data["outcomes"])

    def test_slow_overrun_does_not_brick_fast_path(self):
        # A slow deny landing inside the slow budget still blocks, while the
        # fast handler's verdict is recorded independently (tiers concurrent).
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            const order = [];
            bus.on("stop", () => { order.push("fast"); return "allow"; }, {tier: "fast"});
            bus.on("stop", async () => {
              await new Promise((r) => setTimeout(r, 800));
              order.push("slow");
              return "deny";
            }, {tier: "slow"});
            const t0 = Date.now();
            const r = await bus.emit("stop", {});
            const elapsed = Date.now() - t0;
            const audit = bus.getAuditLog();
            const fastEntry = audit.find((a) => a.tier === "fast");
            console.log(JSON.stringify({
              allowed: r.allowed, order, elapsed,
              fastLatency: fastEntry && fastEntry.latencyMs
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"fast-path test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["allowed"], "slow deny inside budget must block")
        self.assertIn("fast", data["order"])
        # The fast verdict landed on the fast path, not after the slow 800 ms.
        self.assertLess(data["fastLatency"], 800)

    def test_fast_timeout_fails_open(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("notification", async () => {
              await new Promise((r) => setTimeout(r, 300));
              return "deny";
            }, {tier: "fast"});
            const r = await bus.emit("notification", {}, {fastTimeoutMs: 50});
            console.log(JSON.stringify({allowed: r.allowed}));
            """
        )
        self.assertEqual(res.returncode, 0, f"fast-timeout test failed: {res.stderr}")
        self.assertTrue(last_json_object(res.stdout)["allowed"])


class TestHookBusFailOpen(unittest.TestCase):
    def test_throwing_handler_fails_open_with_audit(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("pre-tool-use", () => { throw new Error("boom"); }, {tier: "fast"});
            let threw = false;
            let r = null;
            try {
              r = await bus.emit("pre-tool-use", {tool: "webfetch", eventId: "e9"});
            } catch { threw = true; }
            const audit = bus.getAuditLog();
            console.log(JSON.stringify({
              threw, allowed: r && r.allowed, outcomes: audit.map((a) => a.outcome)
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"throw test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["threw"], "emit must never throw into the host")
        self.assertTrue(data["allowed"])
        self.assertIn("error", data["outcomes"])

    def test_rejecting_handler_fails_open(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("stop", async () => { throw new Error("async boom"); }, {tier: "slow"});
            const r = await bus.emit("stop", {});
            console.log(JSON.stringify({allowed: r.allowed}));
            """
        )
        self.assertEqual(res.returncode, 0, f"reject test failed: {res.stderr}")
        self.assertTrue(last_json_object(res.stdout)["allowed"])

    def test_unknown_event_fails_open(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            const r = await bus.emit("not-an-event", {});
            const badOn = bus.on("not-an-event", () => "deny");
            const r2 = await bus.emit("not-an-event", {});
            console.log(JSON.stringify({
              allowed: r.allowed, allowed2: r2.allowed,
              unsub: typeof badOn
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"unknown-event test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"])
        self.assertTrue(data["allowed2"])
        self.assertEqual(data["unsub"], "function")


class TestHookBusOrderAndAudit(unittest.TestCase):
    def test_registration_order_preserved(self):
        # Verdicts report in registration order; the audit log carries the
        # same handler multiset (tiers run concurrently, so completion order
        # may interleave — each entry's seq preserves the total order).
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("post-tool-use", () => "allow", {tier: "fast", name: "first"});
            bus.on("post-tool-use", () => "allow", {tier: "fast", name: "second"});
            bus.on("post-tool-use", () => "allow", {tier: "slow", name: "third"});
            const r = await bus.emit("post-tool-use", {});
            console.log(JSON.stringify({
              verdicts: r.verdicts.map((v) => v.handler),
              audit: bus.getAuditLog().map((a) => a.handler)
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"order test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["verdicts"], ["first", "second", "third"])
        self.assertEqual(sorted(data["audit"]), ["first", "second", "third"])

    def test_audit_completeness(self):
        # Every decision audit-logs verdict + outcome + latency + tool/event id.
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("pre-tool-use", () => "deny", {tier: "fast", name: "gate"});
            bus.on("pre-tool-use", async () => {
              await new Promise((r) => setTimeout(r, 200));
              return "allow";
            }, {tier: "slow", name: "checker"});
            await bus.emit("pre-tool-use", {tool: "webfetch", eventId: "e7"});
            const audit = bus.getAuditLog();
            const keys = audit.map((a) => Object.keys(a).sort());
            console.log(JSON.stringify({audit, keys}));
            """
        )
        self.assertEqual(res.returncode, 0, f"audit test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(len(data["audit"]), 2)
        required = {
            "event",
            "tier",
            "handler",
            "verdict",
            "outcome",
            "latencyMs",
            "tool",
            "eventId",
        }
        for entry_keys in data["keys"]:
            self.assertTrue(
                required.issubset(set(entry_keys)),
                f"audit entry missing keys: {required - set(entry_keys)}",
            )
        outcomes = {a["outcome"] for a in data["audit"]}
        self.assertIn("deny", outcomes)
        self.assertIn("allow", outcomes)


class TestPreCommitGate(unittest.TestCase):
    GATE_SETUP = """
            import { createSettingsHandlers } from "./plugins/opencode/index.js";
            import { createHookBus } from "./plugins/opencode/hook-bus.js";
            const calls = [];
            const okImpl = async (tool, args, root) => {
              calls.push({tool, args});
              return {content: JSON.stringify({status: "updated", config: {mode: "audit"}, hash: "h1"})};
            };
    """

    def test_precommit_deny_blocks_write(self):
        res = run_node(
            self.GATE_SETUP
            + """
            const bus = createHookBus();
            bus.on("pre-commit", () => "deny", {tier: "fast"});
            const h = createSettingsHandlers({root: "/tmp/oc-gate-deny", callMcpImpl: okImpl, hookBus: bus});
            let rpcType = null;
            let data = null;
            try {
              await h.set({updates: {mode: "audit"}}, {});
            } catch (err) { rpcType = err.rpcType; data = err.rpcData; }
            const audit = bus.getAuditLog();
            console.log(JSON.stringify({
              rpcType, written: data && data.written,
              mcpCalls: calls.length,
              gateAudited: audit.some((a) => a.event === "pre-commit" && a.outcome === "deny")
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"gate-deny test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["rpcType"], "invalid")
        self.assertFalse(data["written"])
        self.assertEqual(data["mcpCalls"], 0, "denied write must not reach MCP")
        self.assertTrue(data["gateAudited"])

    def test_precommit_allow_writes_and_stale_guard_preserved(self):
        # Allow proceeds to the MCP write; a stale MCP verdict still surfaces
        # as `stale` (nothing written) — the expected-hash guard is intact.
        res = run_node(
            self.GATE_SETUP
            + """
            const bus = createHookBus();
            bus.on("pre-commit", () => "allow", {tier: "fast"});
            const h = createSettingsHandlers({root: "/tmp/oc-gate-allow", callMcpImpl: okImpl, hookBus: bus});
            const ok = await h.set({updates: {mode: "audit"}}, {});
            const staleImpl = async () => ({content: JSON.stringify({
              status: "stale", expected_hash: "e", current_hash: "c", config: {}
            })});
            const h2 = createSettingsHandlers({root: "/tmp/oc-gate-stale", callMcpImpl: staleImpl, hookBus: bus});
            let staleType = null;
            let staleWritten = null;
            try {
              await h2.set({updates: {mode: "audit"}, expected_hash: "abcdef12"}, {});
            } catch (err) { staleType = err.rpcType; staleWritten = err.rpcData && err.rpcData.written; }
            console.log(JSON.stringify({
              wrote: ok.config.mode, hash: ok.hash, staleType, staleWritten
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"gate-allow test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["wrote"], "audit")
        self.assertEqual(data["hash"], "h1")
        self.assertEqual(data["staleType"], "stale")
        self.assertFalse(data["staleWritten"])


class TestHookBusRegistrarAdopt(unittest.TestCase):
    def test_setup_adopts_bus_alongside_existing(self):
        # The bus is adopted with the same adopt/best-effort pattern as the
        # existing four registrations; cleanup disposes (detaches) it.
        res = run_node(
            """
            import plugin, { hookBus } from "./plugins/opencode/index.js";
            const addedCommands = [];
            const addedTools = [];
            const host = {
              options: {},
              command: {
                list: async () => ({data: []}),
                transform: async (fn) => { fn({add: (d) => addedCommands.push(d)}); return {dispose: async () => {}}; }
              },
              tool: {
                transform: async (fn) => { fn({add: (t) => addedTools.push(t)}); return {dispose: async () => {}}; }
              },
              session: { prompt: async () => ({}) }
            };
            const cleanup = await plugin.setup(host);
            const attached = host.iumbtemsHookBus === hookBus;
            await cleanup();
            console.log(JSON.stringify({
              attached,
              detached: host.iumbtemsHookBus === undefined,
              commands: addedCommands.length,
              tools: addedTools.length
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"adopt test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["attached"], "bus must be adopted on setup")
        self.assertTrue(data["detached"], "cleanup must dispose the bus")
        self.assertGreater(data["commands"], 0, "existing commands still adopted")
        self.assertGreater(data["tools"], 0, "existing tools still adopted")

    def test_session_start_deny_never_drops_compaction_push(self):
        # `session-start` is advisory: even a deny still pushes state.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            research = Path(tmp) / ".research"
            research.mkdir()
            research.joinpath("config.json").write_text(
                json.dumps({"mode": "audit", "search_engine": "duckduckgo"}),
                encoding="utf-8",
            )
            res = run_node(
                f"""
                import plugin, {{ hookBus }} from "./plugins/opencode/index.js";
                hookBus.on("session-start", () => "deny", {{tier: "fast"}});
                let handler = null;
                const host = {{
                  options: {{}},
                  location: {{directory: {tmp!r}}},
                  command: {{list: async () => ({{data: []}}), transform: async () => ({{dispose: async () => {{}}}})}},
                  tool: {{transform: async () => ({{dispose: async () => {{}}}})}},
                  session: {{
                    prompt: async () => ({{}}),
                    hook: async (name, fn) => {{ if (name === "compaction") handler = fn; return {{dispose: async () => {{}}}}; }}
                  }}
                }};
                await plugin.setup(host);
                const event = {{system: [], directory: {tmp!r}}};
                if (handler) await handler(event);
                const audit = hookBus.getAuditLog().filter((a) => a.event === "session-start");
                console.log(JSON.stringify({{pushed: event.system.length, audited: audit.length}}));
                """
            )
            self.assertEqual(res.returncode, 0, f"advisory test failed: {res.stderr}")
            data = last_json_object(res.stdout)
            self.assertEqual(data["pushed"], 1, "deny must not drop the state push")
            self.assertGreaterEqual(data["audited"], 1, "verdict must be audit-logged")


class TestParityDocPointers(unittest.TestCase):
    def test_every_pointer_resolves(self):
        # Every parity-table / wire-in row resolves to a real file/line;
        # when a symbol name is specified in parentheses, verify it exists
        # within ±3 lines of the cited line.
        doc = (PROJECT_ROOT / "docs" / "HOOK_BUS_PARITY.md").read_text(encoding="utf-8")
        self.assertIn("tool.execute.before", doc)
        refs = re.findall(
            r"((?:plugins|runner)/[A-Za-z0-9_./-]+):(\d+)(?:\s*\(([^)]+)\))?", doc
        )
        self.assertGreater(len(refs), 0, "parity doc must carry file:line pointers")
        for path, line_str, symbol in refs:
            target = PROJECT_ROOT / path
            self.assertTrue(target.is_file(), f"parity pointer missing file: {path}")
            lines = target.read_text(encoding="utf-8").splitlines()
            line_no = int(line_str)
            self.assertTrue(
                1 <= line_no <= len(lines),
                f"parity pointer out of range: {path}:{line_no} (file has {len(lines)} lines)",
            )
            if symbol and symbol.strip():
                sym = symbol.strip()
                start = max(0, line_no - 4)
                end = min(len(lines), line_no + 3)
                window = "\n".join(lines[start:end])
                self.assertIn(
                    sym,
                    window,
                    f"symbol '{sym}' not found within ±3 lines of {path}:{line_no}",
                )

    def test_tool_execute_before_gap_stated_once_outside_appendix(self):
        doc = (PROJECT_ROOT / "docs" / "HOOK_BUS_PARITY.md").read_text(encoding="utf-8")
        body_before_appendix = doc.split("## Appendix:")[0]
        self.assertIn("## Gap list", body_before_appendix)
        gap_section = body_before_appendix.split("## Gap list")[1]
        gap_headers = re.findall(r"^\d+\.\s+\*\*.*?\*\*", gap_section, re.MULTILINE)
        tool_gaps = [g for g in gap_headers if "tool.execute.before" in g]
        self.assertEqual(
            len(tool_gaps),
            1,
            f"expected exactly one enumerated tool.execute.before gap, got {tool_gaps}",
        )
        self.assertIn("1.", tool_gaps[0], "gap 1 must be the tool.execute.before gap")


class TestHookBusFixRound(unittest.TestCase):
    # QA-B fix-round pins: malformed-verdict fallback tags (FAIL 3a),
    # always-present tool/eventId keys (FAIL 3b), ring-cap drop counter +
    # clear tombstone (FAIL 3c), direct-fs pre-commit gate (FAIL 1),
    # plugin-tool pre/post-tool-use host emits (FAIL 2), and the
    # caller-latency contract (CONDITIONAL note). All fast: small budgets,
    # sync handlers, one MCP spawn at most.

    def test_malformed_verdict_tagged_fallback(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("pre-tool-use", () => 42, {tier: "fast", name: "num"});
            bus.on("pre-tool-use", () => ({verdict: "bogus"}), {tier: "fast", name: "obj"});
            bus.on("pre-tool-use", () => ["deny"], {tier: "slow", name: "arr"});
            bus.on("pre-tool-use", () => "needs review", {tier: "slow", name: "reason"});
            bus.on("pre-tool-use", () => ({}), {tier: "fast", name: "emptyobj"});
            const r = await bus.emit("pre-tool-use", {tool: "webfetch", eventId: "e1"});
            console.log(JSON.stringify({allowed: r.allowed, audit: bus.getAuditLog()}));
            """
        )
        self.assertEqual(res.returncode, 0, f"fallback-tag test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"], "malformed verdicts must fail open")
        self.assertEqual(len(data["audit"]), 5)
        for entry in data["audit"]:
            self.assertTrue(
                entry.get("fallback"), f"malformed verdict not tagged: {entry}"
            )
            self.assertTrue(
                entry.get("note"), f"malformed verdict has no note: {entry}"
            )
            self.assertEqual(entry["verdict"], "allow")
        by_name = {a["handler"]: a for a in data["audit"]}
        self.assertEqual(by_name["reason"].get("reason"), "needs review")

    def test_deny_shaped_objects_are_tagged_not_silent(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("pre-tool-use", () => ({allowed: false}), {tier: "fast", name: "h_allowed"});
            bus.on("pre-tool-use", () => ({deny: true}), {tier: "fast", name: "h_deny"});
            bus.on("pre-tool-use", () => ({block: true}), {tier: "fast", name: "h_block"});
            const r = await bus.emit("pre-tool-use", {tool: "webfetch", eventId: "e2"});
            console.log(JSON.stringify({allowed: r.allowed, audit: bus.getAuditLog()}));
            """
        )
        self.assertEqual(res.returncode, 0, f"deny-shaped object test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"], "unrecognized deny-shaped objects must fail open")
        self.assertEqual(len(data["audit"]), 3)
        for entry in data["audit"]:
            self.assertTrue(entry.get("fallback"), f"entry not marked fallback: {entry}")
            self.assertIn("unrecognized verdict", entry.get("note", ""))
        by_name = {a["handler"]: a for a in data["audit"]}
        self.assertIn("allowed", by_name["h_allowed"].get("note", ""))
        self.assertIn("deny", by_name["h_deny"].get("note", ""))
        self.assertIn("block", by_name["h_block"].get("note", ""))

    def test_object_verdict_spellings_match_scalar(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("pre-tool-use", () => ({verdict: "block"}), {tier: "fast", name: "h_block"});
            bus.on("pre-tool-use", () => ({verdict: false}), {tier: "fast", name: "h_false"});
            bus.on("pre-tool-use", () => ({verdict: "warn"}), {tier: "fast", name: "h_warn"});
            bus.on("pre-tool-use", () => ({reason: "just a reason", annotations: []}), {tier: "fast", name: "h_reason"});
            const r = await bus.emit("pre-tool-use", {tool: "webfetch"});
            console.log(JSON.stringify({allowed: r.allowed, audit: bus.getAuditLog()}));
            """
        )
        self.assertEqual(res.returncode, 0, f"object verdict test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["allowed"], "verdict block/false must deny")
        by_name = {a["handler"]: a for a in data["audit"]}
        self.assertEqual(by_name["h_block"]["verdict"], "deny")
        self.assertFalse(by_name["h_block"].get("fallback", False))
        self.assertEqual(by_name["h_false"]["verdict"], "deny")
        self.assertFalse(by_name["h_false"].get("fallback", False))
        self.assertEqual(by_name["h_warn"]["verdict"], "advisory")
        self.assertFalse(by_name["h_warn"].get("fallback", False))
        self.assertEqual(by_name["h_reason"]["verdict"], "allow")
        self.assertFalse(by_name["h_reason"].get("fallback", False))

    def test_throwing_clock_still_audits(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus({
              clock: () => { throw new Error("bad clock"); }
            });
            bus.on("pre-tool-use", () => "deny", {tier: "fast", name: "d"});
            const r = await bus.emit("pre-tool-use", {tool: "test"});
            console.log(JSON.stringify({allowed: r.allowed, entries: bus.getAuditLog().length}));
            """
        )
        self.assertEqual(res.returncode, 0, f"throwing clock test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["allowed"], "deny must be enforced despite clock failure")
        self.assertGreaterEqual(data["entries"], 1, "audit log must record entry even with throwing clock")

    def test_throwing_payload_getter_keeps_deny(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("pre-tool-use", () => "deny", {tier: "fast", name: "d"});
            const hostile = {
              get tool() { throw new Error("hostile getter"); },
              get eventId() { throw new Error("hostile getter"); }
            };
            const r = await bus.emit("pre-tool-use", hostile);
            console.log(JSON.stringify({allowed: r.allowed, audit: bus.getAuditLog()}));
            """
        )
        self.assertEqual(res.returncode, 0, f"throwing getter test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["allowed"], "deny must be enforced despite hostile payload getter")
        self.assertGreaterEqual(len(data["audit"]), 1)
        self.assertEqual(data["audit"][0]["verdict"], "deny")

    def test_gate_pre_commit_empty_bus_audits_vacuity(self):
        res = run_node(
            BUS_IMPORT
            + """
            import { gatePreCommit } from "./plugins/opencode/hook-bus.js";
            const bus = createHookBus();
            const r = await gatePreCommit(bus, {updates: {mode: "audit"}});
            const audit = bus.getAuditLog();
            console.log(JSON.stringify({allowed: r.allowed, audit}));
            """
        )
        self.assertEqual(res.returncode, 0, f"empty bus gatePreCommit test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"])
        self.assertEqual(len(data["audit"]), 1)
        self.assertTrue(data["audit"][0].get("fallback"))
        self.assertIn("no handlers registered for pre-commit in this process", data["audit"][0].get("note", ""))

    def test_audit_always_carries_tool_and_eventId(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("stop", () => "allow", {tier: "fast", name: "w"});
            await bus.emit("stop", {});
            await bus.emit("not-an-event", {});
            console.log(JSON.stringify({audit: bus.getAuditLog()}));
            """
        )
        self.assertEqual(res.returncode, 0, f"audit-keys test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertGreater(len(data["audit"]), 0)
        for entry in data["audit"]:
            self.assertIn("tool", entry, f"audit entry missing tool key: {entry}")
            self.assertIn("eventId", entry, f"audit entry missing eventId key: {entry}")
            self.assertIsNone(entry["tool"])
            self.assertIsNone(entry["eventId"])

    def test_ring_cap_drop_counter(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("stop", () => "allow", {tier: "fast"});
            for (let i = 0; i < 1002; i++) {
              await bus.emit("stop", {eventId: "e" + i});
            }
            const stats = bus.getAuditStats();
            console.log(JSON.stringify({
              entries: bus.getAuditLog().length,
              dropped: stats.dropped,
              capacity: stats.capacity
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"drop-counter test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["entries"], 1000)
        self.assertEqual(data["dropped"], 2)
        self.assertEqual(data["capacity"], 1000)

    def test_clear_audit_log_writes_tombstone(self):
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("stop", () => "allow", {tier: "fast"});
            await bus.emit("stop", {});
            bus.clearAuditLog();
            const log = bus.getAuditLog();
            console.log(JSON.stringify({len: log.length, entry: log[0]}));
            """
        )
        self.assertEqual(res.returncode, 0, f"tombstone test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["len"], 1)
        entry = data["entry"]
        self.assertEqual(entry["event"], "audit-clear")
        self.assertTrue(entry.get("fallback"))
        self.assertIn("1 entries discarded", entry.get("note", ""))
        self.assertIn("tool", entry)
        self.assertIn("eventId", entry)

    def test_emit_latency_bounded_by_slow_budget(self):
        # CONDITIONAL note: a hung slow handler delays the caller by at most
        # the slow budget — never indefinitely.
        res = run_node(
            BUS_IMPORT
            + """
            const bus = createHookBus();
            bus.on("stop", () => new Promise(() => {}), {tier: "slow", name: "hung"});
            const t0 = Date.now();
            const r = await bus.emit("stop", {}, {slowTimeoutMs: 120});
            const elapsed = Date.now() - t0;
            const audit = bus.getAuditLog();
            console.log(JSON.stringify({
              allowed: r.allowed, elapsed,
              outcomes: audit.map((a) => a.outcome)
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"latency-bound test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"], "hung slow handler must fail open")
        self.assertLess(data["elapsed"], 2000, "emit must resolve near the slow budget")
        self.assertIn("timeout", data["outcomes"])

    def test_direct_fs_gate_deny_blocks_and_audits(self):
        # FAIL 1: the direct-fs fallback leg gates on pre-commit too.
        res = run_node(
            """
            import { gateDirectFsPreCommit } from "./plugins/opencode/tui.js";
            import { createHookBus } from "./plugins/opencode/hook-bus.js";
            const bus = createHookBus();
            bus.on("pre-commit", () => "deny", {tier: "fast"});
            const denied = await gateDirectFsPreCommit(bus, {
              draft: {mode: "audit"}, baseDir: "/tmp/oc-fs-gate", guard: {expectedHash: "abcdef12"}
            });
            const open = await gateDirectFsPreCommit(null, {draft: {}, baseDir: "/tmp/oc-fs-gate"});
            const audit = bus.getAuditLog();
            console.log(JSON.stringify({
              denied: denied.allowed, open: open.allowed,
              audited: audit.some((a) => a.event === "pre-commit" && a.outcome === "deny")
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"direct-fs gate test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertFalse(data["denied"], "direct-fs deny must block")
        self.assertTrue(data["open"], "null bus must fail open")
        self.assertTrue(
            data["audited"], "denied fallback write must leave an audit entry"
        )

    def test_direct_fs_gate_with_empty_bus_records_vacuity(self):
        res = run_node(
            """
            import { gateDirectFsPreCommit } from "./plugins/opencode/tui.js";
            import { createHookBus } from "./plugins/opencode/hook-bus.js";
            const bus = createHookBus();
            const r = await gateDirectFsPreCommit(bus, {
              draft: {mode: "audit"}, baseDir: "/tmp/oc-fs-gate-empty"
            });
            const audit = bus.getAuditLog();
            console.log(JSON.stringify({
              allowed: r.allowed,
              audit,
            }));
            """
        )
        self.assertEqual(res.returncode, 0, f"empty bus direct-fs test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertTrue(data["allowed"], "empty bus must allow write")
        self.assertEqual(len(data["audit"]), 1)
        self.assertTrue(data["audit"][0].get("fallback"))
        self.assertIn("no handlers registered for pre-commit in this process", data["audit"][0].get("note", ""))

    def test_direct_fs_stale_guard_preserved(self):
        # FAIL 1: the gate does NOT replace the stale-write guard — a stale
        # expected hash still refuses the write via saveConfig (CONFIG_STALE).
        res = run_node(
            """
            import fs from "node:fs";
            import os from "node:os";
            import path from "node:path";
            import { saveConfig, loadConfig, configHash } from "./plugins/opencode/config-io.js";
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-fs-stale-"));
            const seed = loadConfig(dir);
            saveConfig({...seed}, dir, {});
            let staleCode = null;
            try {
              saveConfig({...seed, mode: "scout"}, dir, {expected_hash: "00000000"});
            } catch (err) { staleCode = err.code; }
            const h = configHash(dir);
            const second = saveConfig({...seed}, dir, {expected_hash: h});
            console.log(JSON.stringify({staleCode, wrote: typeof second.hash === "string"}));
            """
        )
        self.assertEqual(res.returncode, 0, f"stale-guard test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(data["staleCode"], "CONFIG_STALE")
        self.assertTrue(data["wrote"])

    def test_shipped_path_threads_bus_rpc_null_unthreaded(self):
        # qa-b bypass repro: the SHIPPED TUI path is RPC-null with no manual
        # threading — a denying pre-commit handler must still deny the write
        # AND leave a pre-commit audit entry (previously: write landed, 0
        # audits — fail-open on missing wiring). Stale-guard coverage lives in
        # test_direct_fs_stale_guard_preserved.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            shipped = Path(tmp) / "shipped.js"
            shipped_body = """
                import fs from "node:fs";
                import os from "node:os";
                import path from "node:path";
                import { hookBus } from "__INDEX__";
                import { openSettingsWizard, setupTui, registerWizardSlashCommand } from "__TUI__";
                function mockApi(dir, selectQueue) {
                  const toasts = [];
                  const q = [...selectQueue];
                  return {
                    api: {
                      directory: dir,
                      ui: {
                        toast: { show: (t) => toasts.push(t) },
                        dialog: {
                          select: async () => (q.length ? q.shift() : null),
                          prompt: async () => null,
                          confirm: async () => true,
                        },
                      },
                      command: {
                        list: async () => ({data: []}),
                        transform: async (fn) => {
                          const adds = [];
                          fn({add: (d) => adds.push(d)});
                          return {dispose: async () => {}, adds};
                        },
                        reload: async () => {},
                      },
                    },
                    toasts,
                  };
                }
                // Leg 1: direct shipped call — openSettingsWizard(api, dir)
                // with NO opts and NO preset host bus (RPC-null).
                const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shipped1-"));
                const m1 = mockApi(dir1, ["__iumbtems_save__"]);
                setupTui(m1.api);
                const attached = m1.api.iumbtemsHookBus === hookBus;
                const mark1 = hookBus.getAuditLog().length;
                const off = hookBus.on("pre-commit", () => "deny", {tier: "fast", name: "shipped-deny"});
                let r1 = null;
                try { r1 = await openSettingsWizard(m1.api, dir1); }
                finally { /* keep handler for leg 2 */ }
                // Leg 2: slash-command shipped path — execute() captured from
                // registerWizardSlashCommand (previously called the wizard
                // with NO opts).
                const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shipped2-"));
                const m2 = mockApi(dir2, ["__iumbtems_save__"]);
                setupTui(m2.api);
                const reg = await registerWizardSlashCommand(m2.api);
                const adds = (reg && reg.adds) || [];
                const slash = adds.find((d) => d.name === "swarm-config");
                const mark2 = hookBus.getAuditLog().length;
                if (slash) await slash.execute();
                off();
                const audit = hookBus.getAuditLog();
                const denied1 = audit.slice(mark1).some((a) => a.event === "pre-commit" && a.outcome === "deny");
                const denied2 = audit.slice(mark2).some((a) => a.event === "pre-commit" && a.outcome === "deny");
                let wrote1 = false;
                try { fs.statSync(path.join(dir1, ".research", "config.json")); wrote1 = true; } catch { wrote1 = false; }
                let wrote2 = false;
                try { fs.statSync(path.join(dir2, ".research", "config.json")); wrote2 = true; } catch { wrote2 = false; }
                console.log(JSON.stringify({
                  attached, hasSlash: !!slash,
                  ok: r1 && r1.ok, reason: r1 && r1.reason, written: r1 && r1.written,
                  denied1, denied2, wrote1, wrote2
                }));
                """
            shipped_body = shipped_body.replace(
                "__INDEX__", str(PROJECT_ROOT / "plugins" / "opencode" / "index.js")
            ).replace("__TUI__", str(PROJECT_ROOT / "plugins" / "opencode" / "tui.js"))
            shipped.write_text(shipped_body, encoding="utf-8")
            res = subprocess.run(
                ["node", str(shipped)],
                capture_output=True,
                text=True,
                cwd=str(PROJECT_ROOT),
            )
            self.assertEqual(
                res.returncode, 0, f"shipped-path test failed: {res.stderr}"
            )
            data = last_json_object(res.stdout)
            self.assertTrue(data["attached"], "setupTui must adopt the shared bus")
            self.assertTrue(data["hasSlash"], "slash command must be registered")
            self.assertFalse(data["ok"], "shipped denying write must not report ok")
            self.assertEqual(data["reason"], "pre-commit-denied")
            self.assertFalse(data["written"])
            self.assertTrue(data["denied1"], "shipped direct call must audit the deny")
            self.assertTrue(
                data["denied2"], "shipped slash execute must audit the deny"
            )
            self.assertFalse(
                data["wrote1"], "denied shipped write must not land (leg 1)"
            )
            self.assertFalse(
                data["wrote2"], "denied shipped write must not land (leg 2)"
            )

    def test_plugin_tool_pre_and_post_gates(self):
        # FAIL 2: host emit sites for pre/post-tool-use in the plugin-tool
        # execute leg — deny blocks execution / suppresses delivery, shape
        # stays `{content}`-only either way.
        res = run_node(
            """
            import plugin, { hookBus } from "./plugins/opencode/index.js";
            let toolExec = null;
            const host = {
              options: {},
              command: {
                list: async () => ({data: []}),
                transform: async () => ({dispose: async () => {}})
              },
              tool: {
                transform: async (fn) => {
                  const adds = [];
                  fn({add: (t) => adds.push(t)});
                  toolExec = adds.find((t) => t.name === "iumbtems_config").execute;
                  return {dispose: async () => {}};
                }
              },
              session: { prompt: async () => ({}) }
            };
            const cleanup = await plugin.setup(host);
            const offPre = hookBus.on("pre-tool-use", () => "deny", {tier: "fast"});
            let blocked = null;
            try { blocked = await toolExec({}, {}); } finally { offPre(); }
            const offPost = hookBus.on("post-tool-use", () => "deny", {tier: "fast"});
            let suppressed = null;
            try { suppressed = await toolExec({}, {}); } finally { offPost(); }
            await cleanup();
            console.log(JSON.stringify({blocked, suppressed}));
            """
        )
        self.assertEqual(res.returncode, 0, f"tool-gate test failed: {res.stderr}")
        data = last_json_object(res.stdout)
        self.assertEqual(sorted(data["blocked"].keys()), ["content"])
        self.assertIn("denied by pre-tool-use", data["blocked"]["content"])
        self.assertEqual(sorted(data["suppressed"].keys()), ["content"])
        self.assertIn("suppressed by post-tool-use", data["suppressed"]["content"])


if __name__ == "__main__":
    unittest.main()
