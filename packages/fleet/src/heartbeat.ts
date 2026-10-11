// Fleet heartbeats (#161): the daemon records one JSON file per run
// checkout at `<repoRoot>/.factory/runtime/fleet.json`, so humans and factory
// seats can see DAG progress without the telemetry bus. Written on every tick
// and every folded report; readers tolerate a missing or corrupt file.
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { atomicWrite, readJson } from "@heretek-ai/es-core"
import { z } from "zod"

export const HEARTBEAT_VERSION = 1 as const

export const HeartbeatTaskSchema = z.object({
  status: z.string().min(1),
  attempts: z.number().int().min(0),
  updatedAt: z.string(),
})
export type HeartbeatTask = z.infer<typeof HeartbeatTaskSchema>

export const FleetHeartbeatSchema = z.object({
  v: z.literal(HEARTBEAT_VERSION),
  at: z.string().datetime(),
  pid: z.number().int().positive(),
  dagId: z.string().min(1),
  tasks: z.record(z.string(), HeartbeatTaskSchema),
})
export type FleetHeartbeat = z.infer<typeof FleetHeartbeatSchema>

export const heartbeatPath = (repoRoot: string): string => path.join(repoRoot, ".factory", "runtime", "fleet.json")

/** Parse untrusted heartbeat JSON; throws on a version or shape mismatch. */
export function loadFleetHeartbeat(raw: unknown): FleetHeartbeat {
  return FleetHeartbeatSchema.parse(raw)
}

/** Read the heartbeat file; undefined when missing or unreadable. */
export async function readFleetHeartbeat(repoRoot: string): Promise<FleetHeartbeat | undefined> {
  let raw: unknown
  try {
    raw = await readJson(heartbeatPath(repoRoot))
  } catch {
    return undefined
  }
  if (raw === undefined) return undefined
  const parsed = FleetHeartbeatSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/** Atomically replace the heartbeat file (creating its dir). */
export async function recordFleetHeartbeat(repoRoot: string, heartbeat: FleetHeartbeat): Promise<void> {
  FleetHeartbeatSchema.parse(heartbeat)
  const file = heartbeatPath(repoRoot)
  await mkdir(path.dirname(file), { recursive: true })
  await atomicWrite(file, `${JSON.stringify(heartbeat, null, 2)}\n`)
}
