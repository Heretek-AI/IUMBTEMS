#!/usr/bin/env python3
"""
Shared MCP stdio JSON-RPC protocol loop for IUMBTEMS.

Extracted from the duplicated hand-rolled servers in config/mcp_launcher.py
(the zero-key fallback) and config/searxng_mcp.py so the first-party tool
server (runner/mcp_server.py) can share one framing/dispatch implementation.

Protocol contract (kept byte-compatible with the previous inline loops):
- protocolVersion: "2024-11-05"
- Methods: initialize, notifications/initialized (no reply), tools/list,
  tools/call. Unknown methods get JSON-RPC error -32601.
- Framing: Content-Length header frames AND newline-delimited JSON are both
  accepted; a reply is framed the same way its request arrived.
- tools/call success payload: {"content": [{"type": "text", "text": ...}]}.

Resilience note (intentional delta from the old inline loops): a tool handler
that raises now returns JSON-RPC error -32603 instead of killing the server.
Malformed messages are logged and skipped; any other stream error ends the
loop (Content-Length desync is not recoverable).
"""

import json
import sys
from typing import Any, Callable, Dict, List, Optional, TextIO, Tuple

PROTOCOL_VERSION = "2024-11-05"


class ToolSpec:
    """One MCP tool: public manifest fields plus the handler behind it."""

    def __init__(
        self,
        name: str,
        description: str,
        input_schema: Dict[str, Any],
        handler: Callable[[Dict[str, Any]], str],
        aliases: Tuple[str, ...] = (),
    ):
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.handler = handler
        self.aliases = tuple(aliases)

    def to_manifest(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        }


def read_message(stream: TextIO) -> Optional[Tuple[Dict[str, Any], bool]]:
    """Read one JSON-RPC message. Returns (request, use_headers); None on EOF."""
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            continue
        if line.startswith("Content-Length:"):
            length = int(line.split(":", 1)[1].strip())
            stream.readline()  # blank separator line
            body = stream.read(length)
            return json.loads(body), True
        return json.loads(line), False


def write_message(stream: TextIO, message: Dict[str, Any], use_headers: bool) -> None:
    """Write one JSON-RPC message, matching the request's framing."""
    out = json.dumps(message)
    if use_headers:
        stream.write(f"Content-Length: {len(out)}\r\n\r\n{out}")
    else:
        stream.write(out + "\n")
    stream.flush()


class StdioJsonRpcServer:
    """Dispatch loop over a fixed tool registry."""

    def __init__(
        self,
        server_name: str,
        version: str,
        tools: List[ToolSpec],
        protocol_version: str = PROTOCOL_VERSION,
        log_prefix: Optional[str] = None,
    ):
        self.server_name = server_name
        self.version = version
        self.tools = list(tools)
        self.protocol_version = protocol_version
        self.log_prefix = log_prefix or f"[{server_name}]"
        self._by_name: Dict[str, ToolSpec] = {}
        for spec in self.tools:
            self._by_name[spec.name] = spec
            for alias in spec.aliases:
                self._by_name[alias] = spec

    # --- request handling -------------------------------------------------

    def handle(self, req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Return a response dict, or None for notifications (no reply)."""
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}

        if method is not None and str(method).startswith("notifications/"):
            return None

        if method == "initialize":
            return self._reply(
                req_id,
                {
                    "protocolVersion": self.protocol_version,
                    "serverInfo": {
                        "name": self.server_name,
                        "version": self.version,
                    },
                    "capabilities": {"tools": {}},
                },
            )
        if method == "tools/list":
            return self._reply(
                req_id, {"tools": [t.to_manifest() for t in self.tools]}
            )
        if method == "tools/call":
            return self._call(req_id, params)
        return self._error(req_id, -32601, f"Method {method} not handled")

    def _call(self, req_id: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        tool_name = params.get("name")
        args = params.get("arguments") or {}
        spec = self._by_name.get(tool_name)
        if spec is None:
            return self._error(req_id, -32601, f"Tool {tool_name} not found")
        try:
            text = spec.handler(args)
        except Exception as exc:  # noqa: BLE001  # surface, do not kill the server
            return self._error(req_id, -32603, f"{type(exc).__name__}: {exc}")
        return self._reply(
            req_id, {"content": [{"type": "text", "text": text}]}
        )

    @staticmethod
    def _reply(req_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    @staticmethod
    def _error(req_id: Any, code: int, message: str) -> Dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": code, "message": message},
        }

    # --- stdio loop -------------------------------------------------------

    def serve_forever(
        self,
        stdin: Optional[TextIO] = None,
        stdout: Optional[TextIO] = None,
        stderr: Optional[TextIO] = None,
    ) -> None:
        stdin = stdin if stdin is not None else sys.stdin
        stdout = stdout if stdout is not None else sys.stdout
        stderr = stderr if stderr is not None else sys.stderr
        while True:
            try:
                parsed = read_message(stdin)
                if parsed is None:
                    break
                req, use_headers = parsed
                res = self.handle(req)
                if res is not None:
                    write_message(stdout, res, use_headers)
            except json.JSONDecodeError as exc:
                stderr.write(f"{self.log_prefix} Skipping malformed message: {exc}\n")
                stderr.flush()
                continue
            except Exception as exc:  # noqa: BLE001 - stream desync ends the loop
                stderr.write(f"{self.log_prefix} Error handling request: {exc}\n")
                stderr.flush()
                break
