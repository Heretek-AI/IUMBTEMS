#!/usr/bin/env python3
"""
Refinement-type checker for epistemic claims + pure E(D) scoring.

Machine-checkable invariants over ClaimWitness records:
  VERIFIED            => has source_hash AND verbatim_quote AND passes witness_check
  INFERRED            => parent_claims non-empty AND deductive_logic present
  HYPOTHESIS          => falsification present (measurable test)
  NEGATIVE_KNOWLEDGE  => query AND finding present
  cross-reference     => every parent_claims id resolves within the dossier set

Also extracts the epistemic score E(D) into a pure function so Domain Packs
(Stream G) can override constitution without touching the auditor.

Constitution defaults reproduce the LEGACY inlined arithmetic exactly
(flat 1.0 per verified claim), because the published docs' tier-weighted
V(c_i) has never been what the runtime computes. Tier weighting becomes an
opt-in constitution — nothing flips without an explicit pack.
"""

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

from runner.claim_witness import (
    KIND_CLAIM,
    KIND_HYPOTHESIS,
    KIND_INFERENCE,
    KIND_NEGATIVE_KNOWLEDGE,
    STATUS_REJECTED,
    TAG_HYPOTHESIS,
    TAG_INFERRED,
    TAG_NEGATIVE_KNOWLEDGE,
    TAG_VERIFIED,
    ClaimWitness,
    witness_check,
)


@dataclass
class Violation:
    claim_id: str
    rule: str
    message: str

    def to_dict(self) -> Dict[str, str]:
        return {"claim_id": self.claim_id, "rule": self.rule, "message": self.message}


@dataclass
class Constitution:
    """Scoring + enforcement policy. Defaults == legacy auditor behavior."""

    # Per-verified-claim weight. Flat 1.0 reproduces legacy E(D).
    tier_weights: Dict[str, float] = field(default_factory=lambda: {"__default__": 1.0})
    neg_bonus: float = 0.5
    reject_penalty: float = 2.5
    accept_threshold: float = 0.65

    # Domain-pack enforcement (Stream G); empty = no restriction.
    banned_domains: List[str] = field(default_factory=list)
    mandatory_tags: List[str] = field(default_factory=list)
    retraction_policy: str = "standard"  # or "zero_tolerance"

    def weight_for(self, tier: Optional[str]) -> float:
        if tier is not None and tier in self.tier_weights:
            return self.tier_weights[tier]
        return self.tier_weights.get("__default__", 1.0)


LEGACY_CONSTITUTION = Constitution()


# ---------------------------------------------------------------------------
# Domain Packs (Stream G): pluggable epistemic constitutions
# ---------------------------------------------------------------------------


def _project_root():
    from pathlib import Path

    return Path(__file__).resolve().parent.parent


def load_domain_pack(pack: str) -> Constitution:
    """Load a Constitution from a pack id (config/domain_packs/<id>.json) or path.

    Unknown/unloadable packs raise FileNotFoundError — silent fallback to
    legacy would hide a regulatory misconfiguration.

    Surrounding whitespace is stripped before resolving (H3), so a padded id
    from a UI affordance resolves like the clean id; blank ids still raise.
    """

    import json
    from pathlib import Path

    pack = pack.strip() if isinstance(pack, str) else pack
    candidates = []
    p = Path(pack)
    if p.suffix == ".json" or "/" in pack:
        candidates.append(p)
    else:
        candidates.append(_project_root() / "config" / "domain_packs" / f"{pack}.json")

    for cand in candidates:
        if cand.exists():
            data = json.loads(cand.read_text(encoding="utf-8"))
            return Constitution(
                tier_weights=data.get("tier_weights") or {"__default__": 1.0},
                neg_bonus=float(data.get("neg_bonus", 0.5)),
                reject_penalty=float(data.get("reject_penalty", 2.5)),
                accept_threshold=float(data.get("accept_threshold", 0.65)),
                banned_domains=list(data.get("banned_domains") or []),
                mandatory_tags=list(data.get("mandatory_tags") or []),
                retraction_policy=str(data.get("retraction_policy") or "standard"),
            )
    raise FileNotFoundError(f"domain pack not found: {pack}")


def claim_verdict(
    claim: "ClaimWitness",
    hasher: Any = None,
    constitution: Optional[Constitution] = None,
    retracted_hashes: Optional[set] = None,
) -> Dict[str, Any]:
    """Per-claim ACCEPTED/REJECTED gate used by Domain Packs.

    A claim is REJECTED when:
      - any check_invariants rule fires under this constitution
        (incl. banned domains, missing mandatory tags), or
      - constitution.retraction_policy == "zero_tolerance" and its source is
        in `retracted_hashes` (downgrade regardless of quote match or score).
    """
    from runner.claim_witness import STATUS_STALE, STATUS_SUSPECT

    constitution = constitution or LEGACY_CONSTITUTION
    violations = check_invariants([claim], hasher=hasher, constitution=constitution)

    reasons = [f"{v.rule}: {v.message}" for v in violations]
    if (
        constitution.retraction_policy == "zero_tolerance"
        and claim.source_hash
        and retracted_hashes
        and claim.source_hash in retracted_hashes
    ):
        reasons.append(
            f"ZERO_TOLERANCE_RETRACTION: source {claim.source_hash} was retracted"
        )
    if (
        claim.status in (STATUS_STALE, STATUS_SUSPECT)
        and constitution.retraction_policy == "zero_tolerance"
        and not any(r.startswith("ZERO_TOLERANCE_RETRACTION") for r in reasons)
    ):
        reasons.append(f"ZERO_TOLERANCE_RETRACTION: claim status {claim.status}")

    return {
        "claim_id": claim.claim_id,
        "verdict": "REJECTED" if reasons else "ACCEPTED",
        "reasons": reasons,
    }


def _check_verified_claim(c: ClaimWitness, hasher: Any, out: List[Violation]) -> None:
    """Verified/claim-kind gates: hash, quote, then live witness check."""
    if not c.source_hash:
        out.append(
            Violation(c.claim_id, "VERIFIED_REQUIRES_HASH", "source_hash missing")
        )
    if not c.verbatim_quote:
        out.append(
            Violation(c.claim_id, "VERIFIED_REQUIRES_QUOTE", "verbatim_quote missing")
        )
    if hasher is None or not (c.source_hash and c.verbatim_quote):
        return
    passed, _conf, msg = witness_check(c, hasher)
    if not passed:
        out.append(
            Violation(c.claim_id, "WITNESS_CHECK_FAILED", msg or "quote not in source")
        )


def _check_verified_and_inferred(
    c: ClaimWitness, hasher: Any, out: List[Violation]
) -> None:
    if c.tag == TAG_VERIFIED or c.kind == KIND_CLAIM:
        _check_verified_claim(c, hasher, out)

    if c.tag == TAG_INFERRED or c.kind == KIND_INFERENCE:
        if not c.parent_claims:
            out.append(
                Violation(
                    c.claim_id, "INFERRED_REQUIRES_PARENTS", "parent_claims empty"
                )
            )
        if not c.deductive_logic:
            out.append(
                Violation(
                    c.claim_id, "INFERRED_REQUIRES_LOGIC", "deductive_logic missing"
                )
            )


def _check_hypotheses_and_neg_knowledge(c: ClaimWitness, out: List[Violation]) -> None:
    if (c.tag == TAG_HYPOTHESIS or c.kind == KIND_HYPOTHESIS) and not c.falsification:
        out.append(
            Violation(
                c.claim_id, "HYPOTHESIS_REQUIRES_FALSIFICATION", "falsification missing"
            )
        )

    if c.tag == TAG_NEGATIVE_KNOWLEDGE or c.kind == KIND_NEGATIVE_KNOWLEDGE:
        if not c.query:
            out.append(
                Violation(c.claim_id, "NEG_KNOWLEDGE_REQUIRES_QUERY", "query missing")
            )
        if not c.finding:
            out.append(
                Violation(
                    c.claim_id, "NEG_KNOWLEDGE_REQUIRES_FINDING", "finding missing"
                )
            )


def _check_constitution_and_parents(
    c: ClaimWitness,
    known_ids: set,
    constitution: Constitution,
    out: List[Violation],
) -> None:
    for parent in c.parent_claims:
        if parent not in known_ids:
            out.append(
                Violation(
                    c.claim_id,
                    "PARENT_UNRESOLVED",
                    f"parent_claims '{parent}' not in dossier set",
                )
            )

    if constitution.mandatory_tags and not c.tag:
        out.append(Violation(c.claim_id, "MISSING_TAG", "tag required by constitution"))

    if constitution.banned_domains and c.source_url:
        src_lower = c.source_url.lower()
        for dom in constitution.banned_domains:
            if dom.lower() in src_lower:
                out.append(
                    Violation(
                        c.claim_id,
                        "BANNED_DOMAIN",
                        f"source_url on banned domain '{dom}'",
                    )
                )


def check_invariants(
    claims: Iterable[ClaimWitness],
    hasher: Any = None,
    constitution: Optional[Constitution] = None,
) -> List[Violation]:
    """Return every invariant violation found across the claim set.

    Pass `hasher` (a SourceHasher) to enable the live quote check for
    VERIFIED claims; without it, only structural rules are enforced.
    """
    constitution = constitution or LEGACY_CONSTITUTION
    claim_list = list(claims)
    known_ids = {c.claim_id for c in claim_list}
    out: List[Violation] = []

    for c in claim_list:
        _check_verified_and_inferred(c, hasher, out)
        _check_hypotheses_and_neg_knowledge(c, out)
        _check_constitution_and_parents(c, known_ids, constitution, out)

    return out


def compute_epistemic_score(
    counts: Dict[str, int],
    constitution: Optional[Constitution] = None,
) -> Tuple[float, Dict[str, Any]]:
    """Pure E(D) — deterministic, bounded to [0, 1], legacy-compatible.

    Takes the tallies the auditor already computes:
        counts = {"verified": N, "rejected": N, "inferred": N,
                  "hypotheses": N, "neg_knowledge": N}

    Legacy formula (runner/auditor_engine.py, pre-refactor):
        total_assertions = max(1, verified + inferred + hypotheses + rejected)
        raw = (1.0*verified + 0.5*neg_knowledge - 2.5*rejected) / total_assertions
        score = clamp(round(raw, 3), 0.0, 1.0)

    Returns (score, breakdown). Breakdown carries the same counts back so the
    auditor's summary keys stay byte-identical.
    """
    constitution = constitution or LEGACY_CONSTITUTION

    total_verified = int(counts.get("verified", 0))
    total_rejected = int(counts.get("rejected", 0))
    total_inferred = int(counts.get("inferred", 0))
    total_hypotheses = int(counts.get("hypotheses", 0))
    total_neg_knowledge = int(counts.get("neg_knowledge", 0))

    # Legacy flat weighting: every verified claim counts as 1.0 regardless of
    # tier. A Domain Pack may override tier_weights; then each verified claim
    # would need its tier looked up — that path is exercised by Stream G's
    # `compute_epistemic_score_from_claims`, not here.
    verified_weight = constitution.weight_for(None) * total_verified

    total_assertions = max(
        1, total_verified + total_inferred + total_hypotheses + total_rejected
    )
    raw_score = (
        verified_weight
        + constitution.neg_bonus * total_neg_knowledge
        - constitution.reject_penalty * total_rejected
    ) / total_assertions
    epistemic_score = max(0.0, min(1.0, round(raw_score, 3)))

    breakdown = {
        "total_claims_audited": total_verified + total_rejected,
        "verified_passed": total_verified,
        "unverified_rejected": total_rejected,
        "negative_knowledge_count": total_neg_knowledge,
        "inferred_count": total_inferred,
        "hypothesis_count": total_hypotheses,
        "verified_weight": verified_weight,
        "total_assertions": total_assertions,
        "raw_score": raw_score,
    }
    return epistemic_score, breakdown


def compute_epistemic_score_from_claims(
    claims: Iterable[ClaimWitness],
    constitution: Optional[Constitution] = None,
) -> Tuple[float, Dict[str, Any]]:
    """Same E(D), but computed over ClaimWitness records (tier-aware path).

    Used by Domain Packs (Stream G) where a constitution supplies per-tier
    weights. Falls back to flat 1.0 when the constitution is legacy.
    """
    constitution = constitution or LEGACY_CONSTITUTION
    counts = {
        "verified": 0,
        "rejected": 0,
        "inferred": 0,
        "hypotheses": 0,
        "neg_knowledge": 0,
    }
    weight_sum = 0.0
    tier_weighted = any(
        not math.isclose(w, 1.0, rel_tol=1e-7)
        for w in constitution.tier_weights.values()
    )

    for c in claims:
        if c.status == STATUS_REJECTED or c.tag == "UNVERIFIED_REJECTED":
            counts["rejected"] += 1
        elif c.tag == TAG_VERIFIED:
            counts["verified"] += 1
            weight_sum += constitution.weight_for(c.tier) if tier_weighted else 1.0
        elif c.tag == TAG_INFERRED:
            counts["inferred"] += 1
        elif c.tag == TAG_HYPOTHESIS:
            counts["hypotheses"] += 1
        elif c.tag == TAG_NEGATIVE_KNOWLEDGE:
            counts["neg_knowledge"] += 1

    total_assertions = max(
        1,
        counts["verified"]
        + counts["inferred"]
        + counts["hypotheses"]
        + counts["rejected"],
    )
    raw_score = (
        weight_sum
        + constitution.neg_bonus * counts["neg_knowledge"]
        - constitution.reject_penalty * counts["rejected"]
    ) / total_assertions
    epistemic_score = max(0.0, min(1.0, round(raw_score, 3)))

    breakdown = {
        "total_claims_audited": counts["verified"] + counts["rejected"],
        "verified_passed": counts["verified"],
        "unverified_rejected": counts["rejected"],
        "negative_knowledge_count": counts["neg_knowledge"],
        "inferred_count": counts["inferred"],
        "hypothesis_count": counts["hypotheses"],
        "verified_weight": weight_sum,
        "total_assertions": total_assertions,
        "raw_score": raw_score,
    }
    return epistemic_score, breakdown


# Brainstorm's deliverable is hypotheses, not quote-verified facts. Scoring it
# with the research formula (which counts only verified claims positively)
# guarantees WARNING_LOW_GROUNDING on a well-formed ideation run.
BRAINSTORM_MODE_THRESHOLD = 0.5


def compute_brainstorm_score_from_claims(
    claims: Iterable[ClaimWitness],
    constitution: Optional[Constitution] = None,
) -> Tuple[float, Dict[str, Any]]:
    """E(D) variant for brainstorm mode: credit *well-formed* speculation.

    A hypothesis scores when it carries a falsification criterion; an inference
    when it names its parent claims; negative knowledge earns the usual bonus;
    verified workspace facts still count. Only rejected (quote-unverified)
    VERIFIED claims are penalized. This keeps brainstorm honest about grounding
    without failing a mode whose output is speculative by design.
    """
    constitution = constitution or LEGACY_CONSTITUTION
    counts = {
        "verified": 0,
        "rejected": 0,
        "inferred": 0,
        "hypotheses": 0,
        "neg_knowledge": 0,
    }
    well_formed = 0
    for c in claims:
        if c.status == STATUS_REJECTED or c.tag == "UNVERIFIED_REJECTED":
            counts["rejected"] += 1
        elif c.tag == TAG_VERIFIED:
            counts["verified"] += 1
        elif c.tag == TAG_INFERRED:
            counts["inferred"] += 1
            if c.parent_claims:
                well_formed += 1
        elif c.tag == TAG_HYPOTHESIS:
            counts["hypotheses"] += 1
            if (c.falsification or "").strip():
                well_formed += 1
        elif c.tag == TAG_NEGATIVE_KNOWLEDGE:
            counts["neg_knowledge"] += 1

    total_assertions = max(
        1,
        counts["verified"]
        + counts["inferred"]
        + counts["hypotheses"]
        + counts["rejected"]
        + counts["neg_knowledge"],
    )
    raw_score = (
        counts["verified"]
        + well_formed
        + constitution.neg_bonus * counts["neg_knowledge"]
        - constitution.reject_penalty * counts["rejected"]
    ) / total_assertions
    epistemic_score = max(0.0, min(1.0, round(raw_score, 3)))

    breakdown = {
        "total_claims_audited": counts["verified"] + counts["rejected"],
        "verified_passed": counts["verified"],
        "unverified_rejected": counts["rejected"],
        "negative_knowledge_count": counts["neg_knowledge"],
        "inferred_count": counts["inferred"],
        "hypothesis_count": counts["hypotheses"],
        "well_formed_count": well_formed,
        "verified_weight": float(counts["verified"]),
        "total_assertions": total_assertions,
        "raw_score": raw_score,
    }
    return epistemic_score, breakdown
