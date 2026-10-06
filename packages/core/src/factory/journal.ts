import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { PhaseSchema } from "../schema/phase.ts"
import { atomicWrite } from "../util/fs.ts"

export const FactoryStageSchema = z.enum([
  "IDLE",
  "GRILL",
  "RESEARCH",
  "SPEC",
  "BUILD",
  "QA",
  "RELEASE",
  "DONE",
  "HALTED",
])

export type FactoryStage = z.infer<typeof FactoryStageSchema>

export const FactoryStateSchema = z.object({
  stage: FactoryStageSchema,
  activePhaseId: z.string().optional(),
  phases: z.array(PhaseSchema).default([]),
  spendCeilingUSD: z.number().positive(),
  totalSpendUSD: z.number().nonnegative().default(0),
  totalRetries: z.number().int().nonnegative().default(0),
  startedAt: z.string(),
  updatedAt: z.string(),
  haltReason: z.string().optional(),
})

export type FactoryState = z.infer<typeof FactoryStateSchema>

export async function saveState(rootDir: string, state: FactoryState): Promise<void> {
  const factoryDir = path.join(rootDir, ".factory")
  await mkdir(factoryDir, { recursive: true })
  const statePath = path.join(factoryDir, "state.json")
  state.updatedAt = new Date().toISOString()
  await atomicWrite(statePath, JSON.stringify(state, null, 2))
}

export async function loadState(rootDir: string): Promise<FactoryState | null> {
  const statePath = path.join(rootDir, ".factory", "state.json")
  try {
    const raw = await readFile(statePath, "utf8")
    return FactoryStateSchema.parse(JSON.parse(raw))
  } catch (err: any) {
    if (err.code === "ENOENT") return null
    throw err
  }
}
