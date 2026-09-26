#!/usr/bin/env python3
"""Content-addressed WebFetch cache-through gate for Claude Code hooks.

Replaces the blanket PreToolUse deny with the cache-through pattern
(proven by theYahia/claude-webcache):

  gate    (PreToolUse WebFetch): serve `.research/sources/<sha256>.md` hits
          via deny + additionalContext (no network); allow misses/stale.
  archive (PostToolUse WebFetch): store the live response as md + json
          sidecar, same layout as SourceHasher (content-hash filename).
  stats   (SessionStart): one-line cache summary via additionalContext.

Fail-open everywhere: any error exits 0 with no output (allow), logging to
stderr (visible with --debug). This is a citation-integrity control, not a
security boundary.

URL canonicalization (borrowed from webcache): lowercase host, strip default
ports and fragments, sort query parameters — so formatting variance does not
cause silent misses.

TTL: sidecar `cached_at`; default 7 days (IUMBTEMS_FETCH_TTL_DAYS), 30 days
for stable documentation domains. Inline cap for served hits: 12000 chars
(IUMBTEMS_FETCH_MAX_INLINE), remainder via file pointer.
"""

import hashlib
import json
import os
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_TTL_DAYS = 7
DOC_DOMAIN_TTL_DAYS = 30
DOC_DOMAINS = (
    "code.claude.com",
    "docs.anthropic.com",
    "platform.claude.com",
    "docs.python.org",
    "developer.mozilla.org",
)
DEFAULT_MAX_INLINE = 12000


def log(msg):
    sys.stderr.write(f"[webcache] {msg}\n")


def canonical_url(url):
    try:
        p = urllib.parse.urlsplit(url.strip())
        host = (p.hostname or "").lower()
        if not host:
            return None
        port = p.port
        if (p.scheme == "http" and port == 80) or (p.scheme == "https" and port == 443):
            port = None
        netloc = f"{host}:{port}" if port else host
        query = urllib.parse.urlencode(
            sorted(urllib.parse.parse_qsl(p.query, keep_blank_values=True))
        )
        return urllib.parse.urlunsplit((p.scheme or "https", netloc, p.path or "/", query, ""))
    except Exception:
        return None


def domain_of(url):
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except Exception:
        return ""


def ttl_days(url):
    try:
        override = int(os.environ.get("IUMBTEMS_FETCH_TTL_DAYS", ""))
        return max(override, 0)
    except ValueError:
        pass
    domain = domain_of(url)
    if any(domain == d or domain.endswith("." + d) for d in DOC_DOMAINS):
        return DOC_DOMAIN_TTL_DAYS
    return DEFAULT_TTL_DAYS


def max_inline():
    try:
        return max(int(os.environ.get("IUMBTEMS_FETCH_MAX_INLINE", "")), 1000)
    except ValueError:
        return DEFAULT_MAX_INLINE


def research_dir(stdin_data):
    base = stdin_data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return Path(base) / ".research"


def find_cached(sources_dir, url):
    """Scan json sidecars for a matching canonical URL. Returns (md_path, meta) or None."""
    canon = canonical_url(url)
    if not canon or not sources_dir.is_dir():
        return None
    for sidecar in sources_dir.glob("*.json"):
        try:
            meta = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(meta, dict):
            continue
        if canonical_url(str(meta.get("url", ""))) == canon:
            md_path = sidecar.with_suffix(".md")
            if md_path.exists():
                return md_path, meta
    return None


def is_fresh(meta, url):
    try:
        cached_at = datetime.fromisoformat(str(meta.get("cached_at", "")))
        if cached_at.tzinfo is None:
            cached_at = cached_at.replace(tzinfo=timezone.utc)
        age_days = (datetime.now(timezone.utc) - cached_at).total_seconds() / 86400
        return age_days <= ttl_days(url)
    except (ValueError, TypeError):
        return False


def cmd_gate(stdin_data):
    """PreToolUse: serve fresh hits, allow everything else (fail-open)."""
    tool_input = stdin_data.get("tool_input") or {}
    url = tool_input.get("url", "")
    if not url:
        return None  # allow
    sources_dir = research_dir(stdin_data) / "sources"
    try:
        found = find_cached(sources_dir, url)
    except Exception as e:
        log(f"cache lookup failed for {domain_of(url)}: {e}")
        return None  # allow
    if not found:
        return None  # miss -> allow, PostToolUse archives
    md_path, meta = found
    if not is_fresh(meta, url):
        log(f"stale entry for {domain_of(url)} ({meta.get('cached_at')}); allowing live fetch")
        return None  # stale -> allow, PostToolUse refreshes
    try:
        content = md_path.read_text(encoding="utf-8")
    except OSError as e:
        log(f"cache read failed: {e}")
        return None  # allow
    cap = max_inline()
    served = content if len(content) <= cap else content[:cap] + "\n\n[... truncated]"
    body = (
        f"<!-- EPISTEMIC_CACHE_HIT: {md_path.name} -->\n"
        f"**Source URL:** {url}\n"
        f"**Cached:** {meta.get('cached_at')}  **Content SHA-256:** `{meta.get('hash')}`\n"
        f"**Verification Tag:** `[VERIFIED: {str(meta.get('hash', ''))[:16]}]`\n\n"
        f"{served}\n"
    )
    if len(content) > cap:
        body += f"\n(Full cached text in {md_path}; cite the file for passages beyond the excerpt.)\n"
    log(f"cache HIT for {domain_of(url)} ({len(content)} chars, {md_path.name})")
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "Served from the epistemic content cache (.research/sources); "
                "no network fetch needed. Cite the cached file."
            ),
            "additionalContext": body,
        }
    }


def extract_response_text(stdin_data):
    """Defensively locate the tool response text across field-name variants."""
    for key in ("tool_response", "response", "tool_result", "result", "output"):
        val = stdin_data.get(key)
        if isinstance(val, str) and val.strip():
            return val
        if isinstance(val, dict):
            for sub in ("text", "content", "output"):
                inner = val.get(sub)
                if isinstance(inner, str) and inner.strip():
                    return inner
                if isinstance(inner, list):
                    parts = [
                        p.get("text", "") for p in inner
                        if isinstance(p, dict) and isinstance(p.get("text"), str)
                    ]
                    if parts:
                        return "\n".join(parts)
    return ""


def extract_url(stdin_data):
    tool_input = stdin_data.get("tool_input") or stdin_data.get("input") or {}
    if isinstance(tool_input, dict):
        url = tool_input.get("url", "")
        if url:
            return url
    # Fall back to a URL already recorded in a response envelope.
    for key in ("tool_response", "response", "tool_result"):
        val = stdin_data.get(key)
        if isinstance(val, dict) and val.get("url"):
            return val["url"]
    return ""


def cmd_archive(stdin_data):
    """PostToolUse: store the live response as md + json sidecar."""
    url = extract_url(stdin_data)
    text = extract_response_text(stdin_data)
    if not url or not text:
        return None
    try:
        sources_dir = research_dir(stdin_data) / "sources"
        sources_dir.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        sources_dir.joinpath(f"{digest}.md").write_text(text, encoding="utf-8")
        sources_dir.joinpath(f"{digest}.json").write_text(
            json.dumps(
                {
                    "hash": digest,
                    "url": url,
                    "title": url,
                    "tier": "WEB_DOCUMENT",
                    "cached_at": datetime.now(timezone.utc).isoformat(),
                    "byte_size": len(text.encode("utf-8")),
                    "char_count": len(text),
                    "custom_metadata": {"via": "webfetch-hook"},
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        log(f"archived {domain_of(url)} -> {digest[:16]} ({len(text)} chars)")
    except Exception as e:
        log(f"archive failed for {domain_of(url)}: {e}")
    return None


def cmd_stats(stdin_data):
    """SessionStart: one-line cache summary; silent when empty."""
    try:
        sources_dir = research_dir(stdin_data) / "sources"
        if not sources_dir.is_dir():
            return None
        md_files = list(sources_dir.glob("*.md"))
        if not md_files:
            return None
        return {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": (
                    f"epistemic-cache: {len(md_files)} page(s) cached in "
                    f".research/sources — WebFetch hits are served from cache."
                ),
            }
        }
    except Exception as e:
        log(f"stats failed: {e}")
        return None


def main(argv):
    mode = argv[1] if len(argv) > 1 else "gate"
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        stdin_data = json.loads(raw) if raw.strip() else {}
        if not isinstance(stdin_data, dict):
            stdin_data = {}
    except (ValueError, OSError):
        stdin_data = {}
    handler = {"gate": cmd_gate, "archive": cmd_archive, "stats": cmd_stats}.get(mode)
    if handler is None:
        log(f"unknown mode: {mode}")
        return 0
    try:
        out = handler(stdin_data)
    except Exception as e:
        log(f"{mode} failed: {e}")
        return 0  # fail-open
    if out:
        sys.stdout.write(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
