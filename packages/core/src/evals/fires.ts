// Deterministic graders for the fire suites (ported in spirit from the 0.7
// evals/*-fires cases, whose rubric graders needed a model). A fire is a trap
// with a known answer: planted defects the audit pair must catch at the right
// lines, and license fixtures whose scout verdicts core must get right. The
// same graders run on scripted transcripts in CI and on real-model runs nightly.
import { readAuditRecords } from "../codeaudit/store.ts"
import { readHarvestResult } from "../harvest/store.ts"
import type { AuditRecord } from "../schema/codeaudit.ts"
import type { HarvestMatrix } from "../schema/harvest.ts"
import type { ScoutResult } from "../schema/scout.ts"
import { readScoutResult } from "../scout/store.ts"

export interface PlantedDefect {
  readonly id: string
  readonly file: string
  readonly lines: readonly [number, number]
  /** Any of these CWE ids counts. */
  readonly cwe: readonly string[]
}

export interface FireGrade {
  readonly pass: boolean
  readonly caught: readonly string[]
  readonly failures: readonly string[]
}

const overlaps = (a: readonly [number, number], b: readonly [number, number]) => a[0] <= b[1] && b[0] <= a[1]
/** Lines of context a finding may cite around a plant; a wider range is a guess, not a catch. */
const PLANT_SLACK = 3
const near = (finding: readonly [number, number], plant: readonly [number, number]) =>
  overlaps(finding, plant) && finding[0] >= plant[0] - PLANT_SLACK && finding[1] <= plant[1] + PLANT_SLACK

/**
 * Every plant must be caught by a vulnerability finding in its file, with one
 * of its CWEs, citing the plant's lines (within PLANT_SLACK lines of context).
 */
export function gradeAuditFire(records: readonly AuditRecord[], plants: readonly PlantedDefect[]): FireGrade {
  const findings = records.flatMap((record) => record.findings).filter((finding) => finding.kind === "vulnerability")
  const caught: string[] = []
  const failures: string[] = []
  for (const plant of plants) {
    const hit = findings.find(
      (finding) =>
        finding.file.replace(/^\.\//, "") === plant.file &&
        finding.cwe !== undefined &&
        plant.cwe.includes(finding.cwe) &&
        near(finding.lines, plant.lines),
    )
    if (hit) caught.push(plant.id)
    else
      failures.push(
        `missed ${plant.id}: ${plant.file}#L${plant.lines[0]}-L${plant.lines[1]} (${plant.cwe.join(" or ")})`,
      )
  }
  if (!records.some((record) => record.verdict === "fail")) failures.push("no auditor failed the audit")
  return { pass: failures.length === 0, caught, failures }
}

/**
 * Exactly the expected candidates, one verdict each, and every final verdict
 * must match; a proposal the policy rejected must say why.
 */
export function gradeScoutFire(
  result: ScoutResult,
  expected: ReadonlyArray<{ name: string; verdict: string }>,
): FireGrade {
  const caught: string[] = []
  const failures: string[] = []
  const matches = (verdict: ScoutResult["verdicts"][number], name: string) =>
    verdict.name === name || verdict.candidate === name
  // One row satisfies at most one expected candidate: a row whose name matches
  // one expectation and whose candidate matches another must not cover both.
  const claimed = new Map<number, string>()
  result.verdicts.forEach((verdict, index) => {
    const wants = expected.filter((want) => matches(verdict, want.name)).map((want) => want.name)
    if (wants.length > 1) failures.push(`one verdict row matches several expected candidates: ${wants.join(", ")}`)
    else if (wants.length === 1) claimed.set(index, wants[0]!)
  })
  for (const want of expected) {
    const rows = result.verdicts.filter((_, index) => claimed.get(index) === want.name)
    const got = rows[0]
    if (rows.length > 1) failures.push(`${rows.length} verdicts for ${want.name}`)
    else if (!got) failures.push(`no verdict for ${want.name}`)
    else if (got.verdict !== want.verdict) failures.push(`${want.name}: ${got.verdict}, expected ${want.verdict}`)
    else if (got.proposal !== got.verdict && !got.downgraded) failures.push(`${want.name}: downgraded without a reason`)
    else caught.push(want.name)
  }
  for (const verdict of result.verdicts)
    if (!expected.some((want) => matches(verdict, want.name))) failures.push(`unexpected verdict for ${verdict.name}`)
  return { pass: failures.length === 0, caught, failures }
}

/** Every expected candidate's cells must carry the expected verdict (a harvest fire is one feature row). */
export function gradeHarvestFire(
  matrix: HarvestMatrix,
  expected: ReadonlyArray<{ candidate: string; verdict: string }>,
): FireGrade {
  const caught: string[] = []
  const failures: string[] = []
  for (const want of expected) {
    const cells = matrix.rows.flatMap((row) => row.cells).filter((cell) => cell.candidate === want.candidate)
    if (!cells.length) failures.push(`no matrix cell for ${want.candidate}`)
    else {
      const wrong = cells.filter((cell) => cell.verdict !== want.verdict)
      if (wrong.length)
        failures.push(`${want.candidate}: ${wrong.map((cell) => cell.verdict).join(", ")}, expected ${want.verdict}`)
      else caught.push(want.candidate)
    }
  }
  const extra = [
    ...new Set(
      matrix.rows
        .flatMap((row) => row.cells)
        .map((cell) => cell.candidate)
        .filter((candidate) => !expected.some((want) => want.candidate === candidate)),
    ),
  ]
  for (const candidate of extra) failures.push(`unexpected matrix cell for ${candidate}`)
  return { pass: failures.length === 0, caught, failures }
}

/** How an eval case is graded from the workspace after its turn. */
export type FireSpec =
  | { readonly kind: "audit"; readonly audit: string; readonly plants: readonly PlantedDefect[] }
  | { readonly kind: "scout"; readonly expected: ReadonlyArray<{ name: string; verdict: string }> }
  | { readonly kind: "harvest"; readonly expected: ReadonlyArray<{ candidate: string; verdict: string }> }

/** Grade a fire from what the seats left in the workspace (records, scout result, harvest result). */
export async function gradeFireCase(spec: FireSpec, root: string): Promise<FireGrade> {
  if (spec.kind === "audit") return gradeAuditFire(await readAuditRecords(root, spec.audit), spec.plants)
  if (spec.kind === "harvest") {
    const result = await readHarvestResult(root).catch(() => undefined)
    if (!result)
      return { pass: false, caught: [], failures: ["the harvest never completed (no .factory/harvest/harvest.json)"] }
    return gradeHarvestFire(result.matrix, spec.expected)
  }
  const result = await readScoutResult(root).catch(() => undefined)
  if (!result)
    return { pass: false, caught: [], failures: ["the scout never completed (no .factory/scout/scout.json)"] }
  return gradeScoutFire(result, spec.expected)
}
