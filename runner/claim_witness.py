#!/usr/bin/env python3
"""
ClaimWitness: the single normalized claim record for IUMBTEMS.

Dossiers already converge on four shapes (see runner/research_swarm.py mock
bodies and prompts/*.md):
  affirmative_claims / falsification_claims
      {claim_id, tag, statement, source_hash, source_url, verbatim_quote, [severity]}
  inferred_implications
      {inference_id, tag, statement, parent_claims, deductive_logic, [falsification]}
  hypotheses (beta)
      {hypothesis_id?, claim_id?, tag, statement, falsification, ...}
  negative_knowledge
      {query, finding}

This module folds all four into one record so Living Dossiers (staleness),
PCRB export, Domain Packs, and the refinement checker share one verification
stack instead of growing four parallel ones.

`SourceHasher.verify_quote` remains the ONLY quote engine — `witness_check`
is a thin adapter over it.
"""

from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Claim kinds
KIND_CLAIM = "CLAIM"
KIND_INFERENCE = "INFERENCE"
KIND_HYPOTHESIS = "HYPOTHESIS"
KIND_NEGATIVE_KNOWLEDGE = "NEGATIVE_KNOWLEDGE"

# Epistemic tags
TAG_VERIFIED = "VERIFIED"
TAG_INFERRED = "INFERRED"
TAG_HYPOTHESIS = "HYPOTHESIS"
TAG_NEGATIVE_KNOWLEDGE = "NEGATIVE_KNOWLEDGE"

# Living-dossier status (Stream C fills STALE; REJECTED set by the auditor)
STATUS_LIVE = "LIVE"
STATUS_STALE = "STALE"
STATUS_SUSPECT = "SUSPECT"
STATUS_REJECTED = "REJECTED"

# Dossier keys -> (kind, id-field)
SOURCE_KEYS = (
    ("affirmative_claims", KIND_CLAIM, "claim_id"),
    ("falsification_claims", KIND_CLAIM, "claim_id"),
    ("inferred_implications", KIND_INFERENCE, "inference_id"),
    ("hypotheses", KIND_HYPOTHESIS, "hypothesis_id"),
    ("negative_knowledge", KIND_NEGATIVE_KNOWLEDGE, None),
)


@dataclass
class ClaimWitness:
    """One epistemically-tagged assertion in normalized form."""

    claim_id: str
    kind: str
    tag: str
    statement: str

    # CLAIM fields (verbatim evidence)
    source_hash: Optional[str] = None
    source_url: Optional[str] = None
    verbatim_quote: Optional[str] = None

    # INFERENCE / HYPOTHESIS fields
    parent_claims: List[str] = field(default_factory=list)
    deductive_logic: Optional[str] = None
    falsification: Optional[str] = None

    # NEGATIVE_KNOWLEDGE fields
    query: Optional[str] = None
    finding: Optional[str] = None

    # Beta adversarial claims
    severity: Optional[str] = None

    # Filled by the auditor / claim store
    tier: Optional[str] = None
    confidence: Optional[float] = None
    verified_at: Optional[str] = None

    # Living-dossier slot (Stream C)
    status: str = STATUS_LIVE

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def normalize_claim(raw: Dict[str, Any], kind: str = KIND_CLAIM) -> ClaimWitness:
    """Fold one raw dossier entry into a ClaimWitness.

    `tag` is read from the entry and defaulted by kind; kind wins when the
    entry's tag contradicts its source key (e.g. a HYPOTHESIS-tagged row
    inside inferred_implications is still an INFERENCE for invariant checks).
    """
    raw_tag = raw.get("tag")
    # A missing tag (key absent) defaults by kind; an EXPLICIT empty tag stays
    # empty so Domain Packs can flag unclassified claims (MISSING_TAG).
    if raw_tag is None:
        tag = {
            KIND_CLAIM: TAG_VERIFIED,
            KIND_INFERENCE: TAG_INFERRED,
            KIND_HYPOTHESIS: TAG_HYPOTHESIS,
            KIND_NEGATIVE_KNOWLEDGE: TAG_NEGATIVE_KNOWLEDGE,
        }[kind]
    else:
        tag = str(raw_tag).upper()
    id_field = {
        KIND_CLAIM: "claim_id",
        KIND_INFERENCE: "inference_id",
        KIND_HYPOTHESIS: "hypothesis_id",
    }.get(kind)

    claim_id = (
        raw.get("claim_id")
        or raw.get("inference_id")
        or raw.get("hypothesis_id")
        or (id_field and raw.get(id_field))
        or "UNKNOWN"
    )

    parent_claims = raw.get("parent_claims") or []
    if isinstance(parent_claims, str):
        parent_claims = [parent_claims]

    return ClaimWitness(
        claim_id=str(claim_id),
        kind=kind,
        tag=tag,
        statement=raw.get("statement") or raw.get("finding") or raw.get("query") or "",
        source_hash=raw.get("source_hash"),
        source_url=raw.get("source_url"),
        verbatim_quote=raw.get("verbatim_quote"),
        parent_claims=[str(p) for p in parent_claims],
        deductive_logic=raw.get("deductive_logic"),
        falsification=raw.get("falsification"),
        query=raw.get("query"),
        finding=raw.get("finding"),
        severity=raw.get("severity"),
        tier=raw.get("tier"),
        confidence=raw.get("confidence"),
        verified_at=raw.get("verified_at"),
        status=raw.get("status") or STATUS_LIVE,
    )


def claims_from_dossier(dossier: Dict[str, Any]) -> List[ClaimWitness]:
    """Extract every ClaimWitness from one alpha/beta dossier dict."""
    out: List[ClaimWitness] = []
    for key, kind, _id_field in SOURCE_KEYS:
        rows = dossier.get(key) or []
        if not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict):
                out.append(normalize_claim(row, kind=kind))
    return out


def witness_check(
    claim: ClaimWitness, hasher: Any
) -> Tuple[bool, float, Optional[str]]:
    """Single verification stack: delegate to SourceHasher.verify_quote.

    Returns (is_verified, confidence, message). Claims with no quote or no
    hash are never verified (the auditor rejects them as UNVERIFIED_REJECTED).
    """
    if not claim.source_hash or not claim.verbatim_quote:
        return False, 0.0, "Missing source_hash or verbatim_quote"
    return hasher.verify_quote(claim.source_hash, claim.verbatim_quote)


def load_dossier(path: Path) -> Dict[str, Any]:
    """Load an alpha_dossier.json / beta_dossier.json file."""
    import json

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
