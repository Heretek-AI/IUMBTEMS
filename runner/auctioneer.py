#!/usr/bin/env python3
"""
Frontier Markets: scope auctioneer (Stream F).

Replaces static top-down DAG ordering with expected-information-gain bidding.
Each ready scope carries a bid; the runner picks the highest bid first and
records per-scope telemetry (tokens_used, verified_claims) so the allocation
can be scored afterwards.

Bid v1 heuristic (deterministic, zero-cost):
  bid = explicit_bid  if the scope/manifest carries one (orchestrator may emit
                      a "bid" field — prompt schema extension only, no behavior
                      change for existing runs)
  else bid = unresolved_frontier_questions * (1 / (1 + dependency_depth))

Rationale: questions whose prerequisites are settled but still open are the
most information-dense work; deeper-dependency scopes are less ready to pay off
now. Explicit bids win so a human/orchestrator can override the heuristic.

Allocation modes live in config `allocation`: "dag" (default, legacy
behavior) or "auction". See runner/research_swarm.py.
"""

import json
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def load_frontier(base_dir: Path) -> Dict[str, Any]:
    """Load .research/frontier.json if present (Socratic grilling output)."""
    path = Path(base_dir) / "frontier.json"
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def unresolved_frontier_questions(frontier: Dict[str, Any]) -> int:
    """Count unsettled frontier nodes in a grilling frontier document."""
    if not frontier:
        return 0
    nodes = frontier.get("nodes") or {}
    if isinstance(nodes, dict):
        return sum(1 for n in nodes.values() if isinstance(n, dict) and not n.get("settled_answer"))
    if isinstance(nodes, list):
        return sum(1 for n in nodes if isinstance(n, dict) and not n.get("settled_answer"))
    return 0


def dependency_depth(scope: Dict[str, Any], all_scopes: Optional[Iterable[Dict[str, Any]]] = None) -> int:
    """Longest dependency chain ending at this scope (0 if no deps)."""
    by_id = {s.get("scope_id"): s for s in (all_scopes or []) if isinstance(s, dict)}

    def depth_of(scope_id: str, seen: frozenset) -> int:
        s = by_id.get(scope_id)
        if not s or scope_id in seen:
            return 0
        deps = s.get("dependencies") or []
        if not deps:
            return 0
        return 1 + max(depth_of(d, seen | {scope_id}) for d in deps)

    return depth_of(scope.get("scope_id", ""), frozenset())


def bid_scope(
    scope: Dict[str, Any],
    all_scopes: Optional[Iterable[Dict[str, Any]]] = None,
    frontier: Optional[Dict[str, Any]] = None,
    base_dir: Optional[Path] = None,
) -> float:
    """Expected-information-gain bid for one scope. Deterministic."""
    explicit = scope.get("bid")
    if explicit is not None:
        try:
            return float(explicit)
        except (TypeError, ValueError):
            pass

    if frontier is None:
        frontier = load_frontier(base_dir) if base_dir is not None else {}
    open_qs = unresolved_frontier_questions(frontier)
    depth = dependency_depth(scope, all_scopes)

    # No frontier data: fall back to shallow-dependency preference so the
    # auction still differentiates ordering.
    if open_qs <= 0:
        return 1.0 / (1.0 + depth)
    return float(open_qs) * (1.0 / (1.0 + depth))


def score_scopes(
    scopes: List[Dict[str, Any]],
    frontier: Optional[Dict[str, Any]] = None,
    base_dir: Optional[Path] = None,
) -> List[Tuple[float, Dict[str, Any]]]:
    """Return (bid, scope) pairs sorted by descending bid, then scope_id."""
    scored = [
        (bid_scope(s, all_scopes=scopes, frontier=frontier, base_dir=base_dir), s)
        for s in scopes
    ]
    scored.sort(key=lambda pair: (-pair[0], str(pair[1].get("scope_id", ""))))
    return scored


def pick_next(
    scopes: List[Dict[str, Any]],
    budget: Optional[float] = None,
    frontier: Optional[Dict[str, Any]] = None,
    base_dir: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """Pick the highest-bid scope under an optional budget cap."""
    for bid, scope in score_scopes(scopes, frontier=frontier, base_dir=base_dir):
        if budget is None or bid <= budget:
            return scope
    return None


def order_scope_ids(
    scopes: List[Dict[str, Any]],
    frontier: Optional[Dict[str, Any]] = None,
    base_dir: Optional[Path] = None,
) -> List[str]:
    """Convenience: just the ordered scope_ids."""
    return [s.get("scope_id", "") for _b, s in score_scopes(scopes, frontier=frontier, base_dir=base_dir)]


# ---- telemetry ---------------------------------------------------------


def estimate_tokens(text: str) -> int:
    """Rough token estimate (chars/4). FLAGGED APPROXIMATION, not a measurement."""
    return max(1, len(text) // 4)


def record_scope_telemetry(
    base_dir: Path,
    scope_id: str,
    tokens_used: int,
    verified_claims: int,
    bid: Optional[float] = None,
) -> None:
    """Persist auction telemetry into the scope manifest (optional fields)."""
    path = Path(base_dir) / "scratchpads" / scope_id / "manifest.json"
    if not path.exists():
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    telemetry = manifest.get("telemetry") or {}
    telemetry["tokens_used"] = tokens_used
    telemetry["verified_claims"] = verified_claims
    if bid is not None:
        telemetry["bid"] = bid
    manifest["telemetry"] = telemetry
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
