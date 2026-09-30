#!/usr/bin/env python3
"""Canonical IUMBTEMS contracts, as data.

These are the single source of truth for the on-disk formats (Heretek-AI/IUMBTEMS#6
item 2.1: the agent had to reverse-engineer the contract). `scripts/gen_schemas.py`
renders them to `schemas/*.schema.json`; `runner/schema_validate.py` enforces them
warn-on-load. Keep this module in sync with what the runner actually reads and
writes — a test asserts the generated files match.
"""

from typing import Any, Dict

import copy

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
        # Advisory only: recorded from config at run start; never gates a
        # verdict (see CONFIG["divergence_threshold"]).
        "divergence_threshold": {"type": ["number", "null"]},
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


# ---------------------------------------------------------------------------
# config — canonical `.research/config.json` contract
# ---------------------------------------------------------------------------
#
# This is the single source of truth for the persisted swarm configuration. The
# defaults here are mirrored into `skills/swarm_config/configure.py`
# (`DEFAULT_CONFIG`); a test asserts they never drift.
#
# Per-key annotations (draft-07 allows unknown keywords; `schema_validate.py`
# ignores them):
#   * `x-label`    — human row label for the settings surface.
#   * `x-scope`    — which subsystem consumes the key: "run" (swarm dispatch),
#                    "retrieval" (search), "dispatch" (agent process), "audit"
#                    (verification/grounding policy), "cache", "layout".
#   * `x-restart`  — when a change takes effect: "next-run" (the runner
#                    snapshots config at construction; spawned children inherit
#                    the value from the next spawn) or "none" (deprecated).
#   * `deprecated` — kept for backward-compatible loading; no behavioural
#                    consumer.
#
# Unknown keys are allowed and preserved on write. The dependency-free
# validator subset is: type (incl. unions), required, properties, items, enum,
# additionalProperties, minimum, maximum, minLength, pattern.

CONFIG_DEFAULTS: Dict[str, Any] = {
    "search_engine": "duckduckgo",
    "max_iterations": 2,
    "divergence_threshold": 0.75,
    "mode": "research",
    "backend": "auto",
    "cache_raw_markdown": True,
    "cache_ttl_days": None,
    "search_timeout_s": None,
    "searxng_url": None,
    "license_whitelist": ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"],
    "output_dir": ".research",
    "allocation": "dag",
    "domain_pack": None,
    "verify": {"min_fuzzy_confidence": 0.88},
    "agents": {
        "alpha": {"backend": None, "model": None, "opencode_agent": None},
        "beta": {"backend": None, "model": None, "opencode_agent": None},
    },
    "opencode_auto": None,
    "opencode_agent": None,
    "mcp_servers": {},
}


def _agent_role_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "x-label": "Agent Role",
        "properties": {
            "backend": {
                "type": ["array", "null"],
                "items": {"type": "string"},
                "default": None,
                "x-label": "Backend Command",
                "description": (
                    "Argv list for this role (e.g. ['claude','-p'] or "
                    "['opencode','run']); null falls through to the host-native "
                    "default. Resolved by SwarmRunner._resolve_agent_backend."
                ),
            },
            "model": {
                "type": ["string", "null"],
                "default": None,
                "x-label": "Model",
                "description": "Model id passed to the backend as --model.",
            },
            "opencode_agent": {
                "type": ["string", "null"],
                "default": None,
                "x-label": "OpenCode Agent",
                "description": (
                    "Optional named opencode agent profile for `opencode run "
                    "--agent`; null inlines the prompt instead."
                ),
            },
        },
    }


CONFIG: Dict[str, Any] = {
    "$schema": _DRAFT,
    "title": "config",
    "type": "object",
    "description": (
        "Canonical .research/config.json contract. Unknown keys are allowed and "
        "preserved on write; saves are validated, locked, and atomic. null is "
        'accepted only for nullable keys (type includes "null") and means '
        "'follow the default policy'; non-nullable keys reject null."
    ),
    "properties": {
        "search_engine": {
            "type": "string",
            "enum": ["duckduckgo", "brave", "firecrawl", "searxng"],
            "default": CONFIG_DEFAULTS["search_engine"],
            "x-label": "Primary Search Engine",
            "x-scope": "retrieval",
            "x-restart": "next-run",
            "description": (
                "Primary retrieval engine. duckduckgo is the zero-key default; "
                "searxng additionally needs searxng_url (or SEARXNG_URL in the "
                "environment)."
            ),
        },
        "max_iterations": {
            "type": "integer",
            "minimum": 1,
            "maximum": 4,
            "default": CONFIG_DEFAULTS["max_iterations"],
            "x-label": "Research Depth",
            "x-scope": "run",
            "x-restart": "next-run",
            "description": "Dialectic depth / max iterations (1-4).",
        },
        "divergence_threshold": {
            "type": "number",
            "minimum": 0.0,
            "maximum": 1.0,
            "default": CONFIG_DEFAULTS["divergence_threshold"],
            "x-label": "Divergence Threshold",
            "x-scope": "audit",
            "x-restart": "next-run",
            "description": (
                "ADVISORY only: recorded in the run manifest and the master "
                "synthesis; it never gates audit verdicts or quote verification."
            ),
        },
        "mode": {
            "type": "string",
            "enum": [
                "research",
                "audit",
                "scout",
                "hybrid",
                "brainstorm",
                "darkharvest",
            ],
            "default": CONFIG_DEFAULTS["mode"],
            "x-label": "Operating Mode",
            "x-scope": "run",
            "x-restart": "next-run",
            "description": "Default operating mode when --mode is not passed.",
        },
        "backend": {
            "type": "string",
            "enum": ["auto", "claude", "opencode"],
            "default": CONFIG_DEFAULTS["backend"],
            "x-label": "Agent Backend",
            "x-scope": "dispatch",
            "x-restart": "next-run",
            "description": (
                "Agent runtime backend. auto = host-native (claude -p on Claude "
                "Code, opencode run on OpenCode)."
            ),
        },
        "cache_raw_markdown": {
            "type": "boolean",
            "default": CONFIG_DEFAULTS["cache_raw_markdown"],
            "x-label": "Raw Markdown Caching",
            "x-scope": "cache",
            "x-restart": "next-run",
            "description": (
                "When false, spawned WebFetch-cache children archive nothing "
                "(IUMBTEMS_CACHE_RAW_MARKDOWN=0 is exported to the child env); "
                "true (default) keeps raw markdown copies in .research/sources."
            ),
        },
        "cache_ttl_days": {
            "type": ["integer", "null"],
            "minimum": 0,
            "default": CONFIG_DEFAULTS["cache_ttl_days"],
            "x-label": "Cache TTL (days)",
            "x-scope": "cache",
            "x-restart": "next-run",
            "description": (
                "WebFetch cache TTL override exported as IUMBTEMS_FETCH_TTL_DAYS "
                "when set. null keeps webcache's per-domain policy (7 days "
                "general, 30 days documentation domains)."
            ),
        },
        "search_timeout_s": {
            "type": ["number", "null"],
            "minimum": 1,
            "default": CONFIG_DEFAULTS["search_timeout_s"],
            "x-label": "Search Timeout (s)",
            "x-scope": "retrieval",
            "x-restart": "next-run",
            "description": (
                "HTTP timeout for search fetches, exported as "
                "IUMBTEMS_SEARCH_TIMEOUT_S when set. null keeps each surface's "
                "built-in default (search.py 15s, preflight probe 5s)."
            ),
        },
        "searxng_url": {
            "type": ["string", "null"],
            "pattern": "^https?://",
            "default": CONFIG_DEFAULTS["searxng_url"],
            "x-label": "SearXNG URL",
            "x-scope": "retrieval",
            "x-restart": "next-run",
            "description": (
                "Base URL of a self-hosted SearXNG; exported to spawned children "
                "as SEARXNG_URL when set (preflight also reads the env var). Must "
                "include an http:// or https:// scheme; null leaves the "
                "environment untouched."
            ),
        },
        "license_whitelist": {
            "type": "array",
            "items": {"type": "string"},
            "default": copy.deepcopy(CONFIG_DEFAULTS["license_whitelist"]),
            "x-label": "License Whitelist",
            "x-scope": "audit",
            "x-restart": "next-run",
            "description": (
                "SPDX ids darkharvest may depend on or vendor. Missing/empty "
                "falls back to the built-in permissive set (MIT, Apache-2.0, "
                "BSD-3-Clause, ISC); anything else is clean-room-rebuild-only."
            ),
        },
        "output_dir": {
            "type": "string",
            "default": CONFIG_DEFAULTS["output_dir"],
            "deprecated": True,
            "x-label": "Output Directory (deprecated)",
            "x-scope": "layout",
            "x-restart": "none",
            "description": (
                "DEPRECATED: display-only. The workspace is selected by base_dir "
                "/ --dir, never by this key. Kept for backward-compatible "
                "loading; slated for removal in a future major."
            ),
        },
        "allocation": {
            "type": "string",
            "enum": ["dag", "auction"],
            "default": CONFIG_DEFAULTS["allocation"],
            "x-label": "Scope Allocation",
            "x-scope": "run",
            "x-restart": "next-run",
            "description": (
                "Scope allocation policy: dag = legacy dependency order, "
                "auction = Frontier Markets (highest expected-information gain)."
            ),
        },
        "domain_pack": {
            "type": ["string", "null"],
            "minLength": 1,
            "default": CONFIG_DEFAULTS["domain_pack"],
            "x-label": "Domain Pack",
            "x-scope": "audit",
            "x-restart": "next-run",
            "description": (
                "Regulated Domain Pack id (config/domain_packs/) or null for the "
                "legacy constitution. The empty string is rejected; a pack id "
                "that does not resolve fails loudly when the constitution loads."
            ),
        },
        "verify": {
            "type": "object",
            "default": copy.deepcopy(CONFIG_DEFAULTS["verify"]),
            "x-label": "Verification Policy",
            "x-scope": "audit",
            "x-restart": "next-run",
            "description": (
                "Quote-verification policy. Applies to the next audit run and to "
                "iumbtems_verify_quote; the proof-carrying brief verifier always "
                "re-checks at the strict default."
            ),
            "properties": {
                "min_fuzzy_confidence": {
                    "type": "number",
                    "minimum": 0.0,
                    "maximum": 1.0,
                    "default": CONFIG_DEFAULTS["verify"]["min_fuzzy_confidence"],
                    "x-label": "Min Fuzzy Confidence",
                    "description": (
                        "Minimum word-overlap confidence for the fuzzy quote "
                        "match in SourceHasher.verify_quote (default 0.88)."
                    ),
                },
            },
        },
        "agents": {
            "type": "object",
            "default": copy.deepcopy(CONFIG_DEFAULTS["agents"]),
            "x-label": "Agent Backends",
            "x-scope": "dispatch",
            "x-restart": "next-run",
            "description": (
                "Per-role backend overrides; unknown roles and role keys are "
                "preserved. Asymmetry is deliberate: Alpha and Beta on different "
                "model families probe divergence prompt-level red-teaming cannot."
            ),
            "properties": {
                "alpha": _agent_role_schema(),
                "beta": _agent_role_schema(),
            },
        },
        "opencode_auto": {
            "type": ["boolean", "null"],
            "default": CONFIG_DEFAULTS["opencode_auto"],
            "x-label": "OpenCode --auto",
            "x-scope": "dispatch",
            "x-restart": "next-run",
            "description": (
                "Whether spawned `opencode run` children get --auto; null uses "
                "the default (enabled; env IUMBTEMS_OPENCODE_AUTO wins)."
            ),
        },
        "opencode_agent": {
            "type": ["string", "null"],
            "default": CONFIG_DEFAULTS["opencode_agent"],
            "x-label": "Default OpenCode Agent",
            "x-scope": "dispatch",
            "x-restart": "next-run",
            "description": (
                "Default named opencode agent profile for all roles; per-role "
                "agents.<role>.opencode_agent wins."
            ),
        },
        "mcp_servers": {
            "type": "object",
            "default": copy.deepcopy(CONFIG_DEFAULTS["mcp_servers"]),
            "x-label": "MCP Servers",
            "x-scope": "dispatch",
            "x-restart": "next-run",
            "description": (
                "Persisted toggle map for the plugin-controllable MCP server "
                "set (bundled `iumbtems` server plus research servers declared "
                "in the project OpenCode config). Keys are server names; "
                "values are booleans (true = enabled, false = disabled). "
                "Absent keys mean enabled. Applied via ctx.mcp.transform "
                "(`disabled` reconcile); the catalog file "
                "config/mcp-research-servers.json is never modified."
            ),
            "additionalProperties": {"type": "boolean"},
        },
    },
}


SCHEMAS: Dict[str, Dict[str, Any]] = {
    "config": CONFIG,
    "alpha_dossier": ALPHA_DOSSIER,
    "beta_dossier": BETA_DOSSIER,
    "audit_report": AUDIT_REPORT,
    "manifest": MANIFEST,
    "scope_manifest": SCOPE_MANIFEST,
    "frontier": FRONTIER,
}
