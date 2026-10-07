// Reading and writing the scout's artifacts under .factory/scout/ (all control
// files except notes/): plan.json, <id>/profile.json, <id>/advisories.json,
// assessments.json, scout.json, dossier.json and REPORT.md.
import { rm } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import { type HarvestProfile, HarvestProfileSchema } from "../schema/harvest.ts"
import {
  type ScoutAdvisory,
  ScoutAdvisorySchema,
  type ScoutAssessment,
  ScoutAssessmentSchema,
  type ScoutPlan,
  ScoutPlanSchema,
  type ScoutResult,
  ScoutResultSchema,
} from "../schema/scout.ts"
import { readJson, withLock, writeJson } from "../util/fs.ts"

export function scoutPaths(root: string) {
  const layout = factoryLayout(root)
  return {
    dir: layout.scout,
    plan: layout.scoutPlan,
    assessments: layout.scoutAssessments,
    result: layout.scoutResult,
    dossier: layout.scoutDossier,
    report: layout.scoutReport,
    profile: layout.scoutProfile,
    advisories: (id: string) => path.join(layout.scout, id, "advisories.json"),
  }
}

async function parsed<T>(file: string, schema: { parse(value: unknown): T }): Promise<T | undefined> {
  const raw = await readJson(file)
  if (raw === undefined) return undefined
  try {
    return schema.parse(raw)
  } catch (error) {
    throw new Error(`invalid ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const readScoutPlan = (root: string) => parsed<ScoutPlan>(scoutPaths(root).plan, ScoutPlanSchema)
export const readScoutResult = (root: string) => parsed<ScoutResult>(scoutPaths(root).result, ScoutResultSchema)
export const readScoutProfile = (root: string, id: string) =>
  parsed<HarvestProfile>(scoutPaths(root).profile(id), HarvestProfileSchema)

/** A new plan replaces the old run: its assessments, result, dossier and report are dropped. */
export async function startScoutRun(root: string, plan: ScoutPlan): Promise<void> {
  const paths = scoutPaths(root)
  for (const file of [paths.assessments, paths.result, paths.dossier, paths.report]) await rm(file, { force: true })
  await writeJson(paths.plan, ScoutPlanSchema.parse(plan))
}

export const writeScoutProfile = (root: string, profile: HarvestProfile) =>
  writeJson(scoutPaths(root).profile(profile.id), HarvestProfileSchema.parse(profile))

export async function readScoutAdvisories(root: string, id: string): Promise<ScoutAdvisory[] | undefined> {
  const raw = await readJson<unknown[]>(scoutPaths(root).advisories(id))
  return raw === undefined ? undefined : raw.map((item) => ScoutAdvisorySchema.parse(item))
}

export const writeScoutAdvisories = (root: string, id: string, advisories: readonly ScoutAdvisory[]) =>
  writeJson(scoutPaths(root).advisories(id), advisories)

export async function readAssessments(root: string): Promise<ScoutAssessment[]> {
  const raw = await readJson<unknown[]>(scoutPaths(root).assessments)
  return (raw ?? []).map((item) => ScoutAssessmentSchema.parse(item))
}

/** Record (or replace) one candidate's assessment. */
export async function upsertAssessment(root: string, assessment: ScoutAssessment): Promise<void> {
  const file = scoutPaths(root).assessments
  await withLock(file, async () => {
    const others = (await readAssessments(root)).filter((item) => item.candidate !== assessment.candidate)
    await writeJson(file, [...others, ScoutAssessmentSchema.parse(assessment)])
  })
}

export const writeScoutResult = (root: string, result: ScoutResult) =>
  writeJson(scoutPaths(root).result, ScoutResultSchema.parse(result))
