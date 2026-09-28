#!/usr/bin/env python3
"""Canonical IUMBTEMS contracts, as data.

These are the single source of truth for the on-disk formats (Heretek-AI/IUMBTEMS#6
item 2.1: the agent had to reverse-engineer the contract). `scripts/gen_schemas.py`
renders them to `schemas/*.schema.json`; `runner/schema_validate.py` enforces them
warn-on-load. Keep this module in sync with what the runner actually reads and
writes — a test asserts the generated files match.
"""

from typing import Any, Dict

_DRAFT = "http://json-schema.org/draft-07/schema#"

CLAIM: Dict[str, Any] = {
    "type": "object",
    "required": ["claim_id", "statement"],
    "properties": {
        "claim_id": {"type": "string"},
        "tag": {
            "type": "string",
            "enum": ["VERIFIED", "INFERRED", "HYPOTHESIS", "NEGATIVE_KNOWLEDGE"],
        },
        "statement": {"type": "string"},
        "source_hash": {"type": "string"},
        "source_url": {"type": "string"},
        "verbatim_quote": {"type": "string"},
        "severity": {"type": "string"},
    },
}

INFERENCE: Dict[str, Any] = {
    "type": "object",
    "required": ["inference_id", "statement"],
    "properties": {
        "inference_id": {"type": "string"},
        "tag": {"type": "string"},
        "statement": {"type": "string"},
        "parent_claims": {"type": "array", "items": {"type": "string"}},
        "deductive_logic": {"type": "string"},
        "falsification": {"type": "string"},
    },
}

HYPOTHESIS: Dict[str, Any] = {
    "type": "object",
    "required": ["statement"],
    "properties": {
        "hypothesis_id": {"type": "string"},
        "claim_id": {"type": "string"},
        "tag": {"type": "string"},
        "statement": {"type": "string"},
        "falsification": {"type": "string"},
    },
}

NEGATIVE_KNOWLEDGE: Dict[str, Any] = {
    "type": "object",
    "required": ["query", "finding"],
    "properties": {
        "query": {"type": "string"},
        "finding": {"type": "string"},
    },
}

CANDIDATE_REPO: Dict[str, Any] = {
    "type": "object",
    "required": ["name"],
    "properties": {
        "repo_id": {"type": "string"},
        "name": {"type": "string"},
        "url": {"type": "string"},
        "source_hash": {"type": "string"},
        "verbatim_quote": {"type": "string"},
        "license": {"type": "string"},
        "license_risk": {
            "type": "string",
            "enum": ["SAFE", "COPYLEFT_WARNING", "PROHIBITIVE"],
        },
        "harvest_policy": {
            "type": "string",
            "enum": ["depend-or-vendor", "clean-room-rebuild-only"],
        },
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["feature", "verdict"],
                "properties": {
                    "feature": {"type": "string"},
                    "verdict": {
                        "type": "string",
                        "enum": ["depend", "vendor", "clean-room-rebuild", "skip"],
                    },
                    "reason": {"type": "string"},
                    "verbatim_quote": {"type": "string"},
                    "effort": {"type": "string"},
                    "impact": {"type": "integer"},
                    "differentiation": {"type": "integer"},
                },
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
        "attribution": {"type": "object"},
    },
}

_COMMON_DOSSIER: Dict[str, Any] = {
    "scope_id": {"type": "string"},
    "agent": {"type": "string"},
    "mode": {"type": "string"},
    "timestamp": {"type": "string"},
    "negative_knowledge": {"type": "array", "items": NEGATIVE_KNOWLEDGE},
    "candidate_repositories": {"type": "array", "items": CANDIDATE_REPO},
}


def _dossier(role: str, extra: Dict[str, Any]) -> Dict[str, Any]:
    props = dict(_COMMON_DOSSIER)
    props.update(extra)
    return {
        "$schema": _DRAFT,
        "title": f"{role}_dossier",
        "type": "object",
        "required": ["scope_id"],
        "properties": props,
    }


ALPHA_DOSSIER = _dossier(
    "alpha",
    {
        "affirmative_claims": {"type": "array", "items": CLAIM},
        "inferred_implications": {"type": "array", "items": INFERENCE},
    },
)

BETA_DOSSIER = _dossier(
    "beta",
    {
        "falsification_claims": {"type": "array", "items": CLAIM},
        "methodological_critiques": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "target_assertion": {"type": "string"},
                    "critique": {"type": "string"},
                    "evidence_hash": {"type": "string"},
                },
            },
        },
        "hypotheses": {"type": "array", "items": HYPOTHESIS},
    },
)

AUDIT_REPORT: Dict[str, Any] = {
    "$schema": _DRAFT,
    "title": "audit_report",
    "type": "object",
    "required": ["scope_id", "summary"],
    "properties": {
        "auditor": {"type": "string"},
        "scope_id": {"type": "string"},
        "audited_at": {"type": "string"},
        "summary": {
            "type": "object",
            "required": [
                "verified_passed",
                "unverified_rejected",
                "divergence_score",
                "verdict",
            ],
            "properties": {
                "total_claims_audited": {"type": "integer"},
                "verified_passed": {"type": "integer"},
                "unverified_rejected": {"type": "integer"},
                "negative_knowledge_count": {"type": "integer"},
                "epistemic_score": {"type": "number"},
                "divergence_score": {"type": "number"},
                "mode": {"type": ["string", "null"]},
                "blocking_findings": {"type": "integer"},
                "verdict": {"type": "string"},
            },
        },
        "alpha_claims_audit": {"type": "array"},
        "beta_claims_audit": {"type": "array"},
        "divergence_matrix": {"type": "array"},
        "harvest_findings": {"type": "array"},
        "degradation": {"type": "object"},
    },
}

SCOPE_MANIFEST: Dict[str, Any] = {
    "$schema": _DRAFT,
    "title": "scope_manifest",
    "type": "object",
    "required": ["scope_id", "status"],
    "properties": {
        "scope_id": {"type": "string"},
        "title": {"type": "string"},
        "objective": {"type": "string"},
        "dependencies": {"type": "array", "items": {"type": "string"}},
        "status": {"type": "string"},
        "alpha_completed": {"type": "boolean"},
        "beta_completed": {"type": "boolean"},
        "audit_completed": {"type": "boolean"},
        "created_at": {"type": "string"},
        "outputs": {"type": "array"},
        # Agent-authored (renamed on load); allowed but never authoritative.
        "self_reported_epistemic_audit": {"type": "object"},
    },
}

MANIFEST: Dict[str, Any] = {
    "$schema": _DRAFT,
    "title": "manifest",
    "type": "object",
    "required": ["session_id", "objective", "status", "scopes"],
    "properties": {
        "session_id": {"type": "string"},
        "objective": {"type": "string"},
        "status": {"type": "string"},
        "created_at": {"type": "string"},
        "updated_at": {"type": "string"},
        "plugin_version": {"type": "string"},
        "backend": {"type": "string"},
        "preflight": {"type": "object"},
        "scopes": {"type": "array"},
        "telemetry": {"type": "object"},
    },
}

FRONTIER: Dict[str, Any] = {
    "$schema": _DRAFT,
    "title": "frontier",
    "type": "object",
    "required": ["objective"],
    "properties": {
        "objective": {"type": "string"},
        "is_complete": {"type": "boolean"},
        # Nodes are keyed by node_id (see skills/grilling/socratic_tree.py).
        "nodes": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "required": ["node_id", "question"],
                "properties": {
                    "node_id": {"type": "string"},
                    "title": {"type": "string"},
                    "question": {"type": "string"},
                    "recommended": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                    "prerequisites": {"type": "array", "items": {"type": "string"}},
                    "settled_answer": {"type": ["string", "null"]},
                },
            },
        },
        "settled_constraints": {"type": "object"},
    },
}

SCHEMAS: Dict[str, Dict[str, Any]] = {
    "alpha_dossier": ALPHA_DOSSIER,
    "beta_dossier": BETA_DOSSIER,
    "audit_report": AUDIT_REPORT,
    "manifest": MANIFEST,
    "scope_manifest": SCOPE_MANIFEST,
    "frontier": FRONTIER,
}
