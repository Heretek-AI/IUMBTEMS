// Reading, writing and rendering the brainstorm artifacts under
// .factory/brainstorm/: plan.json, ideas.json, scores.json, brainstorm.json
// and the human-readable BRAINSTORM.md.
import { readdir, rm, stat } from "node:fs/promises"
import { factoryLayout } from "../layout.ts"
import {
  type BrainstormIdea,
  BrainstormIdeaSchema,
  type BrainstormPlan,
  BrainstormPlanSchema,
  type BrainstormResult,
  BrainstormResultSchema,
  type BrainstormScore,
  BrainstormScoreSchema,
} from "../schema/brainstorm.ts"
import { atomicWrite, readJson, writeJson } from "../util/fs.ts"

export function brainstormPaths(root: string) {
  const layout = factoryLayout(root)
  return {
    dir: layout.brainstorm,
    plan: layout.brainstormPlan,
    ideas: layout.brainstormIdeas,
    scores: layout.brainstormScores,
    result: layout.brainstormResult,
    report: layout.brainstormReport,
  }
}

/** The human's /brainstorm always runs here; callers pass their own run id. */
export const DEFAULT_RUN = "default" as const

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Validate a run id (tool input): kebab-case, so it is always a safe path segment. */
export function parseRunId(input: unknown): string {
  if (input === undefined) return DEFAULT_RUN
  const run = String(input).trim() || DEFAULT_RUN
  if (!RUN_ID.test(run)) throw new Error(`invalid brainstorm run id "${run}": use lowercase letters, digits and dashes`)
  return run
}

/** Artifact paths for one run under .factory/brainstorm/runs/<runId>/ (#108). */
export function brainstormRunPaths(root: string, runId: string = DEFAULT_RUN) {
  const dir = factoryLayout(root).brainstormRun(runId)
  return {
    dir,
    plan: factoryLayout(root).brainstormRunPlan(runId),
    ideas: factoryLayout(root).brainstormRunIdeas(runId),
    scores: factoryLayout(root).brainstormRunScores(runId),
    result: factoryLayout(root).brainstormRunResult(runId),
    report: factoryLayout(root).brainstormRunReport(runId),
  }
}

/** Every brainstorm run with a plan on disk, oldest first (best effort on mtimes). */
export async function listBrainstormRuns(root: string): Promise<string[]> {
  const runs = factoryLayout(root).brainstormRuns
  const entries = await readdir(runs).catch(() => [] as string[])
  const plans: Array<{ run: string; at: number }> = []
  for (const entry of entries) {
    if (!RUN_ID.test(entry)) continue
    const plan = brainstormRunPaths(root, entry).plan
    const info = await stat(plan).catch(() => undefined)
    if (info) plans.push({ run: entry, at: info.mtimeMs })
  }
  return plans.sort((a, b) => a.at - b.at).map((item) => item.run)
}

const invalid = (file: string, error: unknown) =>
  new Error(`invalid ${file}: ${error instanceof Error ? error.message : String(error)}`)

export async function readPlan(root: string, runId: string = DEFAULT_RUN): Promise<BrainstormPlan | undefined> {
  const raw = await readJson(brainstormRunPaths(root, runId).plan)
  if (raw === undefined && runId === DEFAULT_RUN) {
    // Pre-runs checkouts keep working: legacy top-level files read as the default run (#108).
    const legacy = await readJson(brainstormPaths(root).plan)
    if (legacy === undefined) return undefined
    const parsedLegacy = BrainstormPlanSchema.safeParse(legacy)
    if (!parsedLegacy.success) throw invalid("plan.json", parsedLegacy.error)
    return parsedLegacy.data
  }
  if (raw === undefined) return undefined
  const parsed = BrainstormPlanSchema.safeParse(raw)
  if (!parsed.success) throw invalid("plan.json", parsed.error)
  return parsed.data
}

export async function readIdeas(root: string, runId: string = DEFAULT_RUN): Promise<BrainstormIdea[]> {
  const raw = (await readJson(brainstormRunPaths(root, runId).ideas)) ?? []
  const parsed = BrainstormIdeaSchema.array().safeParse(raw)
  if (!parsed.success) throw invalid("ideas.json", parsed.error)
  return parsed.data
}

export async function readScores(root: string, runId: string = DEFAULT_RUN): Promise<BrainstormScore[]> {
  const raw = (await readJson(brainstormRunPaths(root, runId).scores)) ?? []
  const parsed = BrainstormScoreSchema.array().safeParse(raw)
  if (!parsed.success) throw invalid("scores.json", parsed.error)
  return parsed.data
}

export async function readResult(root: string, runId: string = DEFAULT_RUN): Promise<BrainstormResult | undefined> {
  const raw = await readJson(brainstormRunPaths(root, runId).result)
  if (raw === undefined && runId === DEFAULT_RUN) {
    const legacy = await readJson(brainstormPaths(root).result)
    if (legacy === undefined) return undefined
    const parsedLegacy = BrainstormResultSchema.safeParse(legacy)
    if (!parsedLegacy.success) throw invalid("brainstorm.json", parsedLegacy.error)
    return parsedLegacy.data
  }
  if (raw === undefined) return undefined
  const parsed = BrainstormResultSchema.safeParse(raw)
  if (!parsed.success) throw invalid("brainstorm.json", parsed.error)
  return parsed.data
}

export const writePlan = (root: string, plan: BrainstormPlan, runId: string = DEFAULT_RUN) =>
  writeJson(brainstormRunPaths(root, runId).plan, plan)
export const writeIdeas = (root: string, ideas: readonly BrainstormIdea[], runId: string = DEFAULT_RUN) =>
  writeJson(brainstormRunPaths(root, runId).ideas, ideas)
export const writeScores = (root: string, scores: readonly BrainstormScore[], runId: string = DEFAULT_RUN) =>
  writeJson(brainstormRunPaths(root, runId).scores, scores)

/** Replace the run: freeze the plan and clear ideas, scores and any stale result. */
export async function startRun(root: string, plan: BrainstormPlan, runId: string = DEFAULT_RUN): Promise<void> {
  await writePlan(root, plan, runId)
  await writeIdeas(root, [], runId)
  await writeScores(root, [], runId)
  const paths = brainstormRunPaths(root, runId)
  await rm(paths.result, { force: true })
  await rm(paths.report, { force: true })
}

export async function writeResult(
  root: string,
  result: BrainstormResult,
  report: string,
  runId: string = DEFAULT_RUN,
): Promise<void> {
  const paths = brainstormRunPaths(root, runId)
  await writeJson(paths.result, result)
  await atomicWrite(paths.report, report.endsWith("\n") ? report : `${report}\n`)
}

/** The human-readable digest: shortlist first, then the full ranked field. */
export function renderBrainstorm(result: BrainstormResult): string {
  const idea = new Map(result.ideas.map((item) => [item.id, item]))
  const lines: string[] = [`# Brainstorm: ${result.brief.idea}`, ""]
  if (result.brief.context) lines.push(result.brief.context, "")
  if (result.brief.constraints?.length) lines.push(`Constraints: ${result.brief.constraints.join("; ")}`, "")
  lines.push(
    `**${result.stats.ideas}** ideas from **${result.stats.lenses}** lenses · ${result.stats.duplicates} duplicate(s) collapsed · **${result.stats.scored}** scored.`,
    "",
    "## Shortlist",
    "",
  )
  result.shortlist.forEach((entry, index) => {
    const item = idea.get(entry.id)
    lines.push(
      `${index + 1}. **${entry.id}** (${entry.total}/20)${entry.outlier ? " · _forced outlier_" : ""} — ${item?.title ?? entry.id} _[${item?.lens ?? "?"}]_`,
      "",
      `   ${item?.text ?? ""}`,
      "",
    )
    if (entry.reason) lines.push(`   > ${entry.reason}`, "")
  })
  if (result.gaps.length) lines.push("## Gaps", "", ...result.gaps.map((lens) => `- ${lens}: no surviving idea`), "")
  if (result.priorArt?.length) {
    lines.push("## Prior art", "")
    for (const item of result.priorArt)
      lines.push(`- ${item.relation}: [${item.title}](${item.url})${item.note ? ` — ${item.note}` : ""}`)
    lines.push("")
  }
  lines.push("## Coverage", "", "| lens | ideas |", "| --- | --- |")
  for (const lens of result.lenses) lines.push(`| ${lens} | ${result.coverage[lens] ?? 0} |`)
  lines.push("", "## All ranked", "", "| idea | total | lens |", "| --- | --- | --- |")
  for (const entry of result.ranked)
    lines.push(
      `| ${entry.id} — ${idea.get(entry.id)?.title ?? ""} | ${entry.total} | ${idea.get(entry.id)?.lens ?? ""} |`,
    )
  if (result.duplicates.length) {
    lines.push("", "## Collapsed duplicates", "")
    for (const dup of result.duplicates)
      lines.push(`- ${dup.id} = ${dup.duplicateOf} (similarity ${dup.similarity.toFixed(2)}) — ${dup.title}`)
  }
  return lines.join("\n")
}
