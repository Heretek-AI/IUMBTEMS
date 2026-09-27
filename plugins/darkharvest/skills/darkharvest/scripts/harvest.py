#!/usr/bin/env python3
"""
Darkharvest fetch helper: clone-to-temp + allowlisted scan + SHA-256 cache.

Read-only. Never installs dependencies. Never writes outside .research/
(except the temp clone, which is dropped). Enforces per-repo caps so
`--max-repos 10 --depth 3` style defaults cannot OOM the host.

Usage:
  python3 skills/darkharvest/scripts/harvest.py --repo <url> [--show-context]
  python3 skills/darkharvest/scripts/harvest.py --repo <url> --export <path>

Closed / non-cloneable targets: prints a metadata-only stub with a
[NEGATIVE_KNOWLEDGE] gap note instead of failing.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from skills.research_cache.hasher import SourceHasher  # noqa: E402

SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".next",
    ".research",
    "coverage",
}
MANIFEST_FILES = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "requirements.txt",
    "LICENSE",
    "LICENSE.md",
    "README.md",
]
TEXT_EXTS = {".md", ".json", ".toml", ".yaml", ".yml", ".txt", ".py", ".js", ".ts"}

DEFAULT_MAX_FILES = 120
DEFAULT_MAX_BYTES = 400_000
DEFAULT_TIMEOUT = 120
DEFAULT_BASE_DIR = ".research"
MAX_SCAN_DEPTH = 3
MAX_SINGLE_FILE_BYTES = 100_000
SNIPPET_CHARS = 4000

SPDX_APACHE2 = "Apache-2.0"
PERMISSIVE_SPDX = frozenset({"MIT", SPDX_APACHE2, "BSD-3-Clause", "ISC"})
COPYLEFT_SPDX = frozenset({"GPL", "AGPL"})

SPDX_MAP = {
    "mit": "MIT",
    "apache-2.0": SPDX_APACHE2,
    "apache 2.0": SPDX_APACHE2,
    "bsd-3-clause": "BSD-3-Clause",
    "bsd 3-clause": "BSD-3-Clause",
    "isc": "ISC",
    "gpl": "GPL",
    "agpl": "AGPL",
    "mpl": "MPL",
    "lgpl": "LGPL",
}


def sh(cmd, cwd=None, timeout=DEFAULT_TIMEOUT):
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(cwd or PROJECT_ROOT),
            timeout=timeout,
        )
        return r.returncode, (r.stdout or "").strip()
    except Exception as exc:  # noqa: BLE001
        return 1, f"error: {exc}"


def detect_license(text):
    low = (text or "").lower()
    for key, spdx in SPDX_MAP.items():
        if key in low:
            return spdx
    return "UNKNOWN"


def scan_tree(root, max_files=DEFAULT_MAX_FILES, max_bytes=DEFAULT_MAX_BYTES):
    root = Path(root)
    state = _ScanState()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        rel = Path(dirpath).relative_to(root)
        if (len(rel.parts) if str(rel) != "." else 0) > MAX_SCAN_DEPTH:
            dirnames[:] = []
            continue
        prefix = "" if str(rel) == "." else str(rel) + os.sep
        for f in sorted(filenames):
            if state.capped(max_files, max_bytes):
                return state.finish(truncated=True)
            _scan_file(dirpath, prefix + f, state)
    return state.finish(truncated=False)


class _ScanState:
    """Mutable accumulator for one scan_tree pass (keeps helpers small)."""

    def __init__(self):
        self.entries = []
        self.total_bytes = 0
        self.manifests = {}
        self.license_text = ""
        self.readme_head = ""

    def capped(self, max_files, max_bytes):
        return len(self.entries) >= max_files or self.total_bytes >= max_bytes

    def finish(self, truncated):
        return (
            self.entries,
            self.manifests,
            self.license_text,
            self.readme_head,
            truncated,
        )


def _scan_file(dirpath, rel_entry, state):
    filename = os.path.basename(rel_entry)
    try:
        size = (Path(dirpath) / filename).stat().st_size
    except OSError:
        return
    if size > MAX_SINGLE_FILE_BYTES:
        return
    state.entries.append(rel_entry)
    if filename in MANIFEST_FILES or Path(filename).suffix in TEXT_EXTS:
        _capture_text(dirpath, filename, state)


def _capture_text(dirpath, filename, state):
    try:
        content = (Path(dirpath) / filename).read_text(
            encoding="utf-8", errors="replace"
        )
    except OSError:
        return
    state.total_bytes += len(content.encode("utf-8", errors="replace"))
    snippet = content[:SNIPPET_CHARS]
    if filename in MANIFEST_FILES and filename not in state.manifests:
        state.manifests[filename] = snippet
    lowered = filename.lower()
    if lowered.startswith("license") and not state.license_text:
        state.license_text = snippet
    if lowered == "readme.md" and not state.readme_head:
        state.readme_head = snippet


def harvest_repo(
    url,
    max_files=DEFAULT_MAX_FILES,
    max_bytes=DEFAULT_MAX_BYTES,
    timeout=DEFAULT_TIMEOUT,
    base_dir=DEFAULT_BASE_DIR,
):
    started = datetime.now(timezone.utc).isoformat()
    tmp = tempfile.mkdtemp(prefix="darkharvest-")
    try:
        code, out = sh(["git", "clone", "--depth", "1", url, tmp], timeout=timeout)
        if code != 0:
            return {
                "url": url,
                "status": "metadata-only",
                "generated_at": started,
                "negative_knowledge": (
                    f"[NEGATIVE_KNOWLEDGE: clone failed for {url}; "
                    f"used metadata-only row. Detail: {out[:200]}]"
                ),
            }
        entries, manifests, license_text, readme_head, truncated = scan_tree(
            Path(tmp), max_files=max_files, max_bytes=max_bytes
        )
        spdx = detect_license(license_text + manifests.get("package.json", ""))
        harvestable = (
            "depend-or-vendor" if spdx in PERMISSIVE_SPDX else "clean-room-rebuild-only"
        )
        hasher = SourceHasher(Path(base_dir))
        cache_blob = (
            f"# {url}\n\nSPDX: {spdx}\n\n"
            f"## README head\n{readme_head[:2000]}\n\n"
            f"## Tree sample ({len(entries)} entries)\n" + "\n".join(entries[:60])
        )
        source_hash = hasher.store_source(url, cache_blob, f"Darkharvest {url}")
        warnings = []
        if spdx in COPYLEFT_SPDX:
            warnings.append(
                "⚠️ LICENSE: strong copyleft — spec rebuild only, never vendor"
            )
        elif spdx == "UNKNOWN":
            warnings.append("⚠️ LICENSE: unknown — treat as clean-room-rebuild-only")
        if truncated:
            warnings.append(
                "⚠️ SCAN: truncated by file/byte caps; treat as partial evidence"
            )
        return {
            "url": url,
            "status": "scanned",
            "generated_at": started,
            "spdx": spdx,
            "harvest_policy": harvestable,
            "tree_entries": len(entries),
            "truncated": truncated,
            "source_hash": source_hash,
            "readme_head": readme_head[:1500],
            "manifests_seen": sorted(manifests.keys()),
            "warnings": warnings,
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Darkharvest competitor fetch helper")
    ap.add_argument("--repo", required=True, help="Competitor repo URL to scan")
    ap.add_argument("--show-context", action="store_true")
    ap.add_argument("--export", default="")
    ap.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    ap.add_argument("--dir", default=DEFAULT_BASE_DIR)
    args = ap.parse_args()

    if not re.match(r"^https?://", args.repo):
        print(f"WARN: {args.repo} is not an http(s) URL; metadata-only stub emitted.")
        result = {
            "url": args.repo,
            "status": "metadata-only",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "negative_knowledge": (
                f"[NEGATIVE_KNOWLEDGE: non-cloneable target {args.repo}]"
            ),
        }
    else:
        result = harvest_repo(
            args.repo,
            max_files=args.max_files,
            max_bytes=args.max_bytes,
            timeout=args.timeout,
            base_dir=args.dir,
        )

    if args.show_context or not args.export:
        print(f"\n🌑 [Darkharvest] {result['url']} → {result['status']}")
        for key in ("spdx", "harvest_policy", "tree_entries", "source_hash"):
            if key in result:
                print(f"  {key}: {result[key]}")
        for w in result.get("warnings", []):
            print(f"  {w}")
        if result.get("negative_knowledge"):
            print(f"  {result['negative_knowledge'][:200]}")

    if args.export:
        out = Path(os.path.realpath(args.export))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"✅ Harvest scan exported to {out}")


if __name__ == "__main__":
    main()
