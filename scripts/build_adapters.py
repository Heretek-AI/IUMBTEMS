#!/usr/bin/env python3
"""
IUMBTEMS Universal Harness Adapter builder.

Single canonical source of truth: skills/*/SKILL.md + prompts/*.md.
Since the MCP-canonical migration (Stream A2b), harness mirrors are THIN STUBS,
not code copies: each target skill dir holds one ~10-line SKILL.md pointing at
the canonical prose (skills/<skill>/) and the canonical programmatic surface
(runner/mcp_server.py). Full skill copies were retired deliberately — see
.research/scratchpads/brainstorm_where-do-we-go-from-here/g1_probe.md.

Targets (each gets one stub per canonical skill):
  plugins/antigravity/skills/<skill>/SKILL.md
  plugins/gemini/skills/<skill>/SKILL.md
  plugins/codex/skills/<skill>/SKILL.md
  .agents/skills/<skill>/SKILL.md

Also validates every manifest referenced in package.json pi/omp blocks.

Usage:
  python3 scripts/build_adapters.py            # build all stubs
  python3 scripts/build_adapters.py --check     # verify stubs match template (CI)
  python3 scripts/build_adapters.py --clean     # remove generated stubs
"""

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import List

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

# Skill -> the MCP tool(s) that now carry its programmatic surface.
SKILL_TOOLS = {
    "grilling": ["iumbtems_socratic_frontier"],
    "research_cache": ["iumbtems_verify_quote"],
    "epistemic_search": ["brave_web_search / firecrawl_scrape (research MCP servers)"],
    "swarm_config": ["iumbtems_config"],
    "code_audit": ["iumbtems_code_audit"],
    "oss_scout": ["iumbtems_oss_scout"],
    "brainstorming": ["iumbtems_brainstorm"],
}

SKILL_TITLES = {
    "grilling": "Socratic Grilling",
    "research_cache": "Research Cache",
    "epistemic_search": "Epistemic Search",
    "swarm_config": "Swarm Config",
    "code_audit": "Code Audit",
    "oss_scout": "OSS Scout",
    "brainstorming": "Brainstorming",
}

# (target dir relative to root, mode). All targets are stubs since A2b.
TARGETS = [
    ("plugins/antigravity/skills", "stub"),
    ("plugins/gemini/skills", "stub"),
    ("plugins/codex/skills", "stub"),
    (".agents/skills", "stub"),
]

STUB_TEMPLATE = """# {title} (thin adapter stub)

This file is a POINTER, not the implementation. It exists so harness skill
discovery finds an entry; the real skill lives in the IUMBTEMS repo.

- Canonical prose & scripts: `skills/{skill}/`
- Canonical programmatic surface: `python3 runner/mcp_server.py` (stdio MCP),
  or one-shot: `python3 runner/mcp_server.py call <tool> '{{...json...}}'`
- MCP tools for this skill: {tools}

Epistemic rules apply regardless of harness: tag claims as
`[VERIFIED: <hash>]`, `[INFERRED: <reasoning>]`, `[HYPOTHESIS: <test>]`, or
`[NEGATIVE_KNOWLEDGE: <query>]`. Writes go only to `.research/`.
"""


SKILL_FILENAME = "SKILL.md"


def render_stub(skill: str) -> str:
    tools = ", ".join(f"`{t}`" for t in SKILL_TOOLS.get(skill, []))
    return STUB_TEMPLATE.format(
        title=SKILL_TITLES.get(skill, skill.replace("_", " ").title()),
        skill=skill,
        tools=tools,
    )


def _build_skill_stub(target_base: Path, skill: str) -> bool:
    src = PROJECT_ROOT / "skills" / skill
    if not src.exists():
        print(f"[WARN] canonical skill missing: skills/{skill}", file=sys.stderr)
        return False
    if not (src / SKILL_FILENAME).exists():
        print(f"[WARN] skills/{skill}/{SKILL_FILENAME} missing", file=sys.stderr)
        return False
    dst = target_base / skill
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True, exist_ok=True)
    (dst / SKILL_FILENAME).write_text(render_stub(skill), encoding="utf-8")
    return True


def build():
    count = 0
    for target_rel, _mode in TARGETS:
        target_base = PROJECT_ROOT / target_rel
        target_base.mkdir(parents=True, exist_ok=True)
        for skill in CANONICAL_SKILLS:
            if _build_skill_stub(target_base, skill):
                count += 1
    print(f"✅ Built {count} thin skill stubs across {len(TARGETS)} targets.")
    return 0


def _check_skill_stub(target_rel: str, skill: str) -> List[str]:
    errors = []
    dst = PROJECT_ROOT / target_rel / skill / SKILL_FILENAME
    if not dst.exists():
        return [f"MISSING stub: {target_rel}/{skill}/{SKILL_FILENAME}"]
    if dst.read_text(encoding="utf-8") != render_stub(skill):
        errors.append(f"OUT OF SYNC: {target_rel}/{skill}/{SKILL_FILENAME}")
    stray = [
        p.name
        for p in (PROJECT_ROOT / target_rel / skill).iterdir()
        if p.name != SKILL_FILENAME
    ]
    if stray:
        errors.append(f"STRAY FILES in {target_rel}/{skill}: {sorted(stray)}")
    return errors


def _check_package_json() -> List[str]:
    errors = []
    pkg = json.loads((PROJECT_ROOT / "package.json").read_text())
    for key in ("pi", "omp"):
        block = pkg.get(key, {})
        for kind in ("skills", "extensions", "prompts"):
            for p in block.get(kind, []):
                if "*" in p:
                    if not list(PROJECT_ROOT.glob(p.lstrip("./"))):
                        errors.append(f"package.json {key}.{kind} glob matches nothing: {p}")
                elif not (PROJECT_ROOT / p.lstrip("./")).exists():
                    errors.append(f"package.json {key}.{kind} missing: {p}")
    return errors


def check():
    """Verify stubs match the generated template (not the skill bodies)."""
    errors = []
    for target_rel, _mode in TARGETS:
        for skill in CANONICAL_SKILLS:
            errors.extend(_check_skill_stub(target_rel, skill))
    errors.extend(_check_package_json())
    if errors:
        print("❌ Adapter check failed:")
        for e in errors:
            print(f"   - {e}")
        return 1
    print("✅ All adapter stubs in sync with template; package.json pi/omp blocks resolve.")
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
