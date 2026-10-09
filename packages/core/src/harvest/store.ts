// Reading and writing the darkharvest artifacts: .factory/harvest/plan.json,
// <candidate>/profile.json, matrix.json, harvest.json, HARVEST.md,
// VENDOR-PLAN.md and clean-room/<candidate>-<feature>.md.
import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import { DEFAULT_RUN } from "../brainstorm/store.ts"
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

export function harvestPaths(root: string, runId: string = DEFAULT_RUN) {
  const layout = factoryLayout(root)
  const run = factoryLayout(root).harvestRun(runId)
  return {
    dir: run,
    plan: layout.harvestRunPlan(runId),
    matrix: layout.harvestRunMatrix(runId),
    result: layout.harvestRunResult(runId),
    report: layout.harvestRunReport(runId),
    vendorPlan: layout.harvestRunVendorPlan(runId),
    cleanRoom: layout.harvestRunCleanRoom(runId),
    profile: (id: string) => layout.harvestRunProfile(runId, id),
  }
}

const invalid = (file: string, error: unknown) =>
  new Error(`invalid ${file}: ${error instanceof Error ? error.message : String(error)}`)

export async function readHarvestPlan(root: string, runId: string = DEFAULT_RUN): Promise<HarvestPlan | undefined> {
  const raw = await readJson(harvestPaths(root, runId).plan)
  if (raw === undefined && runId === DEFAULT_RUN) {
    // Pre-runs checkouts keep working: legacy top-level files read as the default run (#109).
    const legacy = await readJson(factoryLayout(root).harvestPlan)
    if (legacy === undefined) return undefined
    const parsedLegacy = HarvestPlanSchema.safeParse(legacy)
    if (!parsedLegacy.success) throw invalid("harvest/plan.json", parsedLegacy.error)
    return parsedLegacy.data
  }
  if (raw === undefined) return undefined
  const parsed = HarvestPlanSchema.safeParse(raw)
  if (!parsed.success) throw invalid("harvest/plan.json", parsed.error)
  return parsed.data
}

export const writeHarvestPlan = (root: string, plan: HarvestPlan, runId: string = DEFAULT_RUN) =>
  writeJson(harvestPaths(root, runId).plan, plan)

/** Replace the run: freeze the plan and remove every prior artifact. */
export async function startHarvestRun(root: string, plan: HarvestPlan, runId: string = DEFAULT_RUN): Promise<void> {
  await rm(harvestPaths(root, runId).dir, { recursive: true, force: true })
  await writeHarvestPlan(root, plan, runId)
}

/** Reserved names under .factory/harvest that are never candidate profiles. */
const RESERVED_HARVEST_DIRS = new Set(["notes", "clean-room", "runs"])

export async function readProfile(
  root: string,
  id: string,
  runId: string = DEFAULT_RUN,
): Promise<HarvestProfile | undefined> {
  const raw = await readJson(harvestPaths(root, runId).profile(id))
  if (raw === undefined && runId === DEFAULT_RUN && !RESERVED_HARVEST_DIRS.has(id)) {
    const legacy = await readJson(path.join(factoryLayout(root).harvest, id, "profile.json"))
    if (legacy === undefined) return undefined
    const parsedLegacy = HarvestProfileSchema.safeParse(legacy)
    if (!parsedLegacy.success) throw invalid(`harvest/${id}/profile.json`, parsedLegacy.error)
    return parsedLegacy.data
  }
  if (raw === undefined) return undefined
  const parsed = HarvestProfileSchema.safeParse(raw)
  if (!parsed.success) throw invalid(`harvest/${id}/profile.json`, parsed.error)
  return parsed.data
}

export const writeProfile = (root: string, profile: HarvestProfile, runId: string = DEFAULT_RUN) =>
  writeJson(harvestPaths(root, runId).profile(profile.id), profile)

/** Every scanned profile for a run (legacy flat profiles read as the default run). */
export async function readProfiles(root: string, runId: string = DEFAULT_RUN): Promise<HarvestProfile[]> {
  const entries = await readdir(harvestPaths(root, runId).dir, { withFileTypes: true }).catch(() => [])
  const out: HarvestProfile[] = []
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const profile = await readProfile(root, entry.name, runId)
    if (profile) out.push(profile)
  }
  if (runId === DEFAULT_RUN) {
    const legacy = await readdir(factoryLayout(root).harvest, { withFileTypes: true }).catch(() => [])
    for (const entry of legacy
      .filter((item) => item.isDirectory() && !RESERVED_HARVEST_DIRS.has(item.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.some((profile) => profile.id === entry.name)) continue
      const profile = await readProfile(root, entry.name, runId)
      if (profile) out.push(profile)
    }
  }
  return out
}

export async function readMatrix(root: string, runId: string = DEFAULT_RUN): Promise<HarvestMatrix | undefined> {
  const raw = await readJson(harvestPaths(root, runId).matrix)
  if (raw === undefined && runId === DEFAULT_RUN) {
    const legacy = await readJson(factoryLayout(root).harvestMatrix)
    if (legacy === undefined) return undefined
    const parsedLegacy = HarvestMatrixSchema.safeParse(legacy)
    if (!parsedLegacy.success) throw invalid("harvest/matrix.json", parsedLegacy.error)
    return parsedLegacy.data
  }
  if (raw === undefined) return undefined
  const parsed = HarvestMatrixSchema.safeParse(raw)
  if (!parsed.success) throw invalid("harvest/matrix.json", parsed.error)
  return parsed.data
}

export const writeMatrix = (root: string, matrix: HarvestMatrix, runId: string = DEFAULT_RUN) =>
  writeJson(harvestPaths(root, runId).matrix, matrix)

export async function readHarvestResult(root: string, runId: string = DEFAULT_RUN): Promise<HarvestResult | undefined> {
  const raw = await readJson(harvestPaths(root, runId).result)
  if (raw === undefined && runId === DEFAULT_RUN) {
    const legacy = await readJson(factoryLayout(root).harvestResult)
    if (legacy === undefined) return undefined
    const parsedLegacy = HarvestResultSchema.safeParse(legacy)
    if (!parsedLegacy.success) throw invalid("harvest/harvest.json", parsedLegacy.error)
    return parsedLegacy.data
  }
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
  runId: string = DEFAULT_RUN,
): Promise<HarvestResult> {
  const result = HarvestResultSchema.parse({
    version: HARVEST_VERSION,
    objective,
    profiles,
    matrix,
    completedAt: new Date().toISOString(),
  })
  const paths = harvestPaths(root, runId)
  await writeJson(paths.result, result)
  await atomicWrite(paths.report, `${rendered.report}\n`)
  await atomicWrite(paths.vendorPlan, `${rendered.vendorPlan}\n`)
  for (const spec of rendered.cleanRoom) {
    const file = path.join(
      paths.cleanRoom,
      `${spec.candidate}-${spec.feature.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`,
    )
    await atomicWrite(file, spec.content)
  }
  return result
}
