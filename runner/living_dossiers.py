#!/usr/bin/env python3
"""
Living Dossiers: claim degradation ledger (Stream C).

Epistemic core idea: a `[VERIFIED]` claim is a time-bounded LOAN against its
cached source, not a permanent fact. When a source is retracted or revised,
the loan is called — regardless of whether the local cache still contains a
matching quote.

Source-of-truth discipline (same as the rest of IUMBTEMS):
- Retraction events are FILES: `.research/retractions/<hash>.json`
  `{hash, event: RETRACTED|REVISED, at, note, supersedes?}`
- Status transitions are an append-only ledger: `.research/ledger/claim_status.json`
- Dossiers are NEVER mutated in place — they are the historical record.
- Requeue instructions land in `.research/requeue.json` for the next swarm pass.

Degradation rules (applied after quote verification):
  RETRACTED source -> claim.status = STALE   (loan called; quote match irrelevant)
  REVISED    source -> claim.status = SUSPECT (needs human/agent re-review + requeue)
"""

import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.claim_witness import (  # noqa: E402
    STATUS_LIVE,
    STATUS_STALE,
    STATUS_SUSPECT,
    ClaimWitness,
)
from runner.path_safety import safe_join  # noqa: E402

EVENT_RETRACTED = "RETRACTED"
EVENT_REVISED = "REVISED"
VALID_EVENTS = (EVENT_RETRACTED, EVENT_REVISED)


@dataclass
class RetractionEvent:
    hash: str
    event: str
    at: str
    note: str = ""
    supersedes: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class StatusEvent:
    scope_id: str
    claim_id: str
    from_status: str
    to_status: str
    reason: str
    at: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ---- retraction events (files are the record) ---------------------------


def write_retraction(
    base_dir: Path,
    source_hash: str,
    event: str,
    note: str = "",
    at: Optional[str] = None,
    supersedes: Optional[str] = None,
) -> Path:
    """Record a RETRACTED/REVISED event for a cached source."""
    if event not in VALID_EVENTS:
        raise ValueError(f"event must be one of {VALID_EVENTS}, got {event!r}")
    if not re.match(r"^[a-zA-Z0-9_\-\.]+$", source_hash):
        raise ValueError(f"Invalid source hash: {source_hash!r}")
    retr_dir = Path(base_dir) / "retractions"
    retr_dir.mkdir(parents=True, exist_ok=True)
    payload = RetractionEvent(
        hash=source_hash,
        event=event,
        at=at or datetime.now(timezone.utc).isoformat(),
        note=note,
        supersedes=supersedes,
    )
    # `source_hash` is untrusted tool input, so the filename is joined under
    # `retractions/` through safe_join (no separators, no bare `..`, and a
    # containment re-check after canonicalisation). The regex above is the
    # input gate; safe_join is the one that holds if the gate is ever loosened.
    path = safe_join(retr_dir, f"{source_hash}.json")
    # Last write wins per hash (a REVISED may follow a RETRACTED); the ledger
    # keeps the full history of claim transitions either way.
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload.to_dict(), f, indent=2)
    return path


def load_retractions(base_dir: Path) -> Dict[str, RetractionEvent]:
    """Load all retraction events, keyed by source hash."""
    retr_dir = Path(base_dir) / "retractions"
    out: Dict[str, RetractionEvent] = {}
    if not retr_dir.exists():
        return out
    for path in sorted(retr_dir.glob("*.json")):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        src_hash = data.get("hash") or path.stem
        event = str(data.get("event", "")).upper()
        if event not in VALID_EVENTS:
            continue
        out[src_hash] = RetractionEvent(
            hash=src_hash,
            event=event,
            at=data.get("at") or "",
            note=data.get("note") or "",
            supersedes=data.get("supersedes"),
        )
    return out


# ---- degradation -------------------------------------------------------


def apply_degradation(
    claims: Iterable[ClaimWitness],
    retractions: Dict[str, RetractionEvent],
    scope_id: str = "unknown",
    now: Optional[str] = None,
) -> Tuple[List[ClaimWitness], List[StatusEvent]]:
    """Mark claims STALE/SUSPECT per retraction events.

    Returns (degraded_claims, status_events). ClaimWitness objects are
    updated in memory only — callers persist to the ledger, never into the
    source dossier files.
    """
    now = now or datetime.now(timezone.utc).isoformat()
    events: List[StatusEvent] = []
    out: List[ClaimWitness] = []

    for claim in claims:
        prior = claim.status or STATUS_LIVE
        src_hash = claim.source_hash
        ev = retractions.get(src_hash) if src_hash else None

        new_status = prior
        reason = ""
        if ev is not None:
            if ev.event == EVENT_RETRACTED:
                new_status = STATUS_STALE
                reason = f"source {src_hash} RETRACTED: {ev.note or 'no note'}"
            elif ev.event == EVENT_REVISED:
                new_status = STATUS_SUSPECT
                reason = f"source {src_hash} REVISED: {ev.note or 'no note'}"

        if new_status != prior:
            claim.status = new_status
            events.append(
                StatusEvent(
                    scope_id=scope_id,
                    claim_id=claim.claim_id,
                    from_status=prior,
                    to_status=new_status,
                    reason=reason,
                    at=now,
                )
            )
        out.append(claim)

    return out, events


# ---- ledger + requeue sidecars -----------------------------------------


def append_ledger(base_dir: Path, events: List[StatusEvent]) -> Path:
    """Append status transitions to the append-only ledger (never rewrite)."""
    ledger_dir = Path(base_dir) / "ledger"
    ledger_dir.mkdir(parents=True, exist_ok=True)
    path = ledger_dir / "claim_status.json"
    existing: List[Dict[str, Any]] = []
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            if not isinstance(existing, list):
                existing = []
        except (OSError, json.JSONDecodeError):
            existing = []
    existing.extend(e.to_dict() for e in events)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(existing, f, indent=2)
    return path


def queue_requeue(base_dir: Path, scope_id: str, reason: str = "claim degradation") -> Path:
    """Record that a scope needs a re-run on the next swarm pass."""
    path = Path(base_dir) / "requeue.json"
    entries: List[Dict[str, Any]] = []
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                entries = json.load(f)
            if not isinstance(entries, list):
                entries = []
        except (OSError, json.JSONDecodeError):
            entries = []
    if not any(e.get("scope_id") == scope_id for e in entries):
        entries.append(
            {
                "scope_id": scope_id,
                "reason": reason,
                "queued_at": datetime.now(timezone.utc).isoformat(),
            }
        )
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2)
    return path


def load_requeue(base_dir: Path) -> List[Dict[str, Any]]:
    path = Path(base_dir) / "requeue.json"
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


# ---- one-pass staleness check (the probe's unit of work) ----------------


def check_staleness(base_dir: Path, scope_ids: Optional[List[str]] = None) -> Dict[str, Any]:
    """Run one degradation pass over scope dossiers.

    For each scope with alpha/beta dossiers, fold claims, join against
    retraction events, write the ledger, mirror into the claim store, and
    queue re-runs for scopes that degraded. Dossiers themselves are left
    untouched.

    Returns a summary dict suitable for JSON tool output.
    """
    from runner.claim_witness import claims_from_dossier, load_dossier

    base_dir = Path(base_dir)
    retractions = load_retractions(base_dir)
    scratch = base_dir / "scratchpads"

    if scope_ids is None:
        if not scratch.exists():
            return {
                "scopes": [],
                "retractions": len(retractions),
                "degraded": 0,
                # Keep the early return shape identical to the normal one so
                # callers can key off `degraded_scopes` unconditionally.
                "degraded_scopes": [],
            }
        scope_dirs = sorted(p for p in scratch.iterdir() if p.is_dir())
    else:
        scope_dirs = [scratch / s for s in scope_ids]

    all_events: List[StatusEvent] = []
    per_scope: List[Dict[str, Any]] = []
    degraded_scopes = set()

    for scope_dir in scope_dirs:
        if not scope_dir.is_dir():
            continue
        scope_id = scope_dir.name
        scope_event_count = 0
        claim_sets = 0

        for dossier_name in ("alpha_dossier.json", "beta_dossier.json"):
            dpath = scope_dir / dossier_name
            if not dpath.exists():
                continue
            claim_sets += 1
            dossier = load_dossier(dpath)
            claims = claims_from_dossier(dossier)
            _, events = apply_degradation(
                claims, retractions, scope_id=scope_id
            )
            all_events.extend(events)
            scope_event_count += len(events)
            if events:
                degraded_scopes.add(scope_id)

        per_scope.append(
            {
                "scope_id": scope_id,
                "claim_sets": claim_sets,
                "status_events": scope_event_count,
                "degraded": scope_id in degraded_scopes,
            }
        )

    if all_events:
        append_ledger(base_dir, all_events)
        # Mirror into the derived claim store (best-effort; never fatal).
        try:
            from runner.claim_store import ClaimStore

            store = ClaimStore(base_dir)
            for e in all_events:
                store.record_status_event(
                    e.scope_id, e.claim_id, e.from_status, e.to_status, e.reason, e.at
                )
            store.close()
        except Exception as exc:  # noqa: BLE001
            print(f"[living-dossiers] claim store mirror skipped: {exc}", file=sys.stderr)

    for scope_id in sorted(degraded_scopes):
        queue_requeue(base_dir, scope_id, reason="claim degradation (retraction event)")

    return {
        "retractions": len(retractions),
        "scopes": per_scope,
        "degraded_scopes": sorted(degraded_scopes),
        "status_events": len(all_events),
    }


def main(argv: Optional[List[str]] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="IUMBTEMS living dossiers ledger")
    parser.add_argument("--dir", default=".research")
    sub = parser.add_subparsers(dest="command")

    rep = sub.add_parser("report", help="Record a retraction/retraction event")
    rep.add_argument("--hash", required=True)
    rep.add_argument("--event", required=True, choices=list(VALID_EVENTS))
    rep.add_argument("--note", default="")

    sub.add_parser(
        "check",
        help=(
            "Run one staleness/degradation pass. Exits 1 when any scope "
            "degraded (the ledger reporting a problem IS the outcome), 0 "
            "otherwise — callers under `set -e` should expect that."
        ),
    )
    args = parser.parse_args(argv)

    base = Path(os.path.realpath(str(args.dir)))
    if args.command == "report":
        path = write_retraction(base, args.hash, args.event, note=args.note)
        print(json.dumps({"status": "recorded", "path": str(path)}))
        return 0
    if args.command == "check" or args.command is None:
        res = check_staleness(base)
        print(json.dumps(res, indent=2))
        return 1 if res.get("degraded_scopes") else 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
