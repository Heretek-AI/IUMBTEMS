#!/usr/bin/env python3
"""
Brainstorm scaffolding: dynamic context ingestion + domain model extraction.
Read-only. Never exceeds a capped budget. Used by /brainstorming skill and
runner/research_swarm.py --mode brainstorm.
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
STACK_FILES = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "requirements.txt",
    "requirements-dev.txt",
    "bun.lock",
    "pom.xml",
]
DOC_CANDIDATES = [
    "README.md",
    "AGENTS.md",
    "GEMINI.md",
    "SYSTEM.md",
    "docs/SYSTEM_ARCHITECTURE.md",
    "docs/DISTRIBUTION_STRATEGY.md",
]
SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".research",
    "target",
    ".next",
}


def sh(cmd, cwd=None):
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(cwd or PROJECT_ROOT),
            timeout=30,
        )
        return (r.stdout or "").strip()
    except Exception:
        return ""


def project_tree(depth=3, limit=200):
    entries = []
    root = PROJECT_ROOT
    for dirpath, dirnames, filenames in __import__("os").walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        rel = Path(dirpath).relative_to(root)
        d = len(rel.parts) if str(rel) != "." else 0
        if d > depth:
            dirnames[:] = []
            continue
        for f in sorted(filenames)[:50]:
            entries.append(str(rel / f) if str(rel) != "." else f)
            if len(entries) >= limit:
                return entries
    return entries


def read_capped(path, cap=6000):
    p = PROJECT_ROOT / path
    if not p.exists() or not p.is_file():
        return ""
    try:
        return p.read_text(encoding="utf-8", errors="replace")[:cap]
    except Exception:
        return ""


def grep_todos(limit=30):
    out = sh(
        [
            "git",
            "grep",
            "-n",
            "-E",
            "TODO|FIXME|HACK|XXX",
            "--",
            ".",
            ":(exclude).research",
        ]
    )
    if not out:
        # fallback without git
        out = sh(
            [
                "grep",
                "-rn",
                "-E",
                "TODO|FIXME|HACK|XXX",
                "--include=*.py",
                "--include=*.ts",
                "--include=*.js",
                "--include=*.md",
                ".",
            ]
        )
    lines = [l for l in out.splitlines() if ".research" not in l][:limit]
    return lines


def detect_stack():
    found = []
    for f in STACK_FILES:
        if (PROJECT_ROOT / f).exists():
            found.append(f)
    return found


def build_domain_model(objective, full=True):
    tree = project_tree(depth=3 if full else 1, limit=200 if full else 60)
    docs = {
        d: read_capped(d, 4000 if full else 1500)
        for d in DOC_CANDIDATES
        if (PROJECT_ROOT / d).exists()
    }
    git_log = sh(["git", "log", "--oneline", "-20"]) if full else ""
    git_status = sh(["git", "status", "--short"])
    todos = grep_todos(30 if full else 10)
    stack = detect_stack()
    model = {
        "objective": objective,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "domain": "",
        "entities": [],
        "constraints": [],
        "stack": stack,
        "tree_sample": tree[:80],
        "docs_seen": sorted(docs.keys()),
        "git_log": git_log.splitlines()[:20],
        "git_status": git_status.splitlines()[:20],
        "open_loops": todos,
    }
    return model, docs


def main():
    ap = argparse.ArgumentParser(description="IUMBTEMS brainstorm context ingestion")
    ap.add_argument("--objective", required=True)
    ap.add_argument("--show-context", action="store_true")
    ap.add_argument(
        "--export", default="", help="Export domain_model.json to this path"
    )
    ap.add_argument(
        "--shallow",
        action="store_true",
        help="Shallow mode: README + top-level only (low context budget)",
    )
    args = ap.parse_args()

    model, docs = build_domain_model(args.objective, full=not args.shallow)

    if args.show_context or not args.export:
        print(f"\n🧠 [Brainstorm] Objective: {args.objective}")
        print(f"📁 Tree entries sampled: {len(model['tree_sample'])}")
        print(f"📄 Docs ingested: {', '.join(model['docs_seen']) or 'none'}")
        print(f"🧱 Stack signals: {', '.join(model['stack']) or 'none'}")
        print(f"📝 Open loops: {len(model['open_loops'])}")
        for t in model["open_loops"][:10]:
            print(f"   - {t[:160]}")
        if model["git_log"]:
            print("🕘 Recent history:")
            for line in model["git_log"][:10]:
                print(f"   {line[:140]}")
        print("\nDomain model (fill domain/entities/constraints before ideating):")
        print(
            json.dumps(
                {k: model[k] for k in ("domain", "entities", "constraints", "stack")},
                indent=2,
            )
        )

    if args.export:
        out = Path(args.export)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(model, indent=2), encoding="utf-8")
        print(f"✅ Domain model exported to {out}")


if __name__ == "__main__":
    main()
