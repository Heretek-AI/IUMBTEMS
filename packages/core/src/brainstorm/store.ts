// Reading, writing and rendering the brainstorm artifacts under
// .factory/brainstorm/: plan.json, ideas.json, scores.json, brainstorm.json
// and the human-readable BRAINSTORM.md.
import { rm } from "node:fs/promises"
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

const invalid = (file: string, error: unknown) =>
  new Error(`invalid ${file}: ${error instanceof Error ? error.message : String(error)}`)

export async function readPlan(root: string): Promise<BrainstormPlan | undefined> {
  const raw = await readJson(brainstormPaths(root).plan)
  if (raw === undefined) return undefined
  const parsed = BrainstormPlanSchema.safeParse(raw)
  if (!parsed.success) throw invalid("plan.json", parsed.error)
  return parsed.data
}

export async function readIdeas(root: string): Promise<BrainstormIdea[]> {
  const raw = (await readJson(brainstormPaths(root).ideas)) ?? []
  const parsed = BrainstormIdeaSchema.array().safeParse(raw)
  if (!parsed.success) throw invalid("ideas.json", parsed.error)
  return parsed.data
}

export async function readScores(root: string): Promise<BrainstormScore[]> {
  const raw = (await readJson(brainstormPaths(root).scores)) ?? []
  const parsed = BrainstormScoreSchema.array().safeParse(raw)
  if (!parsed.success) throw invalid("scores.json", parsed.error)
  return parsed.data
}

export async function readResult(root: string): Promise<BrainstormResult | undefined> {
  const raw = await readJson(brainstormPaths(root).result)
  if (raw === undefined) return undefined
  const parsed = BrainstormResultSchema.safeParse(raw)
  if (!parsed.success) throw invalid("brainstorm.json", parsed.error)
  return parsed.data
}

export const writePlan = (root: string, plan: BrainstormPlan) => writeJson(brainstormPaths(root).plan, plan)
export const writeIdeas = (root: string, ideas: readonly BrainstormIdea[]) =>
  writeJson(brainstormPaths(root).ideas, ideas)
export const writeScores = (root: string, scores: readonly BrainstormScore[]) =>
  writeJson(brainstormPaths(root).scores, scores)

/** Replace the run: freeze the plan and clear ideas, scores and any stale result. */
export async function startRun(root: string, plan: BrainstormPlan): Promise<void> {
  await writePlan(root, plan)
  await writeIdeas(root, [])
  await writeScores(root, [])
  await rm(brainstormPaths(root).result, { force: true })
  await rm(brainstormPaths(root).report, { force: true })
}

export async function writeResult(root: string, result: BrainstormResult, report: string): Promise<void> {
  await writeJson(brainstormPaths(root).result, result)
  await atomicWrite(brainstormPaths(root).report, report.endsWith("\n") ? report : `${report}\n`)
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
