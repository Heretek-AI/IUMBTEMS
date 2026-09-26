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

class EpistemicAuditorEngine:
    def __init__(self, base_dir: Optional[Path] = None):
        self.base_dir = base_dir or Path(".research")
        self.hasher = SourceHasher(base_dir=self.base_dir)
        self.state_machine = ResearchStateMachine(base_dir=self.base_dir)

    def audit_scope(self, scope_id: str) -> Dict[str, Any]:
        """Runs the audit pipeline on a scope with ready dossiers."""
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
            alpha_dossier.get("affirmative_claims", [])
        )

        # 2. Audit Beta Claims
        beta_results, beta_verified, beta_rejected = self._verify_claims(
            beta_dossier.get("falsification_claims", [])
        )

        total_verified = alpha_verified + beta_verified
        total_rejected = alpha_rejected + beta_rejected
        
        # Negative knowledge counts
        neg_knowledge_alpha = len(alpha_dossier.get("negative_knowledge", []))
        neg_knowledge_beta = len(beta_dossier.get("negative_knowledge", []))
        total_neg_knowledge = neg_knowledge_alpha + neg_knowledge_beta

        total_inferred = len(alpha_dossier.get("inferred_implications", []))
        total_hypotheses = len(beta_dossier.get("hypotheses", []))

        # 3. Calculate Epistemic Score
        total_assertions = max(1, total_verified + total_inferred + total_hypotheses + total_rejected)
        raw_score = (1.0 * total_verified + 0.5 * total_neg_knowledge - 2.5 * total_rejected) / total_assertions
        epistemic_score = max(0.0, min(1.0, round(raw_score, 3)))

        # 4. Calculate Divergence Score
        divergence_score, divergence_matrix = self._compute_divergence(alpha_dossier, beta_dossier)

        # 5. Build Audit Report
        audit_report = {
            "auditor": "Epistemic Auditor Engine v1.0",
            "scope_id": scope_id,
            "audited_at": datetime.now(timezone.utc).isoformat(),
            "summary": {
                "total_claims_audited": len(alpha_results) + len(beta_results),
                "verified_passed": total_verified,
                "unverified_rejected": total_rejected,
                "negative_knowledge_count": total_neg_knowledge,
                "epistemic_score": epistemic_score,
                "divergence_score": divergence_score,
                "verdict": "CERTIFIED" if epistemic_score >= 0.65 else "WARNING_LOW_GROUNDING"
            },
            "alpha_claims_audit": alpha_results,
            "beta_claims_audit": beta_results,
            "divergence_matrix": divergence_matrix
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

    def _verify_claims(self, claims: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int, int]:
        audited_claims = []
        verified_count = 0
        rejected_count = 0

        for claim in claims:
            cid = claim.get("claim_id", "UNKNOWN")
            shash = claim.get("source_hash", "")
            quote = claim.get("verbatim_quote", "")
            statement = claim.get("statement", "")

            if not shash or not quote:
                audited_claims.append({
                    "claim_id": cid,
                    "statement": statement,
                    "original_tag": claim.get("tag", "VERIFIED"),
                    "audited_tag": "UNVERIFIED_REJECTED",
                    "reason": "Missing source_hash or verbatim_quote",
                    "confidence": 0.0
                })
                rejected_count += 1
                continue

            passed, conf, msg = self.hasher.verify_quote(shash, quote)
            if passed:
                audited_claims.append({
                    "claim_id": cid,
                    "statement": statement,
                    "original_tag": "VERIFIED",
                    "audited_tag": "VERIFIED",
                    "source_hash": shash,
                    "confidence": conf,
                    "verification_message": msg
                })
                verified_count += 1
            else:
                audited_claims.append({
                    "claim_id": cid,
                    "statement": statement,
                    "original_tag": "VERIFIED",
                    "audited_tag": "UNVERIFIED_REJECTED",
                    "source_hash": shash,
                    "rejected_quote": quote,
                    "reason": msg,
                    "confidence": conf
                })
                rejected_count += 1

        return audited_claims, verified_count, rejected_count

    def _compute_divergence(self, alpha_dossier: Dict[str, Any], 
                            beta_dossier: Dict[str, Any]) -> Tuple[float, List[Dict[str, Any]]]:
        alpha_claims = alpha_dossier.get("affirmative_claims", [])
        beta_claims = beta_dossier.get("falsification_claims", [])
        critiques = beta_dossier.get("methodological_critiques", [])

        matrix = []
        contradictions = 0

        for crit in critiques:
            target = crit.get("target_assertion", "")
            matrix.append({
                "tension_type": "METHODOLOGICAL_CHALLENGE",
                "proponent_claim": target,
                "adversary_critique": crit.get("critique", ""),
                "counter_evidence_hash": crit.get("evidence_hash", "NONE")
            })
            contradictions += 1

        # Calculate divergence
        total_claims = max(1, len(alpha_claims) + len(beta_claims))
        divergence = round(min(1.0, (contradictions * 2) / total_claims), 2)
        return divergence, matrix

    def _generate_synthesis_markdown(self, scope_id: str, alpha: Dict[str, Any], 
                                     beta: Dict[str, Any], audit: Dict[str, Any]) -> str:
        summary = audit["summary"]
        md = []
        md.append(f"# Epistemic Synthesis: Scope {scope_id}\n")
        md.append(f"**Audit Verdict**: `{summary['verdict']}` | **Epistemic Score**: `{summary['epistemic_score']}/1.0` | **Divergence Index**: `{summary['divergence_score']}`\n")
        
        md.append("## 1. Verified Empirical Grounding")
        for claim in audit["alpha_claims_audit"]:
            if claim["audited_tag"] == "VERIFIED":
                md.append(f"- `[VERIFIED: {claim['source_hash'][:8]}]` {claim['statement']}")
        for claim in audit["beta_claims_audit"]:
            if claim["audited_tag"] == "VERIFIED":
                md.append(f"- `[VERIFIED: {claim['source_hash'][:8]}]` (Counter-Evidence) {claim['statement']}")
        
        md.append("\n## 2. Dialectic Tensions & Falsification Audit")
        if audit["divergence_matrix"]:
            for item in audit["divergence_matrix"]:
                md.append(f"### Tension: {item['tension_type']}")
                md.append(f"- **Thesis Assertion**: {item['proponent_claim']}")
                md.append(f"- **Adversarial Critique**: {item['adversary_critique']}")
        else:
            md.append("No active contradictions identified between primary literature and red-team findings.")

        md.append("\n## 3. Rejected & Unverified Assertions")
        rejected = [c for c in audit["alpha_claims_audit"] + audit["beta_claims_audit"] if c["audited_tag"] == "UNVERIFIED_REJECTED"]
        if rejected:
            for r in rejected:
                md.append(f"- ⚠️ **PURGED**: \"{r['statement']}\" — *Reason: {r['reason']}*")
        else:
            md.append("Zero claims rejected. 100% of cited assertions verified against source cache.")

        md.append("\n## 4. Negative Knowledge Catalog")
        all_neg = alpha.get("negative_knowledge", []) + beta.get("negative_knowledge", [])
        if all_neg:
            for n in all_neg:
                md.append(f"- `[NEGATIVE_KNOWLEDGE: {n['query']}]` {n['finding']}")
        else:
            md.append("No negative knowledge declarations logged.")

        return "\n".join(md)
