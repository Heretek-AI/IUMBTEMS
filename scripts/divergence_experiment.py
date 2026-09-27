#!/usr/bin/env python3
"""
Stream E / Gate G2: cross-family adversary divergence experiment.

Probe: [HYPOTHESIS: cross-family Alpha/Beta pairs raise mean Divergence
Score by >= 0.15 vs same-family pairs across 5 fixed objectives]

Runs each fixture objective twice — once with a same-family config, once with
a cross-family config — and emits a delta artifact under
.research/experiments/. LIVE MODE SPENDS MONEY: it drives real backends.

Zero-dep: stdlib + the existing SwarmRunner. Token/cost accounting is
best-effort (chars/4) and reported as an estimate, not a measurement.

Usage:
  # Dry-run (mock mode, zero cost) — proves the harness, not the hypothesis
  python3 scripts/divergence_experiment.py --mock

  # Live (requires configured backends and spend approval)
  python3 scripts/divergence_experiment.py \
      --beta-backend ollama run qwen3 --model-alpha claude-opus-5
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.research_swarm import SwarmRunner  # noqa: E402

FIXTURE = PROJECT_ROOT / "runner" / "tests" / "fixtures" / "divergence_objectives.json"
GATE_BAR = 0.15


def load_objectives(path: Path = FIXTURE) -> List[Dict[str, Any]]:
    canonical_path = Path(os.path.realpath(str(path)))
    with open(canonical_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["objectives"]


def estimate_tokens(text: str) -> int:
    """Rough token estimate (chars/4). FLAGGED APPROXIMATION, not a measurement."""
    return max(1, len(text) // 4)


def _extract_audit_divergence(base_dir: Path) -> Tuple[Optional[float], Optional[bool]]:
    """Aggregate divergence across every scored audit in a run's scratchpads.

    A swarm run writes one ``audit_report.json`` per scope, so a single scalar has
    to be reduced from N scores. The reduction is the **mean** of all scores that
    are present, which is deterministic and independent of scope-name ordering.

    ``verified_passed`` is True only when every scored audit reports True; it is
    None when no audit reports it at all.

    (Earlier revisions returned whichever audit happened to be visited — first,
    then briefly last — so the reported number silently tracked directory sort
    order. Neither is a meaningful rule; the mean is.)
    """
    audit_paths = sorted((base_dir / "scratchpads").glob("*/audit_report.json"))
    scores: List[float] = []
    verified_flags: List[bool] = []
    for ap in audit_paths:
        try:
            with open(ap, "r", encoding="utf-8") as f:
                audit = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        summary = audit.get("summary", {})
        if summary.get("divergence_score") is not None:
            scores.append(float(summary["divergence_score"]))
        if summary.get("verified_passed") is not None:
            verified_flags.append(bool(summary["verified_passed"]))

    if not scores:
        return None, (None if not verified_flags else all(verified_flags))
    divergence = sum(scores) / len(scores)
    verified: Optional[int] = all(verified_flags) if verified_flags else None
    return divergence, verified


def run_one(
    objective: str,
    base_dir: Path,
    agent_overrides: Optional[Dict[str, Dict[str, Any]]],
    mock: bool,
) -> Dict[str, Any]:
    """Run one swarm under one config and pull divergence out of the audit."""
    import contextlib, io

    runner = SwarmRunner(
        base_dir=base_dir,
        mock_mode=mock,
        mode="research",
        agent_overrides=agent_overrides,
    )
    started = time.perf_counter()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runner.run_swarm(objective)
    elapsed = time.perf_counter() - started

    report_path = base_dir / "final_synthesis.md"
    divergence, verified = _extract_audit_divergence(base_dir)
    log = buf.getvalue()
    return {
        "divergence_score": divergence,
        "verified_passed": verified,
        "wall_clock_s": round(elapsed, 3),
        "tokens_estimate": estimate_tokens(log),
        "report": str(report_path) if report_path.exists() else None,
    }


def _build_overrides(args: argparse.Namespace) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    same_family: Dict[str, Dict[str, Any]] = {}
    cross_family: Dict[str, Dict[str, Any]] = {}
    if args.model_alpha:
        same_family.setdefault("alpha", {})["model"] = args.model_alpha
        same_family.setdefault("beta", {})["model"] = args.model_alpha
    if args.model_beta:
        cross_family.setdefault("beta", {})["model"] = args.model_beta
    if args.beta_backend:
        cross_family.setdefault("beta", {})["backend"] = args.beta_backend
    return same_family, cross_family


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Stream E divergence experiment (G2)")
    parser.add_argument("--mock", action="store_true", help="Mock mode, zero API cost")
    parser.add_argument("--out-dir", default=None, help="Artifact directory")
    parser.add_argument("--model-alpha", default=None)
    parser.add_argument("--model-beta", default=None)
    parser.add_argument("--beta-backend", nargs="+", default=None)
    parser.add_argument("--fixture", default=str(FIXTURE))
    args = parser.parse_args(argv)

    canonical_fixture = Path(os.path.realpath(str(args.fixture)))
    objectives = load_objectives(canonical_fixture)
    out_dir = Path(os.path.realpath(str(args.out_dir))) if args.out_dir else (PROJECT_ROOT / ".research" / "experiments")
    out_dir.mkdir(parents=True, exist_ok=True)

    same_family, cross_family = _build_overrides(args)

    results = []
    for obj in objectives:
        oid = obj["id"]
        print(f"[{oid}] same-family run...", flush=True)
        same = run_one(
            obj["objective"],
            out_dir / "work" / oid / "same",
            same_family or None,
            args.mock,
        )
        print(f"[{oid}] cross-family run...", flush=True)
        cross = run_one(
            obj["objective"],
            out_dir / "work" / oid / "cross",
            cross_family or None,
            args.mock,
        )
        d_same = same["divergence_score"]
        d_cross = cross["divergence_score"]
        delta = (
            round(d_cross - d_same, 4)
            if (d_same is not None and d_cross is not None)
            else None
        )
        results.append({"id": oid, "objective": obj["objective"], "same": same, "cross": cross, "delta_divergence": delta})

    deltas = [r["delta_divergence"] for r in results if r["delta_divergence"] is not None]
    mean_delta = round(sum(deltas) / len(deltas), 4) if deltas else None

    # A mock run cannot falsify G2: both arms drive the same canned backend,
    # so a 0.0 delta is a property of the fixture, not of model diversity.
    if args.mock:
        gate_status = "UNMEASURED_MOCK"
    elif mean_delta is None:
        gate_status = "UNMEASURED"
    else:
        gate_status = "PASS" if mean_delta >= GATE_BAR else "FAIL"

    artifact = {
        "experiment": "divergence-g2",
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "mock": args.mock,
        "fixture": args.fixture,
        "gate_bar_delta": GATE_BAR,
        "results": results,
        "mean_delta_divergence": mean_delta,
        "gate_g2": gate_status,
        "token_note": "tokens_estimate is chars/4 — a flagged approximation, not a measurement",
    }

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = out_dir / f"divergence_{stamp}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(artifact, f, indent=2)

    print(json.dumps({"mean_delta": mean_delta, "gate_g2": artifact["gate_g2"], "artifact": str(out_path)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
