// REPORT.md for a finished scout: the competitive matrix, the risks the
// red-team found, clean-room blueprints, and the cited claims. Deterministic.
import type { HarvestProfile } from "../schema/harvest.ts"
import type { ScoutAdvisoryQuery, ScoutAssessment, ScoutPlan, ScoutResult } from "../schema/scout.ts"

/** What the report says about one candidate's advisories step (#257). */
export interface AdvisoryCheck {
  readonly query?: ScoutAdvisoryQuery | undefined
  readonly skipped: boolean
  readonly count: number
}

const cell = (value: unknown) => String(value ?? "—").replaceAll("|", "\\|")

export function renderScoutReport(
  plan: ScoutPlan,
  result: ScoutResult,
  profiles: ReadonlyMap<string, HarvestProfile>,
  assessments: ReadonlyMap<string, ScoutAssessment>,
  checks: ReadonlyMap<string, AdvisoryCheck>,
): string {
  const lines = [
    `# Scout: ${plan.objective}`,
    "",
    plan.posture
      ? `Our posture: ${plan.posture} · adoptable licenses: ${plan.whitelist.join(", ") || "none"}`
      : `Adoptable licenses: ${plan.whitelist.join(", ") || "none"}`,
    "",
    "Verdicts are computed by Epistemic Swarm from the verified license text, not taken from the agent. Adoption is a human decision.",
    "",
    "## Competitive matrix",
    "",
    "| Rank | Candidate | License | Stars | Last release | Maintenance | Direct deps | Size | Severe advisories | Proposal | Verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ]
  for (const verdict of result.verdicts) {
    const profile = profiles.get(verdict.candidate)
    const assessment = assessments.get(verdict.candidate)
    lines.push(
      `| ${verdict.rank} | ${cell(verdict.name)} | ${cell(verdict.license.spdx)}${verdict.license.verified ? "" : " (unverified)"} | ${cell(assessment?.stars)} | ${cell(assessment?.lastRelease)} | ${cell(assessment?.maintenance)} | ${cell(profile?.dependencies.runtime.length)} | ${profile ? `${profile.size.files} files` : "—"} | ${verdict.warnings.filter((warning) => /\((HIGH|CRITICAL)\)/.test(warning)).length} | ${verdict.proposal} | **${verdict.verdict}** |`,
    )
  }
  lines.push("", "## Risks", "")
  for (const verdict of result.verdicts) {
    const notes = [...(verdict.downgraded ? [`license: ${verdict.downgraded}`] : []), ...verdict.warnings]
    lines.push(
      `- **${verdict.name}**: ${notes.length ? notes.join("; ") : "none found"}${verdict.attribution ? ` · attribution ${verdict.attribution}` : ""}`,
    )
  }
  // What the advisories step actually checked (#257): the queried
  // coordinates, or the explicit skip. A clean adopt with no line here is
  // impossible — complete refuses the silent skip.
  lines.push("", "## Advisory checks", "")
  for (const verdict of result.verdicts) {
    const check = checks.get(verdict.candidate)
    if (!check || check.skipped)
      lines.push(`- **${verdict.name}**: advisories not queried; the assessment records explicit NEGATIVE_KNOWLEDGE.`)
    else {
      const at = check.query?.version ? `@${check.query.version}` : ""
      lines.push(
        `- **${verdict.name}**: OSV ${check.query?.ecosystem}:${check.query?.package}${at} checked, ${check.count} ${check.count === 1 ? "advisory" : "advisories"} cited.`,
      )
    }
  }
  const blueprints = result.verdicts.filter(
    (verdict) => verdict.verdict === "clean-room" && assessments.get(verdict.candidate)?.blueprint,
  )
  if (blueprints.length) {
    lines.push("", "## Clean-room blueprints", "")
    for (const verdict of blueprints)
      lines.push(`### ${verdict.name}`, "", assessments.get(verdict.candidate)!.blueprint!, "")
  }
  lines.push("", "## Assessments", "")
  for (const verdict of result.verdicts) {
    const assessment = assessments.get(verdict.candidate)
    if (!assessment) continue
    lines.push(`### ${verdict.name}`, "", assessment.rationale, "")
    for (const claim of assessment.claims) {
      const tag =
        claim.tag === "VERIFIED" && claim.source
          ? `[VERIFIED: sha256:${claim.source.sha256} "${claim.source.quote}"]`
          : `[${claim.tag}: ${claim.reasoning ?? claim.falsification ?? claim.query ?? claim.statement}]`
      lines.push(`- ${claim.statement} ${tag}`)
    }
    if (assessment.claims.length) lines.push("")
  }
  return `${lines.join("\n").trimEnd()}\n`
}
