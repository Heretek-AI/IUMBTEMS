#!/usr/bin/env python3
"""Darkharvest claim normalization, license cross-check, and repo validation.

Heretek-AI/IUMBTEMS#5: darkharvest dossiers emit `candidate_repositories[]` with
their own `source_hash` witnesses, but the auditor only reads
`affirmative_claims` / `falsification_claims` — so `total_claims_audited` was
always 0 and the dialectic was structurally inert. Separately, alpha and beta
can disagree about a repo's license (observed: `MIT` vs `NOASSERTION` for the
same repo, with alpha recommending `depend-or-vendor`) and nothing cross-checked
them, because the audit produced no claims to compare.

This module supplies the three missing pieces:
- `normalize_dossier_claims` — fold darkharvest's shape into the standard claim
  schema so one contract flows to the auditor, PCRB, and ledger.
- `cross_check_repos` — alpha/beta license disagreement is a blocking finding,
  resolved conservatively.
- `RepoValidator` — ground-truth (existence / license / archived) with fail-open
  offline behavior.
"""

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

# Top-level dossier keys that *look* like audit output but are agent-authored.
# Renamed to `self_reported_*` on load so no consumer mistakes them for verified
# counts (see #5 layer 3).
AUDIT_SHAPED_KEYS = frozenset(
    {
        "epistemic_audit",
        "confidence",
        "gaps",
        "verified_claims",
        "unverified_claims",
        "verified_sources",
        "total_sources",
        "total_claims",
        "total_candidates",
        "claims_total",
        "claims_verified",
        "claims_unverified",
        "claims_falsified",
        "claims_unverifiable",
        "rejected_claims",
        "mean_epistemic_score",
        "primary_sources",
        "primary_benchmarks",
        "technical_specs",
        "peer_reviewed",
    }
)

# Licenses that may be `depend`ed on or `vendor`ed. Everything else (incl.
# unknown / NOASSERTION) resolves to clean-room-rebuild-only. This is the
# built-in fallback: `license_whitelist` in .research/config.json (normalized by
# `normalize_license_whitelist`) replaces it when non-empty, so the default
# config reproduces this set exactly.
PERMISSIVE_LICENSES = frozenset({"MIT", "APACHE-2.0", "BSD-3-CLAUSE", "ISC"})

UNKNOWN_LICENSES = frozenset({"", "UNKNOWN", "NOASSERTION", "NONE", "OTHER"})


def _norm_license(value: Any) -> str:
    return str(value or "").strip().upper()


def normalize_license_whitelist(whitelist: Any) -> frozenset:
    """Config `license_whitelist` -> normalized SPDX set.

    Missing, empty, or shape-invalid input falls back to the built-in permissive
    set (an empty whitelist must not silently make every license
    clean-room-only). Non-string entries are dropped rather than crashing the
    audit; a fully-unusable list also falls back.
    """
    if isinstance(whitelist, (list, tuple, set, frozenset)):
        normalized = {
            _norm_license(item)
            for item in whitelist
            if isinstance(item, str) and item.strip()
        }
        if normalized:
            return frozenset(normalized)
    return PERMISSIVE_LICENSES


def _is_permissive(value: Any, whitelist: Optional[frozenset] = None) -> bool:
    return _norm_license(value) in (
        whitelist if whitelist is not None else PERMISSIVE_LICENSES
    )


def sanitize_self_reported(dossier: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """Rename agent-authored audit-shaped keys; return (dossier, renamed_keys).

    Never deletes — the values are preserved under `self_reported_*` so a human
    can still see what the agent claimed, but nothing counts them.
    """
    renamed: List[str] = []
    if not isinstance(dossier, dict):
        return dossier, renamed
    for key in list(dossier.keys()):
        if key in AUDIT_SHAPED_KEYS:
            dossier[f"self_reported_{key}"] = dossier.pop(key)
            renamed.append(key)
    return dossier, renamed


def _repo_key(candidate: Dict[str, Any]) -> Optional[str]:
    """Stable key for a candidate repo: `owner/repo`, lowercased."""
    raw = str(candidate.get("name") or candidate.get("repo") or "").strip()
    if not raw:
        url = str(candidate.get("url") or "").strip()
        match = re.search(r"github\.com/([^/]+/[^/#?]+)", url)
        if match:
            raw = match.group(1)
    raw = raw.removesuffix(".git").strip("/")
    return raw.lower() if raw else None


def _verdict_claims(role: str, candidate: Dict[str, Any]) -> List[Dict[str, Any]]:
    """One standard claim per candidate verdict (verifiable when a quote exists)."""
    name = candidate.get("name") or candidate.get("url") or "unknown-repo"
    source_hash = candidate.get("source_hash")
    source_url = candidate.get("url")
    quote = candidate.get("verbatim_quote")
    out: List[Dict[str, Any]] = []
    for i, verdict in enumerate(candidate.get("verdicts") or [], start=1):
        if not isinstance(verdict, dict):
            continue
        rid = candidate.get("repo_id") or name
        out.append(
            {
                "claim_id": f"{rid}-{role}-V{i}",
                "tag": "VERIFIED",
                "statement": (
                    f"{name}: {verdict.get('feature', '?')} → "
                    f"{verdict.get('verdict', '?')} ({verdict.get('reason', '')})"
                ),
                "source_hash": source_hash,
                "source_url": source_url,
                # Prefer a verdict-specific quote; fall back to the candidate's.
                "verbatim_quote": verdict.get("verbatim_quote") or quote,
            }
        )
    return out


def normalize_dossier_claims(
    dossier: Dict[str, Any], role: str
) -> List[Dict[str, Any]]:
    """Standard-schema claims for a dossier.

    Uses the canonical keys when present; otherwise (darkharvest) derives them
    from `candidate_repositories[]` so the auditor has something to verify.
    """
    if not isinstance(dossier, dict):
        return []
    standard = dossier.get("affirmative_claims") or dossier.get("falsification_claims")
    if isinstance(standard, list) and standard:
        return [c for c in standard if isinstance(c, dict)]

    out: List[Dict[str, Any]] = []
    for candidate in dossier.get("candidate_repositories") or []:
        if isinstance(candidate, dict):
            out.extend(_verdict_claims(role, candidate))
    return out


def _resolved_policy(
    alpha: Dict[str, Any],
    beta: Dict[str, Any],
    whitelist: Optional[frozenset] = None,
) -> str:
    """Conservative harvest policy when the two dossiers disagree."""
    for side in (alpha, beta):
        policy = str(side.get("harvest_policy") or "").lower()
        risk = str(side.get("license_risk") or "").upper()
        if policy == "clean-room-rebuild-only" or risk in (
            "COPYLEFT_WARNING",
            "PROHIBITIVE",
        ):
            return "clean-room-rebuild-only"
    for side in (alpha, beta):
        if not _is_permissive(side.get("license"), whitelist):
            return "clean-room-rebuild-only"
    return "depend-or-vendor"


class RepoValidator:
    """Ground-truth repo checks via the GitHub API.

    Fail-open: any network/timeout error yields `exists=None` and blocks nothing,
    so an offline or rate-limited run degrades rather than aborting.
    """

    def __init__(
        self,
        token: Optional[str] = None,
        timeout: float = 5.0,
        enabled: bool = True,
    ):
        self.token = token if token is not None else os.environ.get("GITHUB_TOKEN")
        self.timeout = timeout
        self.enabled = enabled
        self._cache: Dict[str, Dict[str, Any]] = {}

    def validate(self, owner_repo: str) -> Dict[str, Any]:
        key = owner_repo.strip().lower()
        if key in self._cache:
            return self._cache[key]
        result = {"exists": None, "license": None, "archived": None}
        if self.enabled and key:
            result = self._fetch(owner_repo)
        self._cache[key] = result
        return result

    def _fetch(self, owner_repo: str) -> Dict[str, Any]:
        request = urllib.request.Request(
            f"https://api.github.com/repos/{owner_repo}",
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "iumbtems-darkharvest-audit",
                **({"Authorization": f"Bearer {self.token}"} if self.token else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
            license_field = data.get("license") or {}
            return {
                "exists": True,
                "license": license_field.get("spdx_id"),
                "archived": bool(data.get("archived")),
            }
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {"exists": False, "license": None, "archived": None}
            return {"exists": None, "license": None, "archived": None}
        except Exception:
            return {"exists": None, "license": None, "archived": None}


def cross_check_repos(
    alpha_dossier: Dict[str, Any],
    beta_dossier: Dict[str, Any],
    validator: Optional[RepoValidator] = None,
    license_whitelist: Any = None,
) -> List[Dict[str, Any]]:
    """Blocking findings for license disagreement and ground-truth failures.

    A dialectic that produces a `depend-or-vendor` verdict on an unstated license
    must not reach a human as `divergence: 0`. Each finding carries the
    conservative resolution. `license_whitelist` (config `license_whitelist`)
    replaces the built-in permissive set when non-empty; absent/default input
    reproduces `PERMISSIVE_LICENSES` exactly.
    """
    whitelist = normalize_license_whitelist(license_whitelist)
    alpha = {
        key: c
        for c in (alpha_dossier.get("candidate_repositories") or [])
        if isinstance(c, dict) and (key := _repo_key(c))
    }
    beta = {
        key: c
        for c in (beta_dossier.get("candidate_repositories") or [])
        if isinstance(c, dict) and (key := _repo_key(c))
    }

    findings: List[Dict[str, Any]] = []
    for key in sorted(set(alpha) | set(beta)):
        a = alpha.get(key)
        b = beta.get(key)
        if a and b:
            alic, blic = (
                _norm_license(a.get("license")),
                _norm_license(b.get("license")),
            )
            if alic != blic:
                findings.append(
                    {
                        "repo": key,
                        "kind": "LICENSE_DISAGREEMENT",
                        "severity": "BLOCKING",
                        "alpha": {
                            "license": a.get("license"),
                            "risk": a.get("license_risk"),
                        },
                        "beta": {
                            "license": b.get("license"),
                            "risk": b.get("license_risk"),
                        },
                        "resolution": _resolved_policy(a, b, whitelist),
                    }
                )
            elif str(a.get("harvest_policy") or "") != str(
                b.get("harvest_policy") or ""
            ):
                findings.append(
                    {
                        "repo": key,
                        "kind": "POLICY_DISAGREEMENT",
                        "severity": "BLOCKING",
                        "alpha": {"policy": a.get("harvest_policy")},
                        "beta": {"policy": b.get("harvest_policy")},
                        "resolution": _resolved_policy(a, b, whitelist),
                    }
                )

        # Ground truth (fail-open when the API is unreachable).
        if validator is not None:
            for side_name, side in (("alpha", a), ("beta", b)):
                if not side:
                    continue
                truth = validator.validate(key)
                if truth.get("exists") is False:
                    findings.append(
                        {
                            "repo": key,
                            "kind": "REPO_UNRESOLVABLE",
                            "severity": "BLOCKING",
                            "source": side_name,
                            "detail": "GitHub API returned 404",
                            "resolution": "reject-citation",
                        }
                    )
                    break
                if truth.get("archived") is True:
                    findings.append(
                        {
                            "repo": key,
                            "kind": "REPO_ARCHIVED",
                            "severity": "WARNING",
                            "detail": "repository is archived",
                        }
                    )
                    break
                truth_license = _norm_license(truth.get("license"))
                if (
                    truth.get("exists")
                    and truth_license
                    and not _is_permissive(truth.get("license"), whitelist)
                    and _is_permissive(side.get("license"), whitelist)
                ):
                    findings.append(
                        {
                            "repo": key,
                            "kind": "LICENSE_CONTRADICTS_GROUND_TRUTH",
                            "severity": "BLOCKING",
                            "source": side_name,
                            "detail": f"dossier says {side.get('license')}, GitHub says {truth.get('license')}",
                            "resolution": "clean-room-rebuild-only",
                        }
                    )
                    break
    return findings
