#!/usr/bin/env python3
"""
IUMBTEMS Universal Harness Adapter builder.
Single canonical source of truth: skills/*/SKILL.md + prompts/*.md.
Generates target-specific mirrors (copies, never symlinks so npm publish,
agy/gemini installs, and Codex/OMP discovery all work from plain files):

  plugins/antigravity/skills/<skill>/  <- skills/<skill> (SKILL.md + scripts + .py)
  plugins/gemini/skills/<skill>/        <- skills/<skill>
  plugins/codex/skills/<skill>/         <- skills/<skill> (SKILL.md only + runner pointers)
  .agents/skills/<skill>/               <- skills/<skill> (Codex repo-local discovery)
  .omp/skills mirror is NOT needed (OMP reads skills/ directly + .omp/commands)

Also validates every manifest referenced in package.json pi/omp blocks.

Usage:
  python3 scripts/build_adapters.py            # build all mirrors
  python3 scripts/build_adapters.py --check     # verify mirrors are in sync (CI)
  python3 scripts/build_adapters.py --clean     # remove generated mirrors
"""

import argparse
import filecmp
import json
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CANONICAL_SKILLS = [
    "grilling",
    "research_cache",
    "epistemic_search",
    "swarm_config",
    "code_audit",
    "oss_scout",
    "brainstorming",
]

# (target dir relative to root, copy mode)
# "full" = whole skill dir; "skill-md" = SKILL.md + scripts/ only (lean for Codex)
TARGETS = [
    ("plugins/antigravity/skills", "full"),
    ("plugins/gemini/skills", "full"),
    ("plugins/codex/skills", "skill-md"),
    (".agents/skills", "skill-md"),
]

SKILL_MD_ONLY_KEEP = {"SKILL.md", "scripts", "__init__.py"}


def copy_skill(src: Path, dst: Path, mode: str):
    if dst.exists():
        shutil.rmtree(dst)
    if mode == "full":
        shutil.copytree(
            src,
            dst,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
        )
    else:
        dst.mkdir(parents=True, exist_ok=True)
        for child in sorted(src.iterdir()):
            if child.name in ("__pycache__", ".DS_Store"):
                continue
            if child.name in SKILL_MD_ONLY_KEEP:
                if child.is_dir():
                    shutil.copytree(
                        child,
                        dst / child.name,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
                    )
                else:
                    shutil.copy2(child, dst / child.name)


def build():
    count = 0
    for target_rel, mode in TARGETS:
        target_base = PROJECT_ROOT / target_rel
        target_base.mkdir(parents=True, exist_ok=True)
        for skill in CANONICAL_SKILLS:
            src = PROJECT_ROOT / "skills" / skill
            if not src.exists():
                print(
                    f"[WARN] canonical skill missing: skills/{skill}", file=sys.stderr
                )
                continue
            if not (src / "SKILL.md").exists():
                print(f"[WARN] skills/{skill}/SKILL.md missing", file=sys.stderr)
                continue
            copy_skill(src, target_base / skill, mode)
            count += 1
    print(f"✅ Built {count} skill mirrors across {len(TARGETS)} targets.")
    return 0


def check():
    """Verify mirrors match canonical sources (file-by-file compare)."""
    errors = []
    for target_rel, mode in TARGETS:
        for skill in CANONICAL_SKILLS:
            src = PROJECT_ROOT / "skills" / skill
            dst = PROJECT_ROOT / target_rel / skill
            if not dst.exists():
                errors.append(f"MISSING mirror: {target_rel}/{skill}")
                continue
            for src_file in src.rglob("*"):
                if "__pycache__" in src_file.parts or src_file.suffix == ".pyc":
                    continue
                if mode == "skill-md":
                    rel = src_file.relative_to(src)
                    if rel.parts[0] not in SKILL_MD_ONLY_KEEP:
                        continue
                rel = src_file.relative_to(src)
                dst_file = dst / rel
                if src_file.is_file() and (
                    not dst_file.exists()
                    or not filecmp.cmp(src_file, dst_file, shallow=False)
                ):
                    errors.append(f"OUT OF SYNC: {target_rel}/{skill}/{rel}")
    # Validate package.json pi/omp blocks resolve
    pkg = json.loads((PROJECT_ROOT / "package.json").read_text())
    for key in ("pi", "omp"):
        block = pkg.get(key, {})
        for kind in ("skills", "extensions", "prompts"):
            for p in block.get(kind, []):
                # glob patterns allowed in prompts
                if "*" in p:
                    if not list(PROJECT_ROOT.glob(p.lstrip("./"))):
                        errors.append(
                            f"package.json {key}.{kind} glob matches nothing: {p}"
                        )
                elif not (PROJECT_ROOT / p.lstrip("./")).exists():
                    errors.append(f"package.json {key}.{kind} missing: {p}")
    if errors:
        print("❌ Adapter check failed:")
        for e in errors:
            print(f"   - {e}")
        return 1
    print("✅ All adapter mirrors in sync; package.json pi/omp blocks resolve.")
    return 0


def clean():
    for target_rel, _ in TARGETS:
        base = PROJECT_ROOT / target_rel
        if base.exists():
            shutil.rmtree(base)
            print(f"Removed {target_rel}")


def main():
    ap = argparse.ArgumentParser(description="IUMBTEMS adapter builder")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()
    if args.clean:
        return clean()
    if args.check:
        return check()
    return build()


if __name__ == "__main__":
    sys.exit(main())
