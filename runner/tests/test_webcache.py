#!/usr/bin/env python3
"""Tests for the WebFetch cache-through gate (webcache.py + hooks.json)."""

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

WEBCACHE = PROJECT_ROOT / "skills" / "epistemic_search" / "scripts" / "webcache.py"


def run_webcache(mode, payload=None, raw=None, cwd=None, env=None):
    stdin = raw if raw is not None else json.dumps(payload or {})
    merged = dict(__import__("os").environ)
    if env:
        merged.update(env)
    return subprocess.run(
        [sys.executable, str(WEBCACHE), mode],
        input=stdin,
        capture_output=True,
        text=True,
        cwd=str(cwd or PROJECT_ROOT),
        env=merged,
    )


def seed_source(sources_dir, url, content, cached_at=None):
    import hashlib

    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    sources_dir.mkdir(parents=True, exist_ok=True)
    sources_dir.joinpath(f"{digest}.md").write_text(content, encoding="utf-8")
    sources_dir.joinpath(f"{digest}.json").write_text(
        json.dumps(
            {
                "hash": digest,
                "url": url,
                "title": url,
                "tier": "WEB_DOCUMENT",
                "cached_at": cached_at
                or datetime.now(timezone.utc).isoformat(),
                "byte_size": len(content.encode("utf-8")),
                "char_count": len(content),
                "custom_metadata": {},
            }
        ),
        encoding="utf-8",
    )
    return digest


def hook_input(url, cwd):
    return {"tool_name": "WebFetch", "tool_input": {"url": url}, "cwd": str(cwd)}


class TestCanonicalization(unittest.TestCase):
    def test_variants_resolve_to_one_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seed_source(
                root / ".research" / "sources",
                "https://example.com/p?a=1&b=2",
                "hello cached",
            )
            for variant in [
                "https://EXAMPLE.com/p?b=2&a=1#frag",
                "https://example.com:443/p?a=1&b=2",
            ]:
                res = run_webcache("gate", hook_input(variant, root))
                self.assertEqual(res.returncode, 0)
                self.assertTrue(res.stdout.strip(), f"expected HIT for {variant}")
                out = json.loads(res.stdout)
                self.assertEqual(
                    out["hookSpecificOutput"]["permissionDecision"], "deny"
                )
                self.assertIn("hello cached", out["hookSpecificOutput"]["additionalContext"])


class TestGate(unittest.TestCase):
    def test_miss_allows_silently(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = run_webcache(
                "gate", hook_input("https://example.com/new-page", Path(tmp))
            )
            self.assertEqual(res.returncode, 0)
            self.assertEqual(res.stdout.strip(), "")

    def test_hit_serves_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            digest = seed_source(
                root / ".research" / "sources",
                "https://code.claude.com/docs/en/hooks",
                "# Hooks\n\nHook content here.",
            )
            res = run_webcache(
                "gate", hook_input("https://code.claude.com/docs/en/hooks", root)
            )
            self.assertEqual(res.returncode, 0)
            out = json.loads(res.stdout)
            hook = out["hookSpecificOutput"]
            self.assertEqual(hook["hookEventName"], "PreToolUse")
            self.assertEqual(hook["permissionDecision"], "deny")
            self.assertIn("Hook content here.", hook["additionalContext"])
            self.assertIn(f"[VERIFIED: {digest[:16]}]", hook["additionalContext"])

    def test_stale_allows_for_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
            seed_source(
                root / ".research" / "sources",
                "https://example.com/aging",
                "old content",
                cached_at=old,
            )
            res = run_webcache("gate", hook_input("https://example.com/aging", root))
            self.assertEqual(res.returncode, 0)
            self.assertEqual(res.stdout.strip(), "")

    def test_malformed_input_fails_open(self):
        for raw in ["", "not json{{{", '{"tool_input": {}}']:
            res = run_webcache("gate", raw=raw)
            self.assertEqual(res.returncode, 0, f"raw={raw!r} stderr={res.stderr}")
            self.assertEqual(res.stdout.strip(), "")


class TestArchive(unittest.TestCase):
    def test_archive_writes_matching_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = {
                "tool_name": "WebFetch",
                "tool_input": {"url": "https://example.com/live"},
                "tool_response": "# Live\n\nFresh body text.",
                "cwd": str(root),
            }
            res = run_webcache("archive", payload)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(res.stdout.strip(), "")
            sources = root / ".research" / "sources"
            md_files = list(sources.glob("*.md"))
            self.assertEqual(len(md_files), 1)
            import hashlib

            digest = hashlib.sha256("# Live\n\nFresh body text.".encode("utf-8")).hexdigest()
            self.assertEqual(md_files[0].name, f"{digest}.md")
            meta = json.loads(sources.joinpath(f"{digest}.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["url"], "https://example.com/live")
            self.assertEqual(meta["hash"], digest)
            # Idempotent: archiving again writes the same pair.
            res2 = run_webcache("archive", payload)
            self.assertEqual(res2.returncode, 0)
            self.assertEqual(len(list(sources.glob("*.md"))), 1)

    def test_archive_round_trip_gate_hit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            url = "https://example.com/roundtrip"
            run_webcache(
                "archive",
                {
                    "tool_input": {"url": url},
                    "response": "Roundtrip body.",
                    "cwd": str(root),
                },
            )
            res = run_webcache("gate", hook_input(url, root))
            out = json.loads(res.stdout)
            self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
            self.assertIn("Roundtrip body.", out["hookSpecificOutput"]["additionalContext"])


class TestStats(unittest.TestCase):
    def test_empty_is_silent(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = run_webcache("stats", {"cwd": str(Path(tmp))})
            self.assertEqual(res.returncode, 0)
            self.assertEqual(res.stdout.strip(), "")

    def test_populated_reports_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seed_source(root / ".research" / "sources", "https://a.example/1", "one")
            seed_source(root / ".research" / "sources", "https://b.example/2", "two")
            res = run_webcache("stats", {"cwd": str(root)})
            out = json.loads(res.stdout)
            self.assertIn("2 page(s) cached", out["hookSpecificOutput"]["additionalContext"])


class TestHooksManifest(unittest.TestCase):
    def test_hooks_json_wires_cache_through(self):
        hooks = json.loads(
            (PROJECT_ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8")
        )
        pre = hooks["hooks"]["PreToolUse"]
        webfetch_pre = [m for m in pre if m.get("matcher") == "WebFetch"]
        self.assertEqual(len(webfetch_pre), 1)
        pre_cmd = webfetch_pre[0]["hooks"][0]["command"]
        self.assertIn("webcache.py", pre_cmd)
        self.assertTrue(pre_cmd.rstrip().endswith("gate"))
        post = hooks["hooks"]["PostToolUse"]
        webfetch_post = [m for m in post if m.get("matcher") == "WebFetch"]
        self.assertEqual(len(webfetch_post), 1)
        post_cmd = webfetch_post[0]["hooks"][0]["command"]
        self.assertIn("webcache.py", post_cmd)
        self.assertTrue(post_cmd.rstrip().endswith("archive"))
        session_start = hooks["hooks"].get("SessionStart", [])
        self.assertTrue(
            any("webcache.py" in h.get("command", "") and h.get("command", "").rstrip().endswith("stats") for m in session_start for h in m.get("hooks", []))
        )


if __name__ == "__main__":
    unittest.main()
