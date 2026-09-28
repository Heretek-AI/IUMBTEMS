#!/usr/bin/env python3
"""Render `schemas/*.schema.json` from `runner/schemas.py`.

Generated, never hand-edited. `--check` regenerates in memory and diffs against
disk so CI fails on drift (issue #6 item 2.1).
"""

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.schemas import SCHEMAS  # noqa: E402

SCHEMA_DIR = PROJECT_ROOT / "schemas"


def render() -> dict:
    return {name: schema for name, schema in SCHEMAS.items()}


def write_all() -> int:
    SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
    for name, schema in SCHEMAS.items():
        (SCHEMA_DIR / f"{name}.schema.json").write_text(
            json.dumps(schema, indent=2) + "\n", encoding="utf-8"
        )
    return len(SCHEMAS)


def check() -> int:
    errors = []
    for name, schema in SCHEMAS.items():
        path = SCHEMA_DIR / f"{name}.schema.json"
        expected = json.dumps(schema, indent=2) + "\n"
        if not path.exists():
            errors.append(f"MISSING schema: {path.relative_to(PROJECT_ROOT)}")
        elif path.read_text(encoding="utf-8") != expected:
            errors.append(f"OUT OF SYNC: {path.relative_to(PROJECT_ROOT)}")
    stray = {p.name for p in SCHEMA_DIR.glob("*.schema.json")} - {
        f"{n}.schema.json" for n in SCHEMAS
    }
    for name in sorted(stray):
        errors.append(f"STRAY schema (delete or add to runner/schemas.py): {name}")
    if errors:
        for e in errors:
            print(f"❌ {e}", file=sys.stderr)
        return 1
    print(f"✅ {len(SCHEMAS)} schemas in sync with runner/schemas.py.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate IUMBTEMS JSON schemas")
    parser.add_argument("--check", action="store_true", help="fail on drift")
    args = parser.parse_args()
    if args.check:
        return check()
    count = write_all()
    print(f"✅ Wrote {count} schemas to {SCHEMA_DIR.relative_to(PROJECT_ROOT)}/.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
