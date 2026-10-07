// Reading and writing the darkharvest artifacts: .factory/harvest/plan.json,
// <candidate>/profile.json, matrix.json, harvest.json, HARVEST.md,
// VENDOR-PLAN.md and clean-room/<candidate>-<feature>.md.
import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import {
  HARVEST_VERSION,
  type HarvestMatrix,
  HarvestMatrixSchema,
  type HarvestPlan,
  HarvestPlanSchema,
  type HarvestProfile,
  HarvestProfileSchema,
  type HarvestResult,
  HarvestResultSchema,
} from "../schema/harvest.ts"
import { atomicWrite, readJson, writeJson } from "../util/fs.ts"

export function harvestPaths(root: string) {
  const layout = factoryLayout(root)
  return {
    dir: layout.harvest,
    plan: layout.harvestPlan,
    matrix: layout.harvestMatrix,
    result: layout.harvestResult,
    report: layout.harvestReport,
    vendorPlan: layout.harvestVendorPlan,
    cleanRoom: layout.harvestCleanRoom,
    profile: (id: string) => path.join(layout.harvest, id, "profile.json"),
  }
}

const invalid = (file: string, error: unknown) =>
  new Error(`invalid ${file}: ${error instanceof Error ? error.message : String(error)}`)

export async function readHarvestPlan(root: string): Promise<HarvestPlan | undefined> {
  const raw = await readJson(harvestPaths(root).plan)
  if (raw === undefined) return undefined
  const parsed = HarvestPlanSchema.safeParse(raw)
  if (!parsed.success) throw invalid("harvest/plan.json", parsed.error)
  return parsed.data
}

export const writeHarvestPlan = (root: string, plan: HarvestPlan) => writeJson(harvestPaths(root).plan, plan)

/** Replace the run: freeze the plan and remove every prior artifact. */
export async function startHarvestRun(root: string, plan: HarvestPlan): Promise<void> {
  await rm(harvestPaths(root).dir, { recursive: true, force: true })
  await writeHarvestPlan(root, plan)
}

export async function readProfile(root: string, id: string): Promise<HarvestProfile | undefined> {
  const raw = await readJson(harvestPaths(root).profile(id))
  if (raw === undefined) return undefined
  const parsed = HarvestProfileSchema.safeParse(raw)
  if (!parsed.success) throw invalid(`harvest/${id}/profile.json`, parsed.error)
  return parsed.data
}

export const writeProfile = (root: string, profile: HarvestProfile) =>
  writeJson(harvestPaths(root).profile(profile.id), profile)

/** Every scanned profile under .factory/harvest/<id>/profile.json. */
export async function readProfiles(root: string): Promise<HarvestProfile[]> {
  const entries = await readdir(harvestPaths(root).dir, { withFileTypes: true }).catch(() => [])
  const out: HarvestProfile[] = []
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const profile = await readProfile(root, entry.name)
    if (profile) out.push(profile)
  }
  return out
}

export async function readMatrix(root: string): Promise<HarvestMatrix | undefined> {
  const raw = await readJson(harvestPaths(root).matrix)
  if (raw === undefined) return undefined
  const parsed = HarvestMatrixSchema.safeParse(raw)
  if (!parsed.success) throw invalid("harvest/matrix.json", parsed.error)
  return parsed.data
}

export const writeMatrix = (root: string, matrix: HarvestMatrix) => writeJson(harvestPaths(root).matrix, matrix)

export async function readHarvestResult(root: string): Promise<HarvestResult | undefined> {
  const raw = await readJson(harvestPaths(root).result)
  if (raw === undefined) return undefined
  const parsed = HarvestResultSchema.safeParse(raw)
  if (!parsed.success) throw invalid("harvest/harvest.json", parsed.error)
  return parsed.data
}

export async function writeHarvestResult(
  root: string,
  objective: string,
  profiles: HarvestProfile[],
  matrix: HarvestMatrix,
  rendered: {
    report: string
    vendorPlan: string
    cleanRoom: Array<{ candidate: string; feature: string; content: string }>
  },
): Promise<HarvestResult> {
  const result = HarvestResultSchema.parse({
    version: HARVEST_VERSION,
    objective,
    profiles,
    matrix,
    completedAt: new Date().toISOString(),
  })
  await writeJson(harvestPaths(root).result, result)
  await atomicWrite(harvestPaths(root).report, `${rendered.report}\n`)
  await atomicWrite(harvestPaths(root).vendorPlan, `${rendered.vendorPlan}\n`)
  for (const spec of rendered.cleanRoom) {
    const file = path.join(
      harvestPaths(root).cleanRoom,
      `${spec.candidate}-${spec.feature.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`,
    )
    await atomicWrite(file, spec.content)
  }
  return result
}
