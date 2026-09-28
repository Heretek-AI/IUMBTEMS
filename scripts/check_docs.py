#!/usr/bin/env python3
"""Fail CI when a documentation reference points at a file that does not exist.

Only *repo-relative* paths are checked (a leading known source directory); bare
names like `manifest.json` or `hasher.py` are workspace-relative and must not be
flagged. This is the guard for drifts like the recorded
`skills/grilling/SKILL.md` `--export` reference (issue #6 item 3.11).
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DOC_FILES = ["README.md", "AGENTS.md", "MARKETPLACE.md"]
DOC_FILES += [
    str(p.relative_to(PROJECT_ROOT)) for p in (PROJECT_ROOT / "docs").glob("*.md")
]

REPO_PREFIXES = (
    "runner/",
    "skills/",
    "scripts/",
    "plugins/",
    "prompts/",
    "config/",
    "schemas/",
    "docs/",
    "extensions/",
    "hooks/",
    ".claude-plugin/",
    ".omp/",
    ".agents/",
)
PATH_RE = re.compile(r"`([A-Za-z0-9_./-]+/[A-Za-z0-9_./-]+)`")


def missing_references() -> list:
    missing = []
    for rel in DOC_FILES:
        path = PROJECT_ROOT / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for ref in set(PATH_RE.findall(text)):
            if any(ch in ref for ch in "{}*"):
                continue
            if not ref.startswith(REPO_PREFIXES):
                continue
            if not (PROJECT_ROOT / ref.split("#")[0]).exists():
                missing.append((rel, ref))
    return sorted(set(missing))


def main() -> int:
    missing = missing_references()
    if missing:
        for doc, ref in missing:
            print(f"❌ {doc}: references missing path `{ref}`", file=sys.stderr)
        return 1
    print(f"✅ {len(DOC_FILES)} docs: all repo-relative references resolve.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
