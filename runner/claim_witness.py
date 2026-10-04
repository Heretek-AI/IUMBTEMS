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


def _strip_invisible(text: str) -> str:
    """Remove invisible format characters (ZWSP/ZWNJ/ZWJ/BOM/word-joiners).

    R4: `str.strip()` leaves Cf format chars (`\\u200b\\u200c\\u200d\\ufeff`
    etc.), so an invisible-only NK field would pass the nonempty check and
    render an empty-looking row. All `Cf` chars are removed before the
    emptiness test; visible content keeps its characters (only invisibles
    stripped, then whitespace trimmed).
    """
    import unicodedata

    return "".join(c for c in text if unicodedata.category(c) != "Cf")


def _clean_nk_field(value: Any) -> Optional[str]:
    """Cleaned NK field text, or None when not a string.

    Returns the invisible-stripped + whitespace-trimmed string (possibly
    `""` for empty/whitespace-only/invisible-only input). Non-strings yield
    None so callers treat numeric/None sides as malformed (R4/R5).
    """
    if not isinstance(value, str):
        return None
    return _strip_invisible(value).strip()


# R6: bounded NK field length. A 1M-char LLM field must not produce a 2MB
# synthesis — overlong fields are truncated to this cap for render/storage
# (ingest valid rows + synthesis). R11: dedupe uses the full cleaned
# pre-truncate key; truncation happens only after the dedupe decision, so
# distinct past-2k rows stay valid=2 instead of collapsing.
NK_MAX_FIELD_LEN = 2000


def _truncate_nk_field(text: str) -> str:
    if len(text) > NK_MAX_FIELD_LEN:
        return text[:NK_MAX_FIELD_LEN]
    return text


def _is_nonempty_str(value: Any) -> bool:
    """Non-empty string check for untrusted NK fields (01-nk-hardening).

    Missing keys, None, non-strings, empty/whitespace-only, numeric sides,
    and invisible-only strings (R4: ZWSP/ZWJ/BOM/Cf-only) are all malformed —
    they must never reach the strict renderer.
    """
    cleaned = _clean_nk_field(value)
    return cleaned is not None and bool(cleaned)


def is_valid_negative_knowledge_row(row: Any) -> bool:
    """True when an NK row carries both contract fields (schemas.py NK).

    Canonical contract (runner/schemas.py NEGATIVE_KNOWLEDGE) requires
    `query` + `finding` as strings. Live LLM dossiers emit rows with a
    missing/None/non-string side; those are malformed and must be
    dropped (counted), never strictly indexed.
    """
    if not isinstance(row, dict):
        return False
    return _is_nonempty_str(row.get("query")) and _is_nonempty_str(row.get("finding"))


def normalize_negative_knowledge_rows(rows: Any) -> Tuple[List[Dict[str, Any]], int]:
    """Split untrusted NK rows into (valid_rows, dropped_count).

    R3: a single-dict `negative_knowledge` field is coerced to `[dict]` and
    validated (valid → 1 row, malformed → dropped=1) instead of vanishing
    with dropped=0. `None`/absent yields ([], 0); any other non-list field
    (string/int/...) yields ([], 1) — a malformed field, explicitly counted.

    R4: invisible-only fields (ZWSP/ZWJ/BOM/Cf-only) are dropped. Valid rows
    are returned as cleaned copies (invisibles stripped, trimmed, truncated
    to `NK_MAX_FIELD_LEN` per R6).

    R2: exact-duplicate `(query, finding)` pairs dedupe — the repeat is
    dropped+counted so copy-paste NK-spam cannot inflate `neg_knowledge`
    toward a spam CERTIFY. Residual risk (many *distinct* low-value rows each
    earning `neg_bonus`) is documented in the prompts: dropped rows carry no
    penalty, valid spam still counts — reviewers must treat an NK-heavy
    CERTIFY with suspicion.

    R11: dedupe key is the full cleaned pre-truncate pair; truncation applies
    only to render/storage copies. Duplicates still dedupe (dropped+1);
    distinct past-2k rows (same 2k prefix, different suffix) stay valid=2
    with dropped=0 — no collapse, no forgery. `dropped` therefore counts
    malformed + exact-duplicate repeats only; distinct rows never inflate it.
    """
    if rows is None:
        return [], 0
    if isinstance(rows, dict):
        rows = [rows]
    elif not isinstance(rows, list):
        return [], 1
    valid: List[Dict[str, Any]] = []
    dropped = 0
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            dropped += 1
            continue
        q_clean = _clean_nk_field(row.get("query"))
        f_clean = _clean_nk_field(row.get("finding"))
        if not q_clean or not f_clean:
            dropped += 1
            continue
        # R11: dedupe on the full cleaned key BEFORE truncation.
        key = (q_clean, f_clean)
        if key in seen:
            dropped += 1
            continue
        seen.add(key)
        # Truncate only for render/storage; the dedupe decision above used
        # the full key so distinct past-2k rows survive as valid=2.
        q_t = _truncate_nk_field(q_clean)
        f_t = _truncate_nk_field(f_clean)
        cleaned = dict(row)
        cleaned["query"] = q_t
        cleaned["finding"] = f_t
        valid.append(cleaned)
    return valid, dropped


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

    R2 (tag-spoof): for `KIND_NEGATIVE_KNOWLEDGE` the kind wins absolutely —
    the tag is forced to `TAG_NEGATIVE_KNOWLEDGE` even when the row carries
    `tag: VERIFIED`. Otherwise a spoofed NK row would create phantom
    `verified` counts in the claims-path scorers while the ingest renderer
    counts it as NK, splitting scoring from rendering.
    """
    if not isinstance(raw, dict):
        default_tag = {
            KIND_CLAIM: TAG_VERIFIED,
            KIND_INFERENCE: TAG_INFERRED,
            KIND_HYPOTHESIS: TAG_HYPOTHESIS,
            KIND_NEGATIVE_KNOWLEDGE: TAG_NEGATIVE_KNOWLEDGE,
        }[kind]
        return ClaimWitness(
            claim_id="UNKNOWN", kind=kind, tag=default_tag, statement=""
        )
    if kind == KIND_NEGATIVE_KNOWLEDGE:
        tag = TAG_NEGATIVE_KNOWLEDGE
    else:
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
    elif isinstance(parent_claims, (list, tuple)):
        pass
    else:
        # R1: non-list parent_claims (int/dict/None-shape) must not crash the
        # `[str(p) for p in ...]` comprehension — degrade to no parents.
        parent_claims = []

    # R1+R6+R11: statement fallback must survive non-string sides (int/None).
    # NK query/finding are cleaned (R4 invisibles) and kept FULL (R11: no
    # truncation here) so claims-path dedupe (normalized_nk_key, full key)
    # agrees with the ingest normalizer (full-key dedupe, valid=2 for
    # distinct past-2k). Truncation happens only for render/storage in
    # normalize_negative_knowledge_rows + synthesis. The NK *statement*
    # stays bounded (R6 witness-bloat defense).
    _stmt_raw = raw.get("statement") or raw.get("finding") or raw.get("query") or ""
    if not isinstance(_stmt_raw, str):
        _stmt_raw = str(_stmt_raw)
    # R6: bound NK statements — a 1M-char finding/query must not survive as a
    # 1M-char statement on the NK witness even though synthesis renders the
    # truncated query/finding (defense-in-depth against witness bloat).
    if kind == KIND_NEGATIVE_KNOWLEDGE and len(_stmt_raw) > NK_MAX_FIELD_LEN:
        _stmt_raw = _stmt_raw[:NK_MAX_FIELD_LEN]
    _nk_query = raw.get("query")
    _nk_finding = raw.get("finding")
    if kind == KIND_NEGATIVE_KNOWLEDGE:
        _q_clean = _clean_nk_field(_nk_query)
        _f_clean = _clean_nk_field(_nk_finding)
        # R11: keep the full cleaned text on the witness (truncate only for
        # render/storage). Storing truncated here would collapse distinct
        # past-2k rows to identical witnesses and split scoring from ingest.
        _nk_query = _q_clean if _q_clean else _nk_query
        _nk_finding = _f_clean if _f_clean else _nk_finding
        if not isinstance(_nk_query, str):
            pass
        if not isinstance(_nk_finding, str):
            pass

    return ClaimWitness(
        claim_id=str(claim_id),
        kind=kind,
        tag=tag,
        statement=_stmt_raw,
        source_hash=raw.get("source_hash"),
        source_url=raw.get("source_url"),
        verbatim_quote=raw.get("verbatim_quote"),
        parent_claims=[str(p) for p in parent_claims],
        deductive_logic=raw.get("deductive_logic"),
        falsification=raw.get("falsification"),
        query=_nk_query,
        finding=_nk_finding,
        severity=raw.get("severity"),
        tier=raw.get("tier"),
        confidence=raw.get("confidence"),
        verified_at=raw.get("verified_at"),
        status=raw.get("status") or STATUS_LIVE,
    )


def claim_has_valid_negative_knowledge(claim: "ClaimWitness") -> bool:
    """True when a normalized NK witness carries both contract fields.

    Scoring (refinement.py E(D) variants) must agree with rendering: only
    valid `{query, finding}` rows earn the neg-knowledge bonus. Malformed
    rows contribute nothing (dropped, not penalized).

    R1: `claim` may be a hand-built non-witness (None/string/dict) — those
    degrade to False via getattr, never AttributeError on `.query`.
    """
    q = getattr(claim, "query", None)
    f = getattr(claim, "finding", None)
    return _is_nonempty_str(q) and _is_nonempty_str(f)


def normalized_nk_key(claim: "ClaimWitness") -> Optional[Tuple[str, str]]:
    """Full cleaned (pre-truncate) (query, finding) dedupe key, or None if invalid.

    R2+R11: mirrors `normalize_negative_knowledge_rows` dedupe exactly (R4
    invisible strip, R11 full pre-truncate key — NOT the 2k-truncated pair)
    so claims-path scorers dedupe on the same key the ingest renderer uses —
    even for hand-built witnesses that bypass `normalize_claim` cleaning.
    Duplicates collapse (1); distinct past-2k rows stay distinct (2).
    """
    q = _clean_nk_field(getattr(claim, "query", None))
    f = _clean_nk_field(getattr(claim, "finding", None))
    if not q or not f:
        return None
    return (q, f)


def claims_from_dossier(dossier: Dict[str, Any]) -> List[ClaimWitness]:
    """Extract every ClaimWitness from one alpha/beta dossier dict.

    R3: a single-dict section (e.g. `negative_knowledge: {query, finding}`)
    coerces to `[dict]` so it is not silently skipped while ingest counts it.
    Non-list/non-dict sections (string/int) yield no witnesses — ingest
    counts the malformed field as dropped, and zero witnesses agrees on the
    valid count (0).
    """
    if not isinstance(dossier, dict):
        return []
    out: List[ClaimWitness] = []
    for key, kind, _id_field in SOURCE_KEYS:
        rows = dossier.get(key)
        if rows is None:
            continue
        if isinstance(rows, dict):
            rows = [rows]
        elif not isinstance(rows, list):
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

    R1: non-string hash/quote sides (source_hash int, verbatim_quote None)
    degrade to a rejection, never TypeError inside `verify_quote`
    (`re.match` requires a string). Non-witness inputs degrade likewise.
    """
    sh = getattr(claim, "source_hash", None)
    q = getattr(claim, "verbatim_quote", None)
    if not isinstance(sh, str) or not isinstance(q, str) or not sh or not q:
        return False, 0.0, "Missing source_hash or verbatim_quote"
    return hasher.verify_quote(sh, q)


def load_dossier(path: Path) -> Dict[str, Any]:
    """Load an alpha_dossier.json / beta_dossier.json file."""
    import json

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
