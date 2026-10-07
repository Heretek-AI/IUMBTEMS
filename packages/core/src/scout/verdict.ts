// The scout's final verdicts are computed here, not by the agent: an "adopt"
// survives only through darkharvest's license policy (verified, whitelisted,
// permissive; checkVerdict), severe advisories are flagged, and candidates are
// ranked by verdict class, then by their evidence (rankDossiers).
import { buildDossier } from "../claims/dossier.ts"
import { rankDossiers } from "../claims/rank.ts"
import { checkVerdict } from "../harvest/matrix.ts"
import type { Claim, Dossier } from "../schema/claims.ts"
import type { HarvestProfile } from "../schema/harvest.ts"
import type { ScoutAdvisory, ScoutAssessment, ScoutPlan, ScoutProposal, ScoutVerdict } from "../schema/scout.ts"

const CLASS: Record<ScoutProposal, number> = { adopt: 0, "clean-room": 1, reject: 2 }
const SEVERE = new Set(["HIGH", "CRITICAL"])

export function advisoryWarnings(advisories: readonly ScoutAdvisory[]): string[] {
  return advisories
    .filter((advisory) => SEVERE.has((advisory.severity ?? "").toUpperCase()))
    .map((advisory) =>
      advisory.fixed.length
        ? `${advisory.id} (${advisory.severity}): adopt only at ${advisory.fixed.join(" or ")} or later`
        : `${advisory.id} (${advisory.severity}) has no fixed release`,
    )
}

export interface CandidateEvidence {
  readonly id: string
  readonly name: string
  readonly profile: HarvestProfile
  readonly assessment: ScoutAssessment
  readonly advisories: readonly ScoutAdvisory[]
  /** The assessment's claims plus the advisory claims, witnessed. */
  readonly claims: readonly Claim[]
}

/** Final verdicts and ranks, plus each candidate's dossier (for the combined dossier and the report). */
export function scoutVerdicts(
  plan: ScoutPlan,
  candidates: readonly CandidateEvidence[],
): { verdicts: ScoutVerdict[]; dossiers: Map<string, Dossier> } {
  const dossiers = new Map(
    candidates.map((candidate) => [
      candidate.id,
      buildDossier({ mode: "oss-scout", subject: candidate.id, claims: candidate.claims }),
    ]),
  )
  const evidenceOrder = new Map(
    rankDossiers([...dossiers.values()]).map((item, index) => [item.dossier.subject, index]),
  )
  const verdicts = candidates.map((candidate) => {
    const { proposal } = candidate.assessment
    const warnings = advisoryWarnings(candidate.advisories)
    if (candidate.assessment.maintenance === "abandoned" && proposal === "adopt")
      warnings.push("maintenance is abandoned: adopting means owning it")
    let verdict: ScoutProposal = proposal
    let downgraded: string | undefined
    let attribution: string | undefined
    if (proposal === "adopt") {
      const policy = checkVerdict("depend", candidate.profile.license, plan.whitelist)
      if (policy.verdict === "depend") attribution = policy.attribution
      else {
        verdict = "clean-room"
        downgraded = policy.downgraded
      }
    }
    return {
      candidate: candidate.id,
      name: candidate.name,
      license: candidate.profile.license,
      proposal,
      verdict,
      ...(downgraded ? { downgraded } : {}),
      ...(attribution ? { attribution } : {}),
      warnings,
      rank: 0,
    }
  })
  verdicts.sort(
    (a, b) =>
      CLASS[a.verdict] - CLASS[b.verdict] ||
      (evidenceOrder.get(a.candidate) ?? 0) - (evidenceOrder.get(b.candidate) ?? 0) ||
      (a.candidate < b.candidate ? -1 : 1),
  )
  verdicts.forEach((verdict, index) => {
    verdict.rank = index + 1
  })
  return { verdicts, dossiers }
}
