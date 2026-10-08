// Per-user run index (1.1.3, #61): one small file per run under the private
// state dir, so `es runs` and `es status` can name every recent run across
// projects instead of assuming the cwd's. Written best-effort on state saves;
// an entry whose project no longer holds that run is skipped on read.
import { readdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { factoryLayout } from "../layout.ts"
import { atomicWrite, readJson } from "../util/fs.ts"
import { StageSchema } from "./state.ts"

export const RunIndexEntrySchema = z.object({
  runId: z.string().min(1),
  root: z.string().min(1),
  stage: StageSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RunIndexEntry = z.infer<typeof RunIndexEntrySchema>

const RUN_ID = /^run-[\w-]+$/

export const runsIndexDir = (stateDir: string) => path.join(stateDir, "runs")

/** Record (or refresh) one run's entry. Never throws: the index is a convenience. */
export async function indexRun(stateDir: string, entry: RunIndexEntry): Promise<void> {
  if (!RUN_ID.test(entry.runId)) return
  await atomicWrite(path.join(runsIndexDir(stateDir), `${entry.runId}.json`), `${JSON.stringify(entry)}\n`).catch(
    () => undefined,
  )
}

/**
 * Indexed runs, most recently updated first. An entry is skipped when its
 * project's state no longer names that run (deleted, or replaced by a newer
 * run). Stage and updatedAt come from the project's state file, which is
 * fresher than the index; the index is advisory, so that file is read
 * without verifying its seal.
 */
export async function listRuns(stateDir: string): Promise<RunIndexEntry[]> {
  const names = await readdir(runsIndexDir(stateDir)).catch(() => [] as string[])
  const entries: RunIndexEntry[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const parsed = RunIndexEntrySchema.safeParse(
      await readJson(path.join(runsIndexDir(stateDir), name)).catch(() => undefined),
    )
    if (!parsed.success) continue
    const current = await readJson<Record<string, unknown>>(factoryLayout(parsed.data.root).state).catch(
      () => undefined,
    )
    if (current?.runId !== parsed.data.runId) continue
    const fresh = RunIndexEntrySchema.safeParse({ ...parsed.data, stage: current.stage, updatedAt: current.updatedAt })
    entries.push(fresh.success ? fresh.data : parsed.data)
  }
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
