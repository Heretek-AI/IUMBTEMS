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
    _is_nonempty_str,
    normalized_nk_key,
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
    # R1: claim is witness-adjacent (hand-built callers may pass None/string
    # or a witness with int/dict source_hash) — getattr degrades to skip,
    # and unhashable hashes degrade to skip, never AttributeError/TypeError.
    _sh = getattr(claim, "source_hash", None)
    _sh_hashable = isinstance(_sh, str) and bool(_sh)
    if (
        constitution.retraction_policy == "zero_tolerance"
        and _sh_hashable
        and retracted_hashes
        and _sh in retracted_hashes
    ):
        reasons.append(f"ZERO_TOLERANCE_RETRACTION: source {_sh} was retracted")
    _status = getattr(claim, "status", None)
    if (
        _status in (STATUS_STALE, STATUS_SUSPECT)
        and constitution.retraction_policy == "zero_tolerance"
        and not any(r.startswith("ZERO_TOLERANCE_RETRACTION") for r in reasons)
    ):
        reasons.append(f"ZERO_TOLERANCE_RETRACTION: claim status {_status}")

    return {
        "claim_id": getattr(claim, "claim_id", "UNKNOWN"),
        "verdict": "REJECTED" if reasons else "ACCEPTED",
        "reasons": reasons,
    }


def _check_verified_claim(c: ClaimWitness, hasher: Any, out: List[Violation]) -> None:
    """Verified/claim-kind gates: hash, quote, then live witness check.

    R10 (tiebreak-2 F3): truthiness → isinstance+nonempty so the validator
    agrees with the scorer. `source_hash: 123` / `{"h": 1}` / `["h"]` and
    `verbatim_quote: 42` are missing (VERIFIED_REQUIRES_*), never a
    truthy-int bypass; the hasher guard requires both sides be non-empty
    str, so a dict hash is rejected without a hasher call (no TypeError
    inside `re.match`).
    """
    _sh = getattr(c, "source_hash", None)
    _q = getattr(c, "verbatim_quote", None)
    if not isinstance(_sh, str) or not _sh.strip():
        out.append(
            Violation(c.claim_id, "VERIFIED_REQUIRES_HASH", "source_hash missing")
        )
    if not isinstance(_q, str) or not _q.strip():
        out.append(
            Violation(c.claim_id, "VERIFIED_REQUIRES_QUOTE", "verbatim_quote missing")
        )
    if hasher is None or not (
        isinstance(_sh, str) and _sh.strip() and isinstance(_q, str) and _q.strip()
    ):
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
        # R10: parent_claims int/string/None must not pass via truthiness —
        # only a non-empty list/tuple satisfies (agrees with the brainstorm
        # scorer's well_formed gate); deductive_logic int/None/blank is
        # missing (isinstance+nonempty, not `not`).
        _parents = getattr(c, "parent_claims", [])
        if not isinstance(_parents, (list, tuple)) or len(_parents) == 0:
            out.append(
                Violation(
                    c.claim_id, "INFERRED_REQUIRES_PARENTS", "parent_claims empty"
                )
            )
        _logic = getattr(c, "deductive_logic", None)
        if not isinstance(_logic, str) or not _logic.strip():
            out.append(
                Violation(
                    c.claim_id, "INFERRED_REQUIRES_LOGIC", "deductive_logic missing"
                )
            )


def _check_hypotheses_and_neg_knowledge(c: ClaimWitness, out: List[Violation]) -> None:
    # R10: falsification int/None/blank is missing (isinstance+nonempty,
    # agreeing with the brainstorm scorer's well_formed gate which requires
    # `isinstance(str) and strip()`); NK query/finding int/None/blank (and
    # invisible-only via _is_nonempty_str) are missing, agreeing with the
    # claims-path scorer's normalized_nk_key (int query/finding rejected).
    _fals = getattr(c, "falsification", None)
    if (c.tag == TAG_HYPOTHESIS or c.kind == KIND_HYPOTHESIS) and (
        not isinstance(_fals, str) or not _fals.strip()
    ):
        out.append(
            Violation(
                c.claim_id, "HYPOTHESIS_REQUIRES_FALSIFICATION", "falsification missing"
            )
        )

    if c.tag == TAG_NEGATIVE_KNOWLEDGE or c.kind == KIND_NEGATIVE_KNOWLEDGE:
        if not _is_nonempty_str(getattr(c, "query", None)):
            out.append(
                Violation(c.claim_id, "NEG_KNOWLEDGE_REQUIRES_QUERY", "query missing")
            )
        if not _is_nonempty_str(getattr(c, "finding", None)):
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
    # R1: parent_claims is untrusted-adjacent (hand-built witnesses may carry
    # None/int/string) — only list/tuple iterates; unhashable parents (dict)
    # degrade to a violation, never TypeError. source_url int degrades to
    # skip via isinstance, never AttributeError on `.lower()`.
    parents = getattr(c, "parent_claims", [])
    if isinstance(parents, (list, tuple)):
        for parent in parents:
            try:
                unresolved = parent not in known_ids
            except TypeError:
                out.append(
                    Violation(
                        getattr(c, "claim_id", "UNKNOWN"),
                        "PARENT_UNRESOLVED",
                        f"parent_claims '{parent}' not in dossier set",
                    )
                )
                continue
            if unresolved:
                out.append(
                    Violation(
                        c.claim_id,
                        "PARENT_UNRESOLVED",
                        f"parent_claims '{parent}' not in dossier set",
                    )
                )

    if constitution.mandatory_tags and not c.tag:
        out.append(Violation(c.claim_id, "MISSING_TAG", "tag required by constitution"))

    _src = getattr(c, "source_url", None)
    if constitution.banned_domains and isinstance(_src, str) and _src:
        src_lower = _src.lower()
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
    # R1: callers pass normalized witnesses, but an adversarial list may carry
    # non-witness entries (None/string) — those degrade to skip, never
    # AttributeError on `.claim_id`.
    claim_list = [c for c in claim_list if isinstance(c, ClaimWitness)]
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
    _seen_nk = set()
    tier_weighted = any(
        not math.isclose(w, 1.0, rel_tol=1e-7)
        for w in constitution.tier_weights.values()
    )

    for c in claims:
        # R1: scorers consume witnesses derived from untrusted dossiers plus
        # hand-built test witnesses — non-witness entries degrade to skip,
        # never AttributeError on `.status`/`.tag`.
        if not isinstance(c, ClaimWitness):
            continue
        # R2 (tag-spoof, kind wins): an NK-kind witness never counts as
        # verified even when its row tag says VERIFIED (normalize_claim also
        # forces the tag, this is defense-in-depth for hand-built witnesses).
        # NK validity + exact-duplicate dedupe mirror the ingest normalizer so
        # scoring and rendering agree; duplicates contribute nothing. R11: the
        # dedupe key is the full cleaned pre-truncate pair
        # (normalized_nk_key), so distinct past-2k rows stay valid=2.
        if getattr(c, "kind", None) == KIND_NEGATIVE_KNOWLEDGE:
            _nk_key = normalized_nk_key(c)
            if _nk_key is not None and _nk_key not in _seen_nk:
                _seen_nk.add(_nk_key)
                counts["neg_knowledge"] += 1
            continue
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
            # 01-nk-hardening (A2): only valid {query, finding} rows count,
            # agreeing with the defensive renderer. Malformed rows are
            # dropped (no bonus), never scored. R11: full pre-truncate key.
            _nk_key = normalized_nk_key(c)
            if _nk_key is not None and _nk_key not in _seen_nk:
                _seen_nk.add(_nk_key)
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
    _seen_nk = set()
    for c in claims:
        # R1: scorers consume witnesses derived from untrusted dossiers plus
        # hand-built test witnesses — non-witness entries degrade to skip,
        # never AttributeError on `.status`/`.tag`.
        if not isinstance(c, ClaimWitness):
            continue
        # R2 (tag-spoof, kind wins): NK-kind witnesses never count as verified.
        # R11: the dedupe key is the full cleaned pre-truncate pair
        # (normalized_nk_key), mirroring the ingest normalizer — distinct
        # past-2k rows stay valid=2 in both scoring and rendering.
        if getattr(c, "kind", None) == KIND_NEGATIVE_KNOWLEDGE:
            _nk_key = normalized_nk_key(c)
            if _nk_key is not None and _nk_key not in _seen_nk:
                _seen_nk.add(_nk_key)
                counts["neg_knowledge"] += 1
            continue
        if c.status == STATUS_REJECTED or c.tag == "UNVERIFIED_REJECTED":
            counts["rejected"] += 1
        elif c.tag == TAG_VERIFIED:
            counts["verified"] += 1
        elif c.tag == TAG_INFERRED:
            counts["inferred"] += 1
            # R1: parent_claims is untrusted-adjacent (None/int/string) — only
            # a non-empty list/tuple earns well-formed credit, never a crash
            # or a truthy-int false positive.
            _parents = getattr(c, "parent_claims", [])
            if isinstance(_parents, (list, tuple)) and len(_parents) > 0:
                well_formed += 1
        elif c.tag == TAG_HYPOTHESIS:
            counts["hypotheses"] += 1
            # R1: falsification may be int/None on hand-built witnesses —
            # only a non-blank string earns well-formed credit (`.strip()`
            # requires a string).
            _fals = getattr(c, "falsification", "")
            if isinstance(_fals, str) and _fals.strip():
                well_formed += 1
        elif c.tag == TAG_NEGATIVE_KNOWLEDGE:
            # 01-nk-hardening (A2): only valid {query, finding} rows count,
            # agreeing with the defensive renderer. Malformed rows are
            # dropped (no bonus), never scored. R11: full pre-truncate key.
            _nk_key = normalized_nk_key(c)
            if _nk_key is not None and _nk_key not in _seen_nk:
                _seen_nk.add(_nk_key)
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
