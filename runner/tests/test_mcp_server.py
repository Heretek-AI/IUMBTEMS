#!/usr/bin/env python3
"""Tests for the first-party MCP server (runner/mcp_server.py) and the shared
protocol loop (runner/mcp_protocol.py)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.mcp_protocol import (
    StdioJsonRpcServer,
    ToolSpec,
    read_message,
    write_message,
)  # noqa: E402
from runner.mcp_server import SERVER_NAME, build_server, build_tools  # noqa: E402

EXPECTED_TOOLS = [
    "iumbtems_config",
    "iumbtems_swarm_research",
    "iumbtems_code_audit",
    "iumbtems_oss_scout",
    "iumbtems_brainstorm",
    "iumbtems_darkharvest",
    "iumbtems_verify_quote",
    "iumbtems_socratic_frontier",
    "iumbtems_reindex_claims",
    "iumbtems_report_retraction",
    "iumbtems_check_staleness",
    "iumbtems_set_domain_pack",
    "iumbtems_export_brief",
    "iumbtems_verify_brief",
]


class TestMcpProtocol(unittest.TestCase):
    def test_tool_spec_manifest_shape(self):
        spec = ToolSpec("t", "d", {"type": "object"}, lambda a: "x")
        self.assertEqual(
            spec.to_manifest(),
            {"name": "t", "description": "d", "inputSchema": {"type": "object"}},
        )

    def test_alias_dispatch(self):
        calls = []
        spec = ToolSpec(
            "main", "d", {}, lambda a: calls.append(a) or "ok", aliases=("alt",)
        )
        server = StdioJsonRpcServer("s", "1", [spec])
        res = server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "alt", "arguments": {"q": 1}},
            }
        )
        self.assertEqual(res["result"]["content"][0]["text"], "ok")
        self.assertEqual(calls, [{"q": 1}])

    def test_handler_exception_becomes_error_not_crash(self):
        def boom(_):
            raise RuntimeError("kaboom")

        server = StdioJsonRpcServer("s", "1", [ToolSpec("t", "d", {}, boom)])
        res = server.handle(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "t", "arguments": {}},
            }
        )
        self.assertIn("error", res)
        self.assertEqual(res["error"]["code"], -32603)
        self.assertIn("kaboom", res["error"]["message"])

    def test_notification_gets_no_reply(self):
        server = StdioJsonRpcServer("s", "1", [])
        self.assertIsNone(
            server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
        )

    def test_unknown_method_is_32601(self):
        server = StdioJsonRpcServer("s", "1", [])
        res = server.handle({"jsonrpc": "2.0", "id": 3, "method": "bogus/x"})
        self.assertEqual(res["error"]["code"], -32601)

    def test_content_length_round_trip(self):
        import io

        body = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
        )
        raw = f"Content-Length: {len(body)}\r\n\r\n{body}"
        req, use_headers = read_message(io.StringIO(raw))
        self.assertTrue(use_headers)
        self.assertEqual(req["method"], "initialize")

        out = io.StringIO()
        write_message(out, {"jsonrpc": "2.0", "id": 1, "result": {}}, use_headers=True)
        self.assertTrue(out.getvalue().startswith("Content-Length:"))


class TestMcpServerTools(unittest.TestCase):
    def test_canonical_tool_names(self):
        names = [t.name for t in build_tools()]
        self.assertEqual(sorted(names), sorted(EXPECTED_TOOLS))

    def test_server_meta(self):
        server = build_server()
        self.assertEqual(server.server_name, SERVER_NAME)
        self.assertEqual(server.protocol_version, "2024-11-05")
        self.assertEqual(sorted(t.name for t in server.tools), sorted(EXPECTED_TOOLS))

    def test_tools_list_via_stdio_handshake(self):
        """Subprocess handshake: initialize -> tools/list -> tools/call."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            # Seed a source so verify_quote has something real to check.
            from skills.research_cache.hasher import SourceHasher

            hasher = SourceHasher(tmp_path)
            content = "The FPGA pipeline executes Poseidon in 184ms."
            digest = hasher.store_source(
                url="https://example.test/p", content=content, title="T"
            )

            # Drive handle() directly in-process for tools/call; use the
            # subprocess only to prove the stdio loop serves initialize/tools/list.
            proc = subprocess.Popen(
                [sys.executable, str(PROJECT_ROOT / "runner" / "mcp_server.py")],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            lines = [
                json.dumps(
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
                ),
                json.dumps(
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
                ),
            ]
            out, err = proc.communicate("\n".join(lines) + "\n", timeout=20)
            self.assertEqual(err.strip(), "", f"server stderr: {err}")
            responses = [json.loads(l) for l in out.strip().splitlines() if l.strip()]
            self.assertEqual(len(responses), 2)
            init, tools_list = responses
            self.assertEqual(init["result"]["protocolVersion"], "2024-11-05")
            self.assertEqual(init["result"]["serverInfo"]["name"], "iumbtems")
            self.assertEqual(
                sorted(t["name"] for t in tools_list["result"]["tools"]),
                sorted(EXPECTED_TOOLS),
            )

            # Round-trip verify_quote in-process against the temp cache.
            server = build_server()
            res = server.handle(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "iumbtems_verify_quote",
                        "arguments": {
                            "hash": digest,
                            "quote": "Poseidon in 184ms",
                            "base_dir": tmp,
                        },
                    },
                }
            )
            payload = json.loads(res["result"]["content"][0]["text"])
            self.assertTrue(payload["verified"])
            self.assertGreaterEqual(payload["confidence"], 0.95)

            # And a failing quote must come back unverified.
            res_bad = server.handle(
                {
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "iumbtems_verify_quote",
                        "arguments": {
                            "hash": digest,
                            "quote": "this text was never cached anywhere",
                            "base_dir": tmp,
                        },
                    },
                }
            )
            bad = json.loads(res_bad["result"]["content"][0]["text"])
            self.assertFalse(bad["verified"])

    def test_one_shot_call_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            from skills.research_cache.hasher import SourceHasher

            hasher = SourceHasher(Path(tmp))
            content = "Epistemic sovereignty over parametric intuition."
            digest = hasher.store_source(url="https://example.test/q", content=content)

            proc = subprocess.run(
                [
                    sys.executable,
                    str(PROJECT_ROOT / "runner" / "mcp_server.py"),
                    "call",
                    "iumbtems_verify_quote",
                    json.dumps(
                        {
                            "hash": digest,
                            "quote": "parametric intuition",
                            "base_dir": tmp,
                        }
                    ),
                ],
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["verified"])

    def test_unknown_tool_reports_available(self):
        proc = subprocess.run(
            [
                sys.executable,
                str(PROJECT_ROOT / "runner" / "mcp_server.py"),
                "call",
                "nope_not_a_tool",
                "{}",
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(proc.returncode, 1)
        payload = json.loads(proc.stdout)
        self.assertIn("error", payload)
        self.assertEqual(sorted(payload["available"]), sorted(EXPECTED_TOOLS))


if __name__ == "__main__":
    unittest.main()
