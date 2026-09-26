#!/usr/bin/env python3
"""
Stream F / Frontier Markets probe harness.

Probe: [HYPOTHESIS: on a fixed 4-scope objective, auction allocation matches
static-DAG wall-clock and yields >= 20% more distinct verified claims per
token]

Runs the same fixed objective twice — once with allocation="dag", once with
allocation="auction" — and emits a comparison artifact under
.research/experiments/. LIVE MODE SPENDS MONEY; use --mock to prove the
harness (the probe itself requires real models).

Token accounting is a chars/4 ESTIMATE (flagged approximation) — report both
chars and tokens in the artifact.

Usage:
  python3 scripts/auction_experiment.py --mock          # harness proof
  python3 scripts/auction_experiment.py                 # live probe run
"""

import argparse
import contextlib
import io
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.auctioneer import estimate_tokens  # noqa: E402
from runner.research_swarm import SwarmRunner  # noqa: E402

FIXTURE = PROJECT_ROOT / "runner" / "tests" / "fixtures" / "auction_objective.json"
GATE_BAR_CLAIMS_PER_TOKEN = 0.20


def load_fixture(path: Path = FIXTURE) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def run_once(
    fixture: Dict[str, Any],
    base_dir: Path,
    allocation: str,
    mock: bool,
) -> Dict[str, Any]:
    """One full swarm run under one allocation policy. Returns metrics."""
    # Seed a fixed 4-scope manifest by pre-writing the scope list through a
    # stub orchestrator: we pass scopes via a tiny monkeypatch so both arms
    # see the IDENTICAL scope set (fair comparison).
    runner = SwarmRunner(base_dir=base_dir, mock_mode=mock, allocation=allocation)

    fixed_scopes = fixture["scopes"]

    def fixed_orchestrate(objective, frontier_file=None):
        runner.state_machine.init_session(objective)
        runner.state_machine.set_scopes(fixed_scopes)
        return fixed_scopes

    runner.orchestrate_objective = fixed_orchestrate  # type: ignore[method-assign]

    buf = io.StringIO()
    started = time.perf_counter()
    with contextlib.redirect_stdout(buf):
        runner.run_swarm(fixture["objective"])
    elapsed = time.perf_counter() - started

    # Metrics from scope manifests + audit reports.
    total_chars = 0
    total_tokens_est = 0
    verified = 0
    for s in fixed_scopes:
        sid = s["scope_id"]
        scope_dir = base_dir / "scratchpads" / sid
        for name in ("alpha_dossier.json", "beta_dossier.json"):
            p = scope_dir / name
            if p.exists():
                total_chars += p.stat().st_size
        audit_path = scope_dir / "audit_report.json"
        if audit_path.exists():
            try:
                summary = json.loads(audit_path.read_text()).get("summary", {})
                verified += int(summary.get("verified_passed", 0))
            except (OSError, json.JSONDecodeError):
                pass
        manifest_path = scope_dir / "manifest.json"
        if manifest_path.exists():
            try:
                telemetry = json.loads(manifest_path.read_text()).get("telemetry", {})
                if "tokens_used" in telemetry:
                    total_tokens_est += int(telemetry["tokens_used"])
            except (OSError, json.JSONDecodeError):
                pass

    if total_tokens_est == 0:
        total_tokens_est = estimate_tokens("x" * total_chars)

    return {
        "allocation": allocation,
        "wall_clock_s": round(elapsed, 3),
        "verified_claims": verified,
        "chars": total_chars,
        "tokens_estimate": total_tokens_est,  # FLAGGED APPROXIMATION (chars/4)
        "claims_per_token": (
            round(verified / total_tokens_est, 6) if total_tokens_est else None
        ),
    }


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="Stream F auction experiment")
    parser.add_argument("--mock", action="store_true", help="Mock mode, zero API cost")
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--fixture", default=str(FIXTURE))
    args = parser.parse_args(argv)

    fixture = load_fixture(Path(args.fixture))
    out_dir = Path(args.out_dir) if args.out_dir else (PROJECT_ROOT / ".research" / "experiments")
    out_dir.mkdir(parents=True, exist_ok=True)

    results = {}
    for policy in ("dag", "auction"):
        print(f"[{policy}] run...", flush=True)
        results[policy] = run_once(
            fixture, out_dir / "work" / f"auction_{policy}", policy, args.mock
        )

    dag, auction = results["dag"], results["auction"]
    wall_ratio = (
        round(auction["wall_clock_s"] / dag["wall_clock_s"], 4)
        if dag["wall_clock_s"] > 0 else None
    )
    cpt_gain = (
        round((auction["claims_per_token"] - dag["claims_per_token"]) / dag["claims_per_token"], 4)
        if dag["claims_per_token"] else None
    )

    if args.mock:
        gate = "UNMEASURED_MOCK"
    elif cpt_gain is None:
        gate = "UNMEASURED"
    else:
        gate = "PASS" if cpt_gain >= GATE_BAR_CLAIMS_PER_TOKEN else "FAIL"

    artifact = {
        "experiment": "auction-f",
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "mock": args.mock,
        "fixture": args.fixture,
        "gate_bar_claims_per_token_gain": GATE_BAR_CLAIMS_PER_TOKEN,
        "results": results,
        "wall_clock_ratio_auction_over_dag": wall_ratio,
        "claims_per_token_gain": cpt_gain,
        "gate_f": gate,
        "token_note": "tokens_estimate is chars/4 — a flagged approximation, not a measurement",
    }

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = out_dir / f"auction_{stamp}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(artifact, f, indent=2)

    print(json.dumps({
        "gate_f": gate,
        "claims_per_token_gain": cpt_gain,
        "wall_clock_ratio": wall_ratio,
        "artifact": str(out_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
