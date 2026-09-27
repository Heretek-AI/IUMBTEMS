#!/usr/bin/env python3
"""
Factory run-state helper: phase dossiers, QA retry bounds, expansion loop guard.

All state lives under <project>/.factory/ (gitignored runtime state). Phase
output goes to <project>/.roadmap/<phase>/. Evidence stays in <project>/
.research/. Read-only w.r.t. repo code.

Project directory resolution: --project-dir > IUMBTEMS_PROJECT_DIR env > the
toolchain repo root (local-dev default). A consuming project must never leak
state into the IUMBTEMS checkout.

Usage:
  python3 skills/factory/scripts/factory.py init --run <name>
  python3 skills/factory/scripts/factory.py phase-add --run <name> --phase 01-auth --goal "..." --accept "..."
  python3 skills/factory/scripts/factory.py qa-record --run <name> --phase 01-auth --seat qa-a --verdict fail --reason "..."
  python3 skills/factory/scripts/factory.py expansion --run <name> --loops 10 [--max-loops 10]
  python3 skills/factory/scripts/factory.py stop --run <name>   # write STOP kill-file
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent


def resolve_project_root(cli_value=None):
    """--project-dir > IUMBTEMS_PROJECT_DIR > repo root (local-dev default)."""
    for candidate in (cli_value, os.environ.get("IUMBTEMS_PROJECT_DIR")):
        if candidate and Path(candidate).is_dir():
            return Path(candidate).resolve()
    return REPO_ROOT


PROJECT_DIR = resolve_project_root()
FACTORY_DIR = PROJECT_DIR / ".factory"
ROADMAP_DIR = PROJECT_DIR / ".roadmap"

MAX_QA_RETRIES = 3
MAX_EXPANSION_LOOPS = 10


def now():
    return datetime.now(timezone.utc).isoformat()


def run_dir(run):
    return FACTORY_DIR / run


def load_state(run):
    p = run_dir(run) / "state.json"
    if not p.exists():
        raise SystemExit(f"No factory run '{run}'. Run `factory.py init` first.")
    return json.loads(p.read_text(encoding="utf-8"))


def save_state(run, state):
    p = run_dir(run) / "state.json"
    p.write_text(json.dumps(state, indent=2), encoding="utf-8")


def cmd_init(args):
    d = run_dir(args.run)
    d.mkdir(parents=True, exist_ok=True)
    state = {
        "run": args.run,
        "created_at": now(),
        "gate_cycles": 0,
        "phases": {},
        "expansion": {"loops_done": 0, "loops_planned": 0},
    }
    save_state(args.run, state)
    print(f"✅ Factory run '{args.run}' initialised at {d}")


def cmd_phase_add(args):
    state = load_state(args.run)
    if args.phase in state["phases"]:
        raise SystemExit(f"Phase '{args.phase}' already exists.")
    state["phases"][args.phase] = {
        "goal": args.goal,
        "acceptance": [a.strip() for a in args.accept.split(";") if a.strip()],
        "status": "briefed",
        "qa_retries": 0,
        "qa_reports": [],
    }
    save_state(args.run, state)
    # Phase output: GOAL.md + dossier.json skeleton (evidence filled by manager).
    phase_dir = ROADMAP_DIR / args.phase
    phase_dir.mkdir(parents=True, exist_ok=True)
    (phase_dir / "GOAL.md").write_text(
        f"# {args.phase}: {args.goal}\n\n## Acceptance\n"
        + "".join(f"- [ ] {a}\n" for a in state["phases"][args.phase]["acceptance"]),
        encoding="utf-8",
    )
    (phase_dir / "dossier.json").write_text(
        json.dumps(
            {
                "phase": args.phase,
                "goal": args.goal,
                "evidence": [],
                "acceptance": state["phases"][args.phase]["acceptance"],
                "brief": "",
                "verdict": "briefed",
                "hashes": [],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"✅ Phase '{args.phase}' briefed → {phase_dir}")


def cmd_qa_record(args):
    state = load_state(args.run)
    phase = state["phases"].get(args.phase)
    if phase is None:
        raise SystemExit(f"Unknown phase '{args.phase}'.")
    if args.verdict not in ("pass", "fail", "conditional"):
        raise SystemExit("verdict must be pass|fail|conditional.")
    phase["qa_reports"].append(
        {
            "seat": args.seat,
            "verdict": args.verdict,
            "reason": args.reason or "",
            "at": now(),
        }
    )
    if args.verdict == "fail":
        phase["qa_retries"] += 1
        if phase["qa_retries"] >= MAX_QA_RETRIES:
            phase["status"] = "escalated"
            save_state(args.run, state)
            print(
                f"🛑 Phase '{args.phase}' ESCALATED after "
                f"{MAX_QA_RETRIES} QA failures — back to manager."
            )
            return 2
        phase["status"] = "retrying"
    elif args.verdict == "pass":
        phase["status"] = "signed-off"
    else:
        phase["status"] = "conditional"
    save_state(args.run, state)
    print(
        f"✅ QA recorded: {args.phase} [{args.seat}] → {args.verdict} "
        f"(status={phase['status']}, retries={phase['qa_retries']})"
    )


def stop_requested(run):
    return (run_dir(run) / "STOP").exists()


def cmd_expansion(args):
    state = load_state(args.run)
    n = args.loops
    if n < 1:
        raise SystemExit("loops must be >= 1.")
    cap = args.max_loops or MAX_EXPANSION_LOOPS
    n = min(n, cap)
    state["expansion"]["loops_planned"] = n
    save_state(args.run, state)
    done = 0
    for _ in range(1, n + 1):
        if stop_requested(args.run):
            print(f"🛑 STOP file present — halting after {done}/{n} loops.")
            break
        done += 1
        print(
            f"🔁 Expansion loop {done}/{n}: agents propose → swarm check → "
            f"implement → QA (Manager drives each step)."
        )
    state = load_state(args.run)
    state["expansion"]["loops_done"] += done
    save_state(args.run, state)
    print(f"✅ Expansion finished {done} loop(s).")


def cmd_stop(args):
    (run_dir(args.run)).mkdir(parents=True, exist_ok=True)
    (run_dir(args.run) / "STOP").write_text(
        f"stop requested at {now()}\n", encoding="utf-8"
    )
    print(f"🛑 STOP file written for run '{args.run}'.")


def _add_common(parser):
    parser.add_argument(
        "--project-dir",
        default=None,
        help="Project the factory state belongs to (default: IUMBTEMS_PROJECT_DIR env, else repo root)",
    )


def main():
    global FACTORY_DIR, ROADMAP_DIR
    ap = argparse.ArgumentParser(description="Factory run-state helper")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init")
    p.add_argument("--run", required=True)
    _add_common(p)
    p = sub.add_parser("phase-add")
    p.add_argument("--run", required=True)
    p.add_argument("--phase", required=True)
    p.add_argument("--goal", required=True)
    p.add_argument("--accept", default="")
    _add_common(p)
    p = sub.add_parser("qa-record")
    p.add_argument("--run", required=True)
    p.add_argument("--phase", required=True)
    p.add_argument("--seat", required=True)
    p.add_argument("--verdict", required=True)
    p.add_argument("--reason", default="")
    _add_common(p)
    p = sub.add_parser("expansion")
    p.add_argument("--run", required=True)
    p.add_argument("--loops", type=int, required=True)
    p.add_argument("--max-loops", type=int, default=MAX_EXPANSION_LOOPS)
    _add_common(p)
    p = sub.add_parser("stop")
    p.add_argument("--run", required=True)
    _add_common(p)

    args = ap.parse_args()
    root = resolve_project_root(args.project_dir)
    FACTORY_DIR = root / ".factory"
    ROADMAP_DIR = root / ".roadmap"
    code = {
        "init": cmd_init,
        "phase-add": cmd_phase_add,
        "qa-record": cmd_qa_record,
        "expansion": cmd_expansion,
        "stop": cmd_stop,
    }[args.command](args)
    sys.exit(code if isinstance(code, int) else 0)


if __name__ == "__main__":
    main()
