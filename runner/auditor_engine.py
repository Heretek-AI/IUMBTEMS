#!/usr/bin/env python3
"""
Algorithmic Epistemic Auditor Engine for Epistemic Swarm.
Verifies quote authenticity against content-addressed source cache,
calculates divergence metrics, prunes ungrounded claims, and generates synthesis reports.
"""

import os
import sys
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any, List, Tuple, Optional

# Import SourceHasher from skills/research-cache
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from skills.research_cache.hasher import SourceHasher
from runner.state_machine import ResearchStateMachine, ScopeStatus
from runner.refinement import compute_epistemic_score

from runner.darkharvest_claims import (
    RepoValidator,
    cross_check_repos,
    normalize_dossier_claims,
    normalize_license_whitelist,
    sanitize_self_reported,
)
from runner.claim_witness import normalize_negative_knowledge_rows


def _repo_validation_enabled() -> bool:
    return os.environ.get("IUMBTEMS_REPO_VALIDATE", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def _safe_list_len(value: Any) -> int:
    """Crash-safe len() for untrusted dossier list fields (R1).

    `inferred_implications: None`, `affirmative_claims: "x"`, or any
    non-list shape degrades to 0 instead of `TypeError: len(None)`.
    """
    return len(value) if isinstance(value, list) else 0


def _safe_str(value: Any) -> str:
    """Crash-safe render coercion (R1): None → "", int → str, str → as-is."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return str(value)
    except Exception:
        return ""


def _mark_rejected_claims(score_claims: list, *result_lists: list) -> None:
    """Mirror the auditor's UNVERIFIED_REJECTED verdict onto ClaimWitness records.

    R1: audit rows are untrusted-adjacent (built by `_verify_claims` from
    untrusted dossiers, plus any injected test rows) — non-dict rows and
    missing/non-string claim ids degrade to skip, never KeyError/TypeError
    via strict subscript indexing.
    """
    from runner.claim_witness import STATUS_REJECTED

    results_by_id: Dict[str, Any] = {}
    for results in result_lists:
        if not isinstance(results, (list, tuple)):
            continue
        for r in results:
            if not isinstance(r, dict):
                continue
            cid = r.get("claim_id")
            if not isinstance(cid, str) or not cid:
                continue
            results_by_id[cid] = r
    for c in score_claims or []:
        cid = getattr(c, "claim_id", None)
        if not isinstance(cid, str):
            continue
        r = results_by_id.get(cid)
        if r is not None and r.get("audited_tag") == "UNVERIFIED_REJECTED":
            try:
                c.tag = "UNVERIFIED_REJECTED"
                c.status = STATUS_REJECTED
            except Exception:
                continue


def _compute_scope_epistemic_score(
    constitution: Any,
    alpha_dossier: Dict[str, Any],
    beta_dossier: Dict[str, Any],
    alpha_results: list,
    beta_results: list,
    counts: Dict[str, int],
    mode: Optional[str] = None,
) -> float:
    from runner.refinement import LEGACY_CONSTITUTION

    if mode == "brainstorm":
        # Lateral ideation is scored on well-formed speculation, not web quotes.
        from runner.claim_witness import claims_from_dossier
        from runner.refinement import compute_brainstorm_score_from_claims

        score_claims = claims_from_dossier(alpha_dossier) + claims_from_dossier(
            beta_dossier
        )
        _mark_rejected_claims(score_claims, alpha_results, beta_results)
        epistemic_score, _breakdown = compute_brainstorm_score_from_claims(
            score_claims, constitution=constitution
        )
        return epistemic_score

    if constitution is not LEGACY_CONSTITUTION:
        from runner.claim_witness import claims_from_dossier
        from runner.refinement import compute_epistemic_score_from_claims

        score_claims = claims_from_dossier(alpha_dossier) + claims_from_dossier(
            beta_dossier
        )
        _mark_rejected_claims(score_claims, alpha_results, beta_results)
        epistemic_score, _breakdown = compute_epistemic_score_from_claims(
            score_claims, constitution=constitution
        )
        return epistemic_score

    epistemic_score, _breakdown = compute_epistemic_score(counts)
    return epistemic_score


def _apply_living_dossiers_degradation(
    base_dir: Path,
    scope_id: str,
    alpha_dossier: Dict[str, Any],
    beta_dossier: Dict[str, Any],
) -> Dict[str, Any]:
    degradation = {"events": [], "degraded_scopes": []}
    try:
        from runner.living_dossiers import (
            apply_degradation,
            append_ledger,
            load_retractions,
            queue_requeue,
        )
        from runner.claim_witness import claims_from_dossier

        retractions = load_retractions(base_dir)
        if retractions:
            all_claims = claims_from_dossier(alpha_dossier) + claims_from_dossier(
                beta_dossier
            )
            _degraded, events = apply_degradation(
                all_claims, retractions, scope_id=scope_id
            )
            if events:
                append_ledger(base_dir, events)
                queue_requeue(
                    base_dir, scope_id, reason="claim degradation (retraction event)"
                )
            degradation = {
                "events": [e.to_dict() for e in events],
                "degraded_scopes": [scope_id] if events else [],
            }
    except Exception as exc:  # noqa: BLE001 - degradation must not break audit
        print(f"[auditor] living-dossiers pass skipped: {exc}", file=sys.stderr)
    return degradation


class EpistemicAuditorEngine:
    def __init__(
        self,
        base_dir: Optional[Path] = None,
        repo_validator: Optional[Any] = None,
        min_fuzzy_confidence: float = 0.88,
        license_whitelist: Optional[Any] = None,
    ):
        self.base_dir = base_dir or Path(".research")
        self.hasher = SourceHasher(base_dir=self.base_dir)
        self.state_machine = ResearchStateMachine(base_dir=self.base_dir)
        # Ground-truth repo checks for darkharvest; injectable for tests/offline.
        self.repo_validator = repo_validator
        # Config wiring (`verify.min_fuzzy_confidence`); 0.88 preserves the
        # historical behavior byte-for-byte.
        try:
            self.min_fuzzy_confidence = float(min_fuzzy_confidence)
        except (TypeError, ValueError):
            self.min_fuzzy_confidence = 0.88
        # Darkharvest license policy (`license_whitelist`); None keeps the
        # built-in permissive set.
        self.license_whitelist = normalize_license_whitelist(license_whitelist)

    def audit_scope(
        self,
        scope_id: str,
        constitution: Optional[Any] = None,
        mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Runs the audit pipeline on a scope with ready dossiers.

        `constitution` (Stream G) is an optional Domain Pack. Omitting it
        preserves legacy behavior exactly (flat 1.0 weights, 0.65 threshold,
        no domain/tag rules). Passing one enables tier-weighted scoring and
        the pack's per-claim gates (banned domains, mandatory tags,
        retraction policy). `mode` selects the scoring contract — brainstorm
        credits well-formed speculation rather than web-quote grounding.
        """
        from runner.refinement import LEGACY_CONSTITUTION

        constitution = constitution or LEGACY_CONSTITUTION
        scope_dir = self.state_machine.get_scope_dir(scope_id)
        alpha_file = scope_dir / "alpha_dossier.json"
        beta_file = scope_dir / "beta_dossier.json"

        if not alpha_file.exists() or not beta_file.exists():
            raise FileNotFoundError(f"Both dossiers must exist to audit {scope_id}")

        with open(alpha_file, "r", encoding="utf-8") as f:
            alpha_dossier = json.load(f)
        with open(beta_file, "r", encoding="utf-8") as f:
            beta_dossier = json.load(f)

        # R1: dossiers are untrusted LLM JSON — a top-level list/string/None
        # must degrade to an empty dossier, never `AttributeError` on `.get`.
        if not isinstance(alpha_dossier, dict):
            alpha_dossier = {}
        if not isinstance(beta_dossier, dict):
            beta_dossier = {}

        # Darkharvest dossiers emit `candidate_repositories[]`, not the standard
        # claim keys, and may self-report audit-shaped fields (#5 layers 1 & 3).
        for label, dossier in (("alpha", alpha_dossier), ("beta", beta_dossier)):
            _, renamed = sanitize_self_reported(dossier)
            if renamed:
                print(
                    f"  [Audit] ignored agent self-reported audit fields "
                    f"({label}): {', '.join(sorted(renamed))}"
                )

        self.state_machine.update_scope_status(scope_id, ScopeStatus.AUDITING)

        # 1. Audit Alpha Claims (normalized from either schema)
        alpha_results, alpha_verified, alpha_rejected = self._verify_claims(
            normalize_dossier_claims(alpha_dossier, "alpha"), constitution=constitution
        )

        # 2. Audit Beta Claims
        beta_results, beta_verified, beta_rejected = self._verify_claims(
            normalize_dossier_claims(beta_dossier, "beta"), constitution=constitution
        )

        # 01-nk-hardening (A2): NK ingest normalization. Untrusted dossiers
        # reach the renderer warn-only (research_swarm.py _warn_schema_violations
        # never aborts), so malformed rows (missing/None/non-string
        # query/finding) must be filtered here: scoring and rendering agree on
        # valid `{query, finding}` rows only, and the dropped count is reported.
        alpha_nk_valid, alpha_nk_dropped = normalize_negative_knowledge_rows(
            alpha_dossier.get("negative_knowledge", [])
        )
        beta_nk_valid, beta_nk_dropped = normalize_negative_knowledge_rows(
            beta_dossier.get("negative_knowledge", [])
        )
        dropped_malformed_nk = alpha_nk_dropped + beta_nk_dropped

        counts = {
            "verified": alpha_verified + beta_verified,
            "rejected": alpha_rejected + beta_rejected,
            # R1: None/non-list shapes degrade to 0, never len(None) TypeError.
            "inferred": _safe_list_len(alpha_dossier.get("inferred_implications")),
            "hypotheses": _safe_list_len(beta_dossier.get("hypotheses")),
            "neg_knowledge": len(alpha_nk_valid) + len(beta_nk_valid),
        }

        # 3. Calculate Epistemic Score via the pure refinement function.
        epistemic_score = _compute_scope_epistemic_score(
            constitution,
            alpha_dossier,
            beta_dossier,
            alpha_results,
            beta_results,
            counts,
            mode=mode,
        )
        accept_threshold = constitution.accept_threshold
        if mode == "brainstorm":
            from runner.refinement import BRAINSTORM_MODE_THRESHOLD

            accept_threshold = min(accept_threshold, BRAINSTORM_MODE_THRESHOLD)

        # 3b. Living Dossiers (Stream C): check degradation against retraction events
        degradation = _apply_living_dossiers_degradation(
            self.base_dir, scope_id, alpha_dossier, beta_dossier
        )

        # 4. Calculate Divergence Score
        divergence_score, divergence_matrix = self._compute_divergence(
            alpha_dossier, beta_dossier
        )

        # 4b. Darkharvest: license cross-check + repo ground truth. A dialectic
        # that recommends `depend-or-vendor` on an unstated license must not pass
        # as CERTIFIED (observed: MIT vs NOASSERTION for the same repo, #5).
        harvest_findings: List[Dict[str, Any]] = []
        if mode == "darkharvest":
            validator = self.repo_validator
            if validator is None:
                validator = RepoValidator(enabled=_repo_validation_enabled())
            harvest_findings = cross_check_repos(
                alpha_dossier,
                beta_dossier,
                validator=validator,
                license_whitelist=self.license_whitelist,
            )

        blocking_findings = [
            f for f in harvest_findings if f.get("severity") == "BLOCKING"
        ]
        if blocking_findings:
            verdict = "WARNING_LICENSE_CONFLICT"
        elif epistemic_score >= accept_threshold:
            verdict = "CERTIFIED"
        else:
            verdict = "WARNING_LOW_GROUNDING"

        # 5. Build Audit Report
        audit_report = {
            "auditor": "Epistemic Auditor Engine v1.0",
            "scope_id": scope_id,
            "audited_at": datetime.now(timezone.utc).isoformat(),
            "summary": {
                "total_claims_audited": len(alpha_results) + len(beta_results),
                "verified_passed": counts["verified"],
                "unverified_rejected": counts["rejected"],
                "negative_knowledge_count": counts["neg_knowledge"],
                "dropped_malformed_nk": dropped_malformed_nk,
                "epistemic_score": epistemic_score,
                "divergence_score": divergence_score,
                "mode": mode,
                "blocking_findings": len(blocking_findings),
                "verdict": verdict,
            },
            "alpha_claims_audit": alpha_results,
            "beta_claims_audit": beta_results,
            "divergence_matrix": divergence_matrix,
            "harvest_findings": harvest_findings,
            "degradation": degradation,
        }

        # Save audit_report.json
        with open(scope_dir / "audit_report.json", "w", encoding="utf-8") as f:
            json.dump(audit_report, f, indent=2)

        # 6. Generate Synthesis Markdown. The NK renderer re-applies the
        # same ingest normalization, so the rendered catalog (including the
        # dropped_malformed_nk note) structurally agrees with the scored
        # count above.
        synthesis_md = self._generate_synthesis_markdown(
            scope_id, alpha_dossier, beta_dossier, audit_report
        )
        with open(scope_dir / "scope_synthesis.md", "w", encoding="utf-8") as f:
            f.write(synthesis_md)

        # Mark scope completed
        sm = self.state_machine.load_scope_manifest(scope_id)
        sm["status"] = ScopeStatus.COMPLETE.value
        sm["audit_completed"] = True
        self.state_machine.save_scope_manifest(scope_id, sm)

        return audit_report

    def _verify_claims(
        self,
        claims: List[Dict[str, Any]],
        constitution: Optional[Any] = None,
    ) -> Tuple[List[Dict[str, Any]], int, int]:
        audited_claims = []
        verified_count = 0
        rejected_count = 0

        # Domain Pack gate (Stream G): per-claim rules beyond quote matching
        # (banned domains, mandatory tags, zero-tolerance retraction). Legacy
        # constitution adds no rules, so default behavior is unchanged.
        claim_gate = None
        retracted_hashes = None
        if constitution is not None:
            from runner.claim_witness import normalize_claim
            from runner.living_dossiers import load_retractions
            from runner.refinement import claim_verdict

            retractions = load_retractions(self.base_dir)
            retracted_hashes = {
                h for h, ev in retractions.items() if ev.event == "RETRACTED"
            }
            claim_gate = lambda raw: claim_verdict(  # noqa: E731
                normalize_claim(raw),
                hasher=self.hasher,
                constitution=constitution,
                retracted_hashes=retracted_hashes,
            )

        for claim in claims or []:
            # R1: claims derive from untrusted dossiers — non-dict entries and
            # non-string sides (source_hash int, statement None) degrade to a
            # rejection/empty string, never AttributeError/TypeError.
            if not isinstance(claim, dict):
                audited_claims.append(
                    {
                        "claim_id": "UNKNOWN",
                        "statement": "",
                        "original_tag": "VERIFIED",
                        "audited_tag": "UNVERIFIED_REJECTED",
                        "reason": "Malformed claim entry (non-dict)",
                        "confidence": 0.0,
                    }
                )
                rejected_count += 1
                continue
            _cid = claim.get("claim_id", "UNKNOWN")
            cid = _cid if isinstance(_cid, str) else _safe_str(_cid) or "UNKNOWN"
            shash = claim.get("source_hash", "")
            quote = claim.get("verbatim_quote", "")
            statement = _safe_str(claim.get("statement", ""))

            if (
                not isinstance(shash, str)
                or not isinstance(quote, str)
                or not shash
                or not quote
            ):
                audited_claims.append(
                    {
                        "claim_id": cid,
                        "statement": statement,
                        "original_tag": claim.get("tag", "VERIFIED"),
                        "audited_tag": "UNVERIFIED_REJECTED",
                        "reason": "Missing source_hash or verbatim_quote",
                        "confidence": 0.0,
                    }
                )
                rejected_count += 1
                continue

            passed, conf, msg = self.hasher.verify_quote(
                shash, quote, min_fuzzy_confidence=self.min_fuzzy_confidence
            )

            if passed and claim_gate is not None:
                verdict = claim_gate(claim)
                if verdict["verdict"] == "REJECTED":
                    audited_claims.append(
                        {
                            "claim_id": cid,
                            "statement": statement,
                            "original_tag": claim.get("tag", "VERIFIED"),
                            "audited_tag": "UNVERIFIED_REJECTED",
                            "source_hash": shash,
                            "rejected_quote": quote,
                            "reason": "; ".join(verdict["reasons"]),
                            "confidence": conf,
                        }
                    )
                    rejected_count += 1
                    continue

            if passed:
                audited_claims.append(
                    {
                        "claim_id": cid,
                        "statement": statement,
                        "original_tag": "VERIFIED",
                        "audited_tag": "VERIFIED",
                        "source_hash": shash,
                        "confidence": conf,
                        "verification_message": msg,
                    }
                )
                verified_count += 1
            else:
                audited_claims.append(
                    {
                        "claim_id": cid,
                        "statement": statement,
                        "original_tag": "VERIFIED",
                        "audited_tag": "UNVERIFIED_REJECTED",
                        "source_hash": shash,
                        "rejected_quote": quote,
                        "reason": msg,
                        "confidence": conf,
                    }
                )
                rejected_count += 1

        return audited_claims, verified_count, rejected_count

    def _compute_divergence(
        self, alpha_dossier: Dict[str, Any], beta_dossier: Dict[str, Any]
    ) -> Tuple[float, List[Dict[str, Any]]]:
        # R1: every field here is untrusted LLM output. None/non-list claim
        # sections degrade to []; non-dict/None critiques are skipped (not
        # counted); non-string critique sides coerce to "" — never
        # `crit.get` AttributeError or `len(None)` TypeError.
        _alpha = alpha_dossier if isinstance(alpha_dossier, dict) else {}
        _beta = beta_dossier if isinstance(beta_dossier, dict) else {}
        alpha_claims = _alpha.get("affirmative_claims", [])
        beta_claims = _beta.get("falsification_claims", [])
        critiques = _beta.get("methodological_critiques", [])
        if not isinstance(alpha_claims, list):
            alpha_claims = []
        if not isinstance(beta_claims, list):
            beta_claims = []
        if not isinstance(critiques, list):
            critiques = []

        matrix = []
        contradictions = 0

        for crit in critiques:
            if not isinstance(crit, dict):
                continue
            target = _safe_str(crit.get("target_assertion", ""))
            matrix.append(
                {
                    "tension_type": "METHODOLOGICAL_CHALLENGE",
                    "proponent_claim": target,
                    "adversary_critique": _safe_str(crit.get("critique", "")),
                    "counter_evidence_hash": _safe_str(
                        crit.get("evidence_hash", "NONE")
                    )
                    or "NONE",
                }
            )
            contradictions += 1

        # Calculate divergence
        total_claims = max(1, len(alpha_claims) + len(beta_claims))
        divergence = round(min(1.0, (contradictions * 2) / total_claims), 2)
        return divergence, matrix

    @staticmethod
    def _render_verified_section(alpha_audit: list, beta_audit: list) -> List[str]:
        # A5 sibling sweep + R1: auditor-owned audit rows are still read
        # defensively (.get + isinstance) so a malformed row degrades to a
        # skip instead of a KeyError. R1: `source_hash` int coerces via str
        # (int has no [:8] slice) and `statement` None renders as "" (never
        # the literal "None"). Valid rows render byte-identically.
        lines = ["## 1. Verified Empirical Grounding"]
        for claim in alpha_audit or []:
            if not isinstance(claim, dict):
                continue
            if claim.get("audited_tag") == "VERIFIED":
                lines.append(
                    f"- `[VERIFIED: {_safe_str(claim.get('source_hash'))[:8]}]` {_safe_str(claim.get('statement', ''))}"
                )
        for claim in beta_audit or []:
            if not isinstance(claim, dict):
                continue
            if claim.get("audited_tag") == "VERIFIED":
                lines.append(
                    f"- `[VERIFIED: {_safe_str(claim.get('source_hash'))[:8]}]` (Counter-Evidence) {_safe_str(claim.get('statement', ''))}"
                )
        return lines

    @staticmethod
    def _render_tensions_section(matrix: list) -> List[str]:
        lines = ["\n## 2. Dialectic Tensions & Falsification Audit"]
        if isinstance(matrix, list) and matrix:
            for item in matrix:
                if not isinstance(item, dict):
                    continue
                lines.append(f"### Tension: {_safe_str(item.get('tension_type', ''))}")
                lines.append(
                    f"- **Thesis Assertion**: {_safe_str(item.get('proponent_claim', ''))}"
                )
                lines.append(
                    f"- **Adversarial Critique**: {_safe_str(item.get('adversary_critique', ''))}"
                )
        else:
            lines.append(
                "No active contradictions identified between primary literature and red-team findings."
            )
        return lines

    @staticmethod
    def _render_rejected_section(
        claims: list, summary: Optional[Dict[str, Any]] = None
    ) -> List[str]:
        lines = ["\n## 3. Rejected & Unverified Assertions"]
        rejected = [
            c
            for c in (claims or [])
            if isinstance(c, dict) and c.get("audited_tag") == "UNVERIFIED_REJECTED"
        ]
        if rejected:
            for r in rejected:
                lines.append(
                    f'- ⚠️ **PURGED**: "{_safe_str(r.get("statement", ""))}" — *Reason: {_safe_str(r.get("reason", ""))}*'
                )
            return lines

        # No rejected claims is only "all verified" when the audit actually
        # verified something. Otherwise this is static text contradicting the
        # verdict (observed in darkharvest: 0 verified + "100% verified", #5).
        # R1: summary is auditor-owned but the parameter is untrusted-adjacent
        # (tests/hand-built callers may pass a string/None) — non-dict
        # degrades to {}, never AttributeError on `.get`.
        summary = summary if isinstance(summary, dict) else {}
        verified = summary.get("verified_passed", 0)
        if not isinstance(verified, int):
            verified = 0
        if summary.get("verdict") == "WARNING_LICENSE_CONFLICT":
            lines.append(
                f"No claims rejected, but {summary.get('blocking_findings', 0)} "
                "blocking license/ground-truth finding(s) require review before acting."
            )
        elif verified:
            lines.append(
                f"No claims rejected. {verified} claim(s) verified against the source cache."
            )
        else:
            lines.append(
                "No claims rejected — but **0 claims were verified** (empty source "
                "cache). Treat every assertion above as unverified."
            )
        return lines

    @staticmethod
    def _render_negative_knowledge_section(
        alpha: Dict[str, Any], beta: Dict[str, Any]
    ) -> List[str]:
        # A1 defensive rendering (01-nk-hardening): untrusted NK rows are
        # normalized (.get + validity filter) instead of strictly indexed —
        # a row missing `query`/`finding` (absent, None, or non-string) is
        # dropped and counted, never a KeyError. R3: each side normalizes
        # separately so a single-dict field coerces (never vanishes with
        # dropped=0). R6: the normalizer truncates to NK_MAX_FIELD_LEN, so
        # synthesis is bounded. Valid rows render exactly as before.
        lines = ["\n## 4. Negative Knowledge Catalog"]
        alpha_raw = (
            alpha.get("negative_knowledge", []) if isinstance(alpha, dict) else []
        )
        beta_raw = beta.get("negative_knowledge", []) if isinstance(beta, dict) else []
        alpha_valid, alpha_dropped = normalize_negative_knowledge_rows(alpha_raw)
        beta_valid, beta_dropped = normalize_negative_knowledge_rows(beta_raw)
        valid = alpha_valid + beta_valid
        dropped = alpha_dropped + beta_dropped
        if valid:
            for n in valid:
                if not isinstance(n, dict):
                    continue
                lines.append(
                    f"- `[NEGATIVE_KNOWLEDGE: {_safe_str(n.get('query'))}]` {_safe_str(n.get('finding'))}"
                )
        else:
            lines.append("No negative knowledge declarations logged.")
        if dropped:
            lines.append(
                f"- {dropped} malformed negative-knowledge row(s) dropped "
                f"(dropped_malformed_nk={dropped})."
            )
        return lines

    def _generate_synthesis_markdown(
        self,
        scope_id: str,
        alpha: Dict[str, Any],
        beta: Dict[str, Any],
        audit: Dict[str, Any],
    ) -> str:
        summary = audit["summary"]
        md = [
            f"# Epistemic Synthesis: Scope {scope_id}\n",
            f"**Audit Verdict**: `{summary['verdict']}` | **Epistemic Score**: `{summary['epistemic_score']}/1.0` | **Divergence Index**: `{summary['divergence_score']}`\n",
        ]
        md.extend(
            self._render_verified_section(
                audit["alpha_claims_audit"], audit["beta_claims_audit"]
            )
        )
        md.extend(self._render_tensions_section(audit.get("divergence_matrix", [])))
        md.extend(
            self._render_rejected_section(
                audit["alpha_claims_audit"] + audit["beta_claims_audit"],
                summary,
            )
        )
        md.extend(self._render_negative_knowledge_section(alpha, beta))
        md.extend(self._render_harvest_findings(audit.get("harvest_findings", [])))
        return "\n".join(md)

    @staticmethod
    def _render_harvest_findings(findings: list) -> List[str]:
        if not isinstance(findings, list) or not findings:
            return []
        lines = ["\n## 5. Harvest Safety Findings"]
        for f in findings:
            if not isinstance(f, dict):
                continue
            icon = "⛔" if f.get("severity") == "BLOCKING" else "⚠️"
            detail = _safe_str(f.get("detail") or f.get("kind", ""))
            resolution = f.get("resolution")
            resolution_s = _safe_str(resolution) if resolution else ""
            suffix = f" → **{resolution_s}**" if resolution_s else ""
            lines.append(
                f"- {icon} `{_safe_str(f.get('repo', '?')) or '?'}` — {_safe_str(f.get('kind', ''))}: {detail}{suffix}"
            )
        return lines
