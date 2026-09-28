#!/usr/bin/env python3
"""
Algorithmic Epistemic Auditor Engine for Epistemic Swarm.
Verifies quote authenticity against content-addressed source cache,
calculates divergence metrics, prunes ungrounded claims, and generates synthesis reports.
"""

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


def _mark_rejected_claims(score_claims: list, *result_lists: list) -> None:
    """Mirror the auditor's UNVERIFIED_REJECTED verdict onto ClaimWitness records."""
    from runner.claim_witness import STATUS_REJECTED

    results_by_id: Dict[str, Any] = {}
    for results in result_lists:
        for r in results:
            results_by_id[r["claim_id"]] = r
    for c in score_claims:
        r = results_by_id.get(c.claim_id)
        if r is not None and r.get("audited_tag") == "UNVERIFIED_REJECTED":
            c.tag = "UNVERIFIED_REJECTED"
            c.status = STATUS_REJECTED


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
    def __init__(self, base_dir: Optional[Path] = None):
        self.base_dir = base_dir or Path(".research")
        self.hasher = SourceHasher(base_dir=self.base_dir)
        self.state_machine = ResearchStateMachine(base_dir=self.base_dir)

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

        self.state_machine.update_scope_status(scope_id, ScopeStatus.AUDITING)

        # 1. Audit Alpha Claims
        alpha_results, alpha_verified, alpha_rejected = self._verify_claims(
            alpha_dossier.get("affirmative_claims", []), constitution=constitution
        )

        # 2. Audit Beta Claims
        beta_results, beta_verified, beta_rejected = self._verify_claims(
            beta_dossier.get("falsification_claims", []), constitution=constitution
        )

        counts = {
            "verified": alpha_verified + beta_verified,
            "rejected": alpha_rejected + beta_rejected,
            "inferred": len(alpha_dossier.get("inferred_implications", [])),
            "hypotheses": len(beta_dossier.get("hypotheses", [])),
            "neg_knowledge": len(alpha_dossier.get("negative_knowledge", []))
            + len(beta_dossier.get("negative_knowledge", [])),
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
                "epistemic_score": epistemic_score,
                "divergence_score": divergence_score,
                "mode": mode,
                "verdict": "CERTIFIED"
                if epistemic_score >= accept_threshold
                else "WARNING_LOW_GROUNDING",
            },
            "alpha_claims_audit": alpha_results,
            "beta_claims_audit": beta_results,
            "divergence_matrix": divergence_matrix,
            "degradation": degradation,
        }

        # Save audit_report.json
        with open(scope_dir / "audit_report.json", "w", encoding="utf-8") as f:
            json.dump(audit_report, f, indent=2)

        # 6. Generate Synthesis Markdown
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

        for claim in claims:
            cid = claim.get("claim_id", "UNKNOWN")
            shash = claim.get("source_hash", "")
            quote = claim.get("verbatim_quote", "")
            statement = claim.get("statement", "")

            if not shash or not quote:
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

            passed, conf, msg = self.hasher.verify_quote(shash, quote)

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
        alpha_claims = alpha_dossier.get("affirmative_claims", [])
        beta_claims = beta_dossier.get("falsification_claims", [])
        critiques = beta_dossier.get("methodological_critiques", [])

        matrix = []
        contradictions = 0

        for crit in critiques:
            target = crit.get("target_assertion", "")
            matrix.append(
                {
                    "tension_type": "METHODOLOGICAL_CHALLENGE",
                    "proponent_claim": target,
                    "adversary_critique": crit.get("critique", ""),
                    "counter_evidence_hash": crit.get("evidence_hash", "NONE"),
                }
            )
            contradictions += 1

        # Calculate divergence
        total_claims = max(1, len(alpha_claims) + len(beta_claims))
        divergence = round(min(1.0, (contradictions * 2) / total_claims), 2)
        return divergence, matrix

    @staticmethod
    def _render_verified_section(alpha_audit: list, beta_audit: list) -> List[str]:
        lines = ["## 1. Verified Empirical Grounding"]
        for claim in alpha_audit:
            if claim["audited_tag"] == "VERIFIED":
                lines.append(
                    f"- `[VERIFIED: {claim['source_hash'][:8]}]` {claim['statement']}"
                )
        for claim in beta_audit:
            if claim["audited_tag"] == "VERIFIED":
                lines.append(
                    f"- `[VERIFIED: {claim['source_hash'][:8]}]` (Counter-Evidence) {claim['statement']}"
                )
        return lines

    @staticmethod
    def _render_tensions_section(matrix: list) -> List[str]:
        lines = ["\n## 2. Dialectic Tensions & Falsification Audit"]
        if matrix:
            for item in matrix:
                lines.append(f"### Tension: {item['tension_type']}")
                lines.append(f"- **Thesis Assertion**: {item['proponent_claim']}")
                lines.append(
                    f"- **Adversarial Critique**: {item['adversary_critique']}"
                )
        else:
            lines.append(
                "No active contradictions identified between primary literature and red-team findings."
            )
        return lines

    @staticmethod
    def _render_rejected_section(claims: list) -> List[str]:
        lines = ["\n## 3. Rejected & Unverified Assertions"]
        rejected = [c for c in claims if c["audited_tag"] == "UNVERIFIED_REJECTED"]
        if rejected:
            for r in rejected:
                lines.append(
                    f'- ⚠️ **PURGED**: "{r["statement"]}" — *Reason: {r["reason"]}*'
                )
        else:
            lines.append(
                "Zero claims rejected. 100% of cited assertions verified against source cache."
            )
        return lines

    @staticmethod
    def _render_negative_knowledge_section(
        alpha: Dict[str, Any], beta: Dict[str, Any]
    ) -> List[str]:
        lines = ["\n## 4. Negative Knowledge Catalog"]
        all_neg = alpha.get("negative_knowledge", []) + beta.get(
            "negative_knowledge", []
        )
        if all_neg:
            for n in all_neg:
                lines.append(f"- `[NEGATIVE_KNOWLEDGE: {n['query']}]` {n['finding']}")
        else:
            lines.append("No negative knowledge declarations logged.")
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
                audit["alpha_claims_audit"] + audit["beta_claims_audit"]
            )
        )
        md.extend(self._render_negative_knowledge_section(alpha, beta))
        return "\n".join(md)
