// Fleet state (#122): every fleet file lives under `<stateDir>/fleet/`, so
// agent sandboxes mask it (trust/sandbox.ts tmpfs-mounts the state dir and
// sets ES_SANDBOX). All mutations go through core's advisory lock.
import path from "node:path"
import { readJson, withLock, writeJson } from "@heretek-ai/es-core"
import { z } from "zod"

/** Directory holding all fleet runtime state for one user. */
export const fleetDir = (stateRoot: string): string => path.join(stateRoot, "fleet")

export interface FleetPaths {
  readonly dir: string
  /** Live-daemon pidfile (JSON). */
  readonly pid: string
  /** Advisory-lock target for fleet mutations (lock lives at `${lock}.lock`). */
  readonly lock: string
  /** Persisted daemon status (JSON). */
  readonly state: string
  /** Persisted task DAG (JSON, #123). */
  readonly tasks: string
  /** Worktree registry (JSON, #124). */
  readonly worktrees: string
  /** Worker pid table (JSON, #125). */
  readonly workers: string
  /** Daemon control socket. */
  readonly socket: string
  /** Bearer token for the read-only telemetry bus (#126). */
  readonly token: string
}

export function fleetPaths(stateRoot: string): FleetPaths {
  const dir = fleetDir(stateRoot)
  return {
    dir,
    pid: path.join(dir, "daemon.pid"),
    lock: path.join(dir, "fleet.lock"),
    state: path.join(dir, "state.json"),
    tasks: path.join(dir, "tasks.json"),
    worktrees: path.join(dir, "worktrees.json"),
    workers: path.join(dir, "workers.json"),
    socket: path.join(dir, "fleet.sock"),
    token: path.join(dir, "token"),
  }
}

/** Version of the on-disk fleet state (bump on any incompatible change). */
export const FLEET_STATE_VERSION = 1 as const

export const FleetStateSchema = z.object({
  v: z.literal(FLEET_STATE_VERSION),
  running: z.boolean(),
  pid: z.number().int().positive().nullable(),
  startedAt: z.string().datetime().nullable(),
  maxUsd: z.number().positive().nullable(),
  concurrency: z.number().int().min(1),
})
export type FleetState = z.infer<typeof FleetStateSchema>

export const stoppedState = (concurrency = 4): FleetState => ({
  v: FLEET_STATE_VERSION,
  running: false,
  pid: null,
  startedAt: null,
  maxUsd: null,
  concurrency,
})

/** Read fleet state; undefined when missing, corrupt, or from another version. */
export async function readFleetState(stateRoot: string): Promise<FleetState | undefined> {
  let raw: unknown
  try {
    raw = await readJson(fleetPaths(stateRoot).state)
  } catch {
    return undefined
  }
  if (raw === undefined) return undefined
  const parsed = FleetStateSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/** Persist fleet state atomically (no lock: the caller must hold the fleet lock). */
export async function persistFleetState(paths: FleetPaths, state: FleetState): Promise<void> {
  await writeJson(paths.state, state)
}

/** Persist fleet state atomically under the fleet lock. */
export async function writeFleetState(stateRoot: string, state: FleetState): Promise<void> {
  const paths = fleetPaths(stateRoot)
  await withLock(paths.lock, () => persistFleetState(paths, state))
}
