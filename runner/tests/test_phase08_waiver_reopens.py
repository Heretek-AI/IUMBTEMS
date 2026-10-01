#!/usr/bin/env python3
"""Phase 08 waiver re-opens (W9, W17, W18, W6) — R1-R4 pinning tests.

Dossier evidence hashes (`.roadmap/08-waiver-reopens/dossier.json`):
- index.js sha256:3a4a4cb6ce2bc34b72246291b321009a5a09c67c393467fd07d5cc0e68d9dac3
- configure.py sha256:10c893d88e9953174944fb04a3d49a7c9b63655a6da671d8eab0ff24b42a3425
- preflight.py sha256:762d31ced84b10e86203d88f104704c9763f23838612fba02652018a0c80797e
- mcp_server.py sha256:34276d2db3035f75dda74cf0b64cabf4325c423686de14325aec808e6da8e20f

R1 (W9): sanitizer single-segment/file:// boundary refined to
  system-internal disclosure, per-item, without over-redacting user echoes.
R2 (W17): FIFO-named-config hang hardened — bounded-reader port to PY
  `configure.py` and JS `config-io.js`; the hang-regression proof runs the
  FIFO-touching reads in a subprocess with a timeout (pre-fix they block
  forever), while in-process tests pin normal-file equivalence.
R3 (W18): `heal_config` zero-caller docstrings corrected to the true
  non-healing-read architecture (+ SKILL.md).
R4 (W6): `gate` reachable through the `iumbtems_factory` tool surface
  (PY handler forwards --run/--phase/--action/--reason; JS catalog enum).
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def run_node(code, timeout=60):
    return subprocess.run(
        ["node", "--input-type=module", "-e", code],
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
        timeout=timeout,
    )


def last_json_object(stdout):
    lines = [l.strip() for l in stdout.strip().split("\n") if l.strip().startswith("{")]
    return json.loads(lines[-1])


SETTINGS_PROLOGUE = """
import { createSettingsHandlers } from "./plugins/opencode/index.js";
function rpcCtx() {
  return {
    signal: null,
    error: (type, message, data) => {
      const e = new Error(message);
      e.type = type;
      e.data = data;
      throw e;
    },
  };
}
const FIXED = "Config write rejected: canonical config surface returned an unreadable failure.";
async function probe(items) {
  const handlers = createSettingsHandlers({
    root: "/tmp/oc-p08",
    callMcpImpl: async () => ({
      content: JSON.stringify({ status: "error", code: "CONFIG_VALIDATION_FAILED", written: false, errors: items }),
      status: "success",
    }),
    storage: null,
  });
  try {
    await handlers.set({ updates: { mode: "scout" } }, rpcCtx());
    return { threw: false };
  } catch (e) {
    return { threw: true, type: e.type || e.rpcType || null, errors: (e.data || e.rpcData || {}).errors || null };
  }
}
"""


class TestR1SanitizerBoundary(unittest.TestCase):
    """R1 (W9): single-segment system roots + file:// URIs are system-internal
    disclosures (redacted per-item); ordinary user echoes still pass."""

    CLEAN_ENUM = "mode: value 'nope' not in enum ['research', 'audit']"
    # A user-echoed single-segment value that is NOT a system root.
    CLEAN_SINGLE_SEGMENT_ECHO = "mode: value '/v1' not in enum ['research', 'audit']"

    def _probe(self, items):
        res = run_node(
            SETTINGS_PROLOGUE
            + f"""
            const out = await probe({json.dumps(items)});
            console.log(JSON.stringify(out));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        return last_json_object(res.stdout)

    def test_single_segment_system_roots_redacted(self):
        for item in (
            "python3: can't open file '/etc/iumbtems.json': [Errno 2] No such file or directory",
            "config path /tmp/pipe is not a regular file",
            "failed to read /var state",
        ):
            with self.subTest(item=item):
                d = self._probe([item])
                self.assertTrue(d["threw"])
                self.assertEqual(
                    d["errors"],
                    [
                        "Config write rejected: canonical config surface returned an "
                        "unreadable failure."
                    ],
                )

    def test_file_uris_redacted(self):
        for item in (
            "python3: can't open 'file:///etc/iumbtems/config.json': [Errno 2]",
            "fetch failed for file://server/share/config.json",
        ):
            with self.subTest(item=item):
                d = self._probe([item])
                self.assertTrue(d["threw"])
                self.assertEqual(len(d["errors"]), 1)
                self.assertTrue(d["errors"][0].startswith("Config write rejected:"))

    def test_user_echoes_still_pass(self):
        for item in (self.CLEAN_ENUM, self.CLEAN_SINGLE_SEGMENT_ECHO):
            with self.subTest(item=item):
                d = self._probe([item])
                self.assertTrue(d["threw"])
                self.assertEqual(d["errors"], [item])

    def test_per_item_design_holds(self):
        d = self._probe([self.CLEAN_ENUM, "/etc/iumbtems.json is missing"])
        self.assertTrue(d["threw"])
        self.assertEqual(len(d["errors"]), 2)
        self.assertEqual(d["errors"][0], self.CLEAN_ENUM)
        self.assertTrue(d["errors"][1].startswith("Config write rejected:"))

    def test_bare_root_trailing_punct_redacted(self):
        # REWORK-2 L1: bare-root + sentence punctuation redacts; multi-segment
        # `/etc/foo.` already redacted via the >=2-segment arm (untouched).
        for item in (
            "/lib.",
            "/etc.",
            "/lib!",
            "/tmp?",
            "/lib]",
            "/lib}",
            "error at /lib.",
            "failed on /etc!",
            "saw /tmp?",
            "x /lib] y",
            "x /lib} y",
        ):
            with self.subTest(item=item):
                d = self._probe([item])
                self.assertTrue(d["threw"])
                self.assertEqual(len(d["errors"]), 1)
                self.assertTrue(d["errors"][0].startswith("Config write rejected:"))

    def test_bracket_brace_dash_prefix_redacted(self):
        # REWORK-2 L2: `[`, `{`, `-` prefix members redact.
        for item in (
            "[/etc]",
            "[/lib]",
            "[/lib64]",
            "{/etc}",
            "-/etc",
            "x-/lib64,y",
            "error [/lib] here",
            "err {/etc} here",
        ):
            with self.subTest(item=item):
                d = self._probe([item])
                self.assertTrue(d["threw"])
                self.assertEqual(len(d["errors"]), 1)
                self.assertTrue(d["errors"][0].startswith("Config write rejected:"))

    def test_canonical_corpus_passes_verbatim(self):
        # Over-redaction gate (blocking): the full canonical-value corpus must
        # ALL pass verbatim — this is the `-`-prefix safety proof (canonical
        # values contain no `/`-root tokens, so `-`-prefixed path tokens are
        # disclosures). If any of these redacted, the `-` member must be
        # dropped and re-waived with trigger instead of forcing it.
        corpus = (
            "duckduckgo",
            "brave",
            "firecrawl",
            "searxng",
            "research",
            "audit",
            "scout",
            "hybrid",
            "brainstorm",
            "darkharvest",
            "auto",
            "claude",
            "opencode",
            "MIT",
            "Apache-2.0",
            "BSD-3-Clause",
            "ISC",
            "dag",
            "auction",
            "None",
            "2",
            "0.75",
            "true",
            "false",
            "0.88",
            "/v1",
            "reboot",
            "snapshot",
            "library book",
            self.CLEAN_ENUM,
            self.CLEAN_SINGLE_SEGMENT_ECHO,
        )
        for item in corpus:
            with self.subTest(item=item):
                d = self._probe([item])
                self.assertTrue(d["threw"])
                self.assertEqual(d["errors"], [item])


class TestR2FifoHardeningPython(unittest.TestCase):
    """R2 (W17) PY: every config.json pre-read refuses FIFOs instead of hanging."""

    def test_fifo_reads_do_not_hang(self):
        # Hang-regression proof: pre-fix, each of these blocked forever on the
        # open(). Run FIFO-touching reads in a child with a timeout.
        with tempfile.TemporaryDirectory() as tmp:
            os.mkfifo(os.path.join(tmp, "config.json"))
            code = (
                "import json, sys; "
                "sys.path.insert(0, '.'); "
                "from skills.swarm_config.configure import "
                "load_config, heal_config, config_hash, snapshot; "
                f"d = {json.dumps(tmp)}; "
                "cfg = load_config(d); "
                "assert isinstance(cfg, dict) and cfg.get('mode') == 'research', cfg.get('mode'); "
                "assert heal_config(d) is False; "
                "assert config_hash(d) is None; "
                "snap = snapshot(d); "
                "assert snap['hash'] is None and snap['config'].get('mode') == 'research'; "
                "print(json.dumps({'ok': True})); "
            )
            res = subprocess.run(
                [sys.executable, "-c", code],
                capture_output=True,
                text=True,
                cwd=str(PROJECT_ROOT),
                timeout=60,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertTrue(json.loads(res.stdout.strip())["ok"])

    def test_fifo_save_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.mkfifo(os.path.join(tmp, "config.json"))
            code = (
                "import sys\n"
                "sys.path.insert(0, '.')\n"
                "from skills.swarm_config.configure import save_config, ConfigError\n"
                f"d = {json.dumps(tmp)}\n"
                "try:\n"
                "    save_config({'mode': 'audit'}, d)\n"
                "    print('SAVED')\n"
                "except ConfigError as exc:\n"
                "    print('REFUSED:' + exc.code)\n"
            )
            res = subprocess.run(
                [sys.executable, "-c", code],
                capture_output=True,
                text=True,
                cwd=str(PROJECT_ROOT),
                timeout=60,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertTrue(
                res.stdout.strip().startswith("REFUSED:CONFIG_UNREADABLE"),
                res.stdout,
            )

    def test_normal_files_unchanged(self):
        # Blast-radius pin: regular files behave byte-identically (hash over
        # exact bytes, merge, round-trip).
        from skills.swarm_config.configure import (
            config_hash,
            load_config,
            save_config,
        )

        with tempfile.TemporaryDirectory() as tmp:
            raw = b'{"mode": "audit", "max_iterations": 3}'
            (Path(tmp) / "config.json").write_bytes(raw)
            self.assertEqual(config_hash(tmp), hashlib.sha256(raw).hexdigest())
            cfg = load_config(tmp)
            self.assertEqual(cfg["mode"], "audit")
            self.assertEqual(cfg["max_iterations"], 3)
            # Defaults still merge under a partial file.
            self.assertEqual(cfg["search_engine"], "duckduckgo")
            save_config({"search_engine": "searxng"}, tmp)
            self.assertEqual(load_config(tmp)["search_engine"], "searxng")
            self.assertEqual(load_config(tmp)["mode"], "audit")


class TestR2FifoHardeningJs(unittest.TestCase):
    """R2 (W17) JS: config-io readers refuse FIFOs; save fails closed."""

    def test_fifo_reads_do_not_hang(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.mkfifo(os.path.join(tmp, "config.json"))
            res = run_node(
                f"""
                import {{ readConfigSnapshot, loadConfig, readRawConfig, saveConfig }} from "./plugins/opencode/config-io.js";
                const dir = {json.dumps(tmp)};
                const snap = readConfigSnapshot(dir);
                const cfg = loadConfig(dir);
                const raw = readRawConfig(dir);
                let saved = "no-throw";
                try {{
                  saveConfig({{ mode: "audit" }}, dir);
                }} catch (e) {{
                  saved = e && e.code ? e.code : "threw";
                }}
                console.log(JSON.stringify({{
                  hash: snap.hash, malformed: snap.malformed, raw,
                  mode: cfg && cfg.mode, engine: cfg && cfg.search_engine,
                  saved,
                }}));
                """,
                timeout=60,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            # FIFO refused: no hash, no raw, defaults, save refused — and the
            # process returned instead of hanging.
            self.assertIsNone(d["hash"])
            self.assertIsNone(d["raw"])
            self.assertEqual(d["mode"], "research")
            self.assertEqual(d["engine"], "duckduckgo")
            self.assertEqual(d["saved"], "CONFIG_UNREADABLE")

    def test_normal_files_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "config.json").write_text(
                '{"mode": "audit", "max_iterations": 3}', encoding="utf-8"
            )
            res = run_node(
                f"""
                import {{ readConfigSnapshot, loadConfig }} from "./plugins/opencode/config-io.js";
                const dir = {json.dumps(tmp)};
                const snap = readConfigSnapshot(dir);
                const cfg = loadConfig(dir);
                console.log(JSON.stringify({{ hash: snap.hash, mode: cfg.mode, depth: cfg.max_iterations, engine: cfg.search_engine }}));
                """,
                timeout=60,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            self.assertEqual(
                d["hash"],
                hashlib.sha256(b'{"mode": "audit", "max_iterations": 3}').hexdigest(),
            )
            self.assertEqual(d["mode"], "audit")
            self.assertEqual(d["depth"], 3)
            self.assertEqual(d["engine"], "duckduckgo")


class TestR3HealConfigDocs(unittest.TestCase):
    """R3 (W18): docstrings describe the true non-healing-read architecture."""

    def test_configure_docstrings_state_non_healing_truth(self):
        text = (PROJECT_ROOT / "skills" / "swarm_config" / "configure.py").read_text(
            encoding="utf-8"
        )
        # The false live-healing claim is gone...
        self.assertNotIn("the CLI and MCP surfaces call this", text)
        self.assertNotIn("persists that migration on next touch", text)
        # ...replaced by the non-healing truth naming every non-healing read.
        self.assertIn("NO\n    production read path calls this", text)
        self.assertIn("non-healing", text)
        for marker in ("`--show`", "`load_config`", "opportunistically"):
            self.assertIn(marker, text)

    def test_skill_doc_states_non_healing_truth(self):
        text = (PROJECT_ROOT / "skills" / "swarm_config" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("Non-healing reads", text)
        self.assertIn("no production", text)

    def test_heal_config_still_exported_and_safe(self):
        from skills.swarm_config import heal_config

        with tempfile.TemporaryDirectory() as tmp:
            # Absent file: nothing to heal.
            self.assertFalse(heal_config(tmp))


class TestR4GateSurface(unittest.TestCase):
    """R4 (W6): gate reachable through the iumbtems_factory tool surface."""

    def test_handler_forwards_gate(self):
        from runner.mcp_server import _handle_factory

        with tempfile.TemporaryDirectory() as tmp:
            init = json.loads(
                _handle_factory(
                    {"command": "init", "run": "p08-gate", "project_dir": tmp}
                )
            )
            self.assertEqual(init["status"], "ok")
            opened = json.loads(
                _handle_factory(
                    {
                        "command": "gate",
                        "action": "open",
                        "run": "p08-gate",
                        "phase": "08-waiver-reopens",
                        "project_dir": tmp,
                    }
                )
            )
            self.assertEqual(opened["status"], "ok", opened)
            self.assertEqual(opened["command"], "gate")
            state = json.loads(
                (Path(tmp) / ".factory" / "p08-gate" / "state.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(state["gates"]["08-waiver-reopens"]["status"], "open")
            counted = json.loads(
                _handle_factory(
                    {
                        "command": "gate",
                        "action": "count",
                        "run": "p08-gate",
                        "phase": "08-waiver-reopens",
                        "project_dir": tmp,
                    }
                )
            )
            self.assertEqual(counted["status"], "ok", counted)
            settled = json.loads(
                _handle_factory(
                    {
                        "command": "gate",
                        "action": "settle",
                        "run": "p08-gate",
                        "phase": "08-waiver-reopens",
                        "reason": "phase-08 receipt",
                        "project_dir": tmp,
                    }
                )
            )
            self.assertEqual(settled["status"], "ok", settled)
            state = json.loads(
                (Path(tmp) / ".factory" / "p08-gate" / "state.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(state["gates"]["08-waiver-reopens"]["status"], "settled")

    def test_handler_rejects_bad_action_and_bad_command(self):
        from runner.mcp_server import _handle_factory

        with tempfile.TemporaryDirectory() as tmp:
            _handle_factory(
                {"command": "init", "run": "p08-gate-bad", "project_dir": tmp}
            )
            bad = json.loads(
                _handle_factory(
                    {
                        "command": "gate",
                        "action": "frobnicate",
                        "run": "p08-gate-bad",
                        "phase": "x",
                        "project_dir": tmp,
                    }
                )
            )
            # Invalid action: the helper exits 2 (argparse), which the handler
            # surfaces as escalated/error — never ok.
            self.assertIn(bad["status"], ("error", "escalated"), bad)
            self.assertEqual(bad["returncode"], 2, bad)
            with self.assertRaises(ValueError):
                _handle_factory({"command": "launch", "project_dir": tmp})

    def test_tool_spec_and_js_catalog_advertise_gate(self):
        from runner.mcp_server import build_tools

        spec = next(t for t in build_tools() if t.name == "iumbtems_factory")
        schema = spec.input_schema
        self.assertIn("gate", schema["properties"]["command"]["enum"])
        self.assertIn(
            "open",
            schema["properties"]["action"]["enum"],
        )
        for action in ("settle", "approve", "waive", "escalate", "count"):
            self.assertIn(action, schema["properties"]["action"]["enum"])
        res = run_node(
            """
            import { TOOL_CATALOG } from "./plugins/opencode/index.js";
            const entry = TOOL_CATALOG.find((t) => t.name === "iumbtems_factory");
            console.log(JSON.stringify({ input: entry.input, description: entry.description }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        advertised = last_json_object(res.stdout)
        self.assertIn("gate", advertised["input"]["properties"]["command"]["enum"])
        for action in ("open", "settle", "approve", "waive", "escalate", "count"):
            self.assertIn(action, advertised["input"]["properties"]["action"]["enum"])
        self.assertIn("gate", advertised["description"])
        # The Pi extension declares its own factory surface (thin passthrough
        # to the same MCP tool): pin its enum by text — importing the Pi
        # harness here would couple this suite to its host mocks.
        pi_text = (PROJECT_ROOT / "extensions" / "pi" / "index.js").read_text(
            encoding="utf-8"
        )
        pi_factory = pi_text[
            pi_text.index("name: 'iumbtems_factory'") : pi_text.index(
                "name: 'iumbtems_factory'"
            )
            + 1500
        ]
        self.assertIn("'gate'", pi_factory)
        for action in ("open", "settle", "approve", "waive", "escalate", "count"):
            self.assertIn(f"'{action}'", pi_factory)


if __name__ == "__main__":
    unittest.main()
