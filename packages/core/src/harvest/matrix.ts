// The feature matrix and the license policy behind it. Verdicts are not taken
// from the model: depend/vendor requires a text-verified, whitelisted license,
// and anything else is downgraded to clean-room with the reason recorded. The
// engine also supplies the SPDX attribution line for allowed depend/vendor.
import type {
  HarvestCell,
  HarvestMatrix,
  HarvestProfile,
  HarvestRow,
  HarvestVerdict,
  LicenseFinding,
} from "../schema/harvest.ts"
import { HARVEST_VERSION } from "../schema/harvest.ts"

export interface VerdictCheck {
  readonly verdict: HarvestVerdict
  readonly attribution?: string
  readonly downgraded?: string
}

export function attributionOf(license: LicenseFinding): string {
  const bytes = license.sha256 ? `, sha256:${license.sha256.slice(0, 12)}…` : ""
  return `SPDX:${license.spdx} (${license.file ?? license.source}${bytes})`
}

/** Enforce the license policy for one proposed verdict. */
export function checkVerdict(
  proposed: HarvestVerdict,
  license: LicenseFinding,
  whitelist: readonly string[],
): VerdictCheck {
  if (proposed === "skip" || proposed === "clean-room") return { verdict: proposed }
  if (!license.verified)
    return {
      verdict: "clean-room",
      downgraded: `license "${license.spdx}" is unverified (${license.source}); depend/vendor need licensed bytes`,
    }
  if (license.family === "copyleft" || license.family === "weak-copyleft")
    return { verdict: "clean-room", downgraded: `license ${license.spdx} is ${license.family}; clean-room only` }
  if (license.family === "unknown")
    return { verdict: "clean-room", downgraded: `license ${license.spdx} is unknown; clean-room only` }
  if (!whitelist.includes(license.spdx))
    return { verdict: "clean-room", downgraded: `license ${license.spdx} is not on the license whitelist` }
  return { verdict: proposed, attribution: attributionOf(license) }
}

export interface MatrixBuild {
  readonly matrix: HarvestMatrix
  readonly downgrades: Array<{
    candidate: string
    feature: string
    from: HarvestVerdict
    to: HarvestVerdict
    reason: string
  }>
}

/** Apply the policy to every proposed cell and freeze the matrix. */
export function buildMatrix(
  candidates: readonly string[],
  profiles: ReadonlyMap<string, HarvestProfile>,
  rows: readonly HarvestRow[],
  whitelist: readonly string[],
  now = new Date(),
): MatrixBuild {
  const downgrades: MatrixBuild["downgrades"] = []
  const outRows = rows.map((row) => ({
    feature: row.feature,
    cells: row.cells.map((cell): HarvestCell => {
      const profile = profiles.get(cell.candidate)
      if (!profile)
        return { ...cell, verdict: "skip", downgraded: `candidate "${cell.candidate}" was not scanned; skipped` }
      const checked = checkVerdict(cell.verdict, profile.license, whitelist)
      if (checked.downgraded)
        downgrades.push({
          candidate: cell.candidate,
          feature: row.feature,
          from: cell.verdict,
          to: checked.verdict,
          reason: checked.downgraded,
        })
      return {
        candidate: cell.candidate,
        verdict: checked.verdict,
        ...(cell.evidence ? { evidence: cell.evidence } : {}),
        ...(checked.attribution ? { attribution: checked.attribution } : {}),
        ...(checked.downgraded ? { downgraded: checked.downgraded } : {}),
      }
    }),
  }))
  return {
    matrix: {
      version: HARVEST_VERSION,
      candidates: [...candidates],
      rows: outRows,
      licensePolicy: { whitelist: [...whitelist], failClosed: true },
      builtAt: now.toISOString(),
    },
    downgrades,
  }
}

export interface HarvestRender {
  readonly report: string
  readonly vendorPlan: string
  readonly cleanRoom: Array<{ candidate: string; feature: string; content: string }>
}

/** Render the human digest, the vendor import plan and the clean-room specs. */
export function renderHarvest(
  objective: string,
  profiles: readonly HarvestProfile[],
  matrix: HarvestMatrix,
): HarvestRender {
  const profile = new Map(profiles.map((item) => [item.id, item]))
  const report: string[] = [`# Darkharvest: ${objective}`, "", "## Candidates", ""]
  for (const item of profiles) {
    report.push(
      `### ${item.id} — ${item.name}`,
      "",
      `- Origin: ${item.origin ?? "?"}${item.commit ? ` @ ${item.commit.slice(0, 10)}` : ""}`,
      `- License: **${item.license.spdx}** (${item.license.family}, ${item.license.source}, ${item.license.verified ? "verified" : "UNVERIFIED"})${item.license.file ? ` — ${item.license.file}` : ""}`,
      `- Size: ${item.size.files} files, ~${item.size.tokens} tokens · languages: ${
        Object.entries(item.languages)
          .map(([id, count]) => `${id}(${count})`)
          .join(", ") || "n/a"
      }`,
      `- Dependencies: ${item.dependencies.runtime.length} runtime, ${item.dependencies.dev.length} dev`,
      ...item.warnings.map((warning) => `- ⚠ ${warning}`),
      "",
    )
  }
  report.push(
    "## Feature matrix",
    "",
    `| feature | ${matrix.candidates.join(" | ")} |`,
    `| --- |${matrix.candidates.map(() => " --- |").join("")}`,
  )
  for (const row of matrix.rows) {
    const byCandidate = new Map(row.cells.map((cell) => [cell.candidate, cell]))
    report.push(
      `| ${row.feature} | ${matrix.candidates.map((candidate) => byCandidate.get(candidate)?.verdict ?? "—").join(" | ")} |`,
    )
  }
  const downgrades = matrix.rows.flatMap((row) => row.cells.filter((cell) => cell.downgraded))
  if (downgrades.length) {
    report.push("", "## Policy downgrades (fail-closed)", "")
    for (const cell of downgrades) report.push(`- ${cell.candidate}: "${cell.downgraded}" → ${cell.verdict}`)
  }
  report.push("", "## Verdict detail", "")
  for (const row of matrix.rows)
    for (const cell of row.cells.filter((item) => item.verdict !== "skip"))
      report.push(
        `- **${row.feature}** · ${cell.candidate} → ${cell.verdict}${cell.attribution ? ` · ${cell.attribution}` : ""}${cell.evidence ? `\n  ${cell.evidence}` : ""}`,
      )

  const vendorCells = matrix.rows.flatMap((row) =>
    row.cells.filter((cell) => cell.verdict === "vendor" || cell.verdict === "depend"),
  )
  const vendorPlan: string[] = [`# Vendor import plan: ${objective}`, ""]
  if (!vendorCells.length) vendorPlan.push("Nothing to depend on or vendor under the current license policy.", "")
  for (const cell of vendorCells) {
    const feature = matrix.rows.find((row) => row.cells.includes(cell))!.feature
    const item = profile.get(cell.candidate)!
    vendorPlan.push(
      `## ${cell.candidate} — ${feature} (${cell.verdict})`,
      "",
      `- License: ${cell.attribution ?? attributionOf(item.license)}`,
      `- Keep the upstream LICENSE file and this attribution in the vendored copy.`,
      `- Record the import in the phase DEPENDENCIES.md.`,
      "",
    )
  }

  const cleanRoom = matrix.rows.flatMap((row) =>
    row.cells
      .filter((cell) => cell.verdict === "clean-room")
      .map((cell) => {
        const item = profile.get(cell.candidate)!
        const content = [
          `# Clean-room rebuild: ${cell.candidate} — ${row.feature}`,
          "",
          `Do not read or copy ${cell.candidate}'s source while writing this. Write the spec from its behaviour and this file alone.`,
          "",
          `- Upstream: ${item.origin ?? "?"} · license ${item.license.spdx} (${cell.downgraded ?? "policy"})`,
          `- Language mix: ${Object.keys(item.languages).join(", ") || "unknown"}`,
          `- What to rebuild: ${cell.evidence ?? row.feature}`,
          `- Proof of independence: the implementation must be writable from this spec plus public behaviour tests, not from upstream code.`,
          "",
        ].join("\n")
        return { candidate: cell.candidate, feature: row.feature, content }
      }),
  )
  return { report: report.join("\n"), vendorPlan: vendorPlan.join("\n"), cleanRoom }
}
