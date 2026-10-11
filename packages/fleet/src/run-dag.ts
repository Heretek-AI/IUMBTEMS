// Headless DAG execution (#161): `es-fleet run-dag <roadmap.json>` loads a
// ticket-scoped roadmap file and drives it through the FleetDaemon tick loop
// until every task is terminal, with no prompt-level orchestration and no
// human in the loop. Prompts receive only ticket-scoped context (each task's
// own objective); the daemon owns ordering, concurrency, landings,
// heartbeats and stuck-turn restarts.
import { readFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { FleetDaemon, type WorkerPort } from "./daemon.ts"
import { FleetError } from "./lifecycle.ts"
import type { TaskReport } from "./scheduler.ts"
import { addTask, type DagState, emptyDag, loadDag, saveDag, TERMINAL } from "./tasks.ts"
import type { WorkerSpec } from "./worker.ts"
import type { GateCheck } from "./worktree.ts"

export interface RoadmapFile {
  readonly dagId: string
  readonly dag: DagState
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Load and validate a roadmap file: `{ dagId?, title?, tasks: [...] }` where
 * every task carries ticket-scoped context (id, title, kind, input.objective,
 * ceilingUSD, deps, trigger, policy). Unknown deps, self-deps and cycles are
 * refused by DAG validation. `now` stamps createdAt/updatedAt (tests).
 */
export async function loadRoadmapFile(file: string, now = new Date().toISOString()): Promise<RoadmapFile> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    throw new FleetError(`Cannot read roadmap ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(raw) || !Array.isArray(raw.tasks))
    throw new FleetError(`Roadmap ${file} must be an object with a tasks array.`)
  const dagId = typeof raw.dagId === "string" && raw.dagId.length > 0 ? raw.dagId : "fleet"
  if (!/^[a-z0-9][a-z0-9-]*$/.test(dagId) || dagId.length > 64)
    throw new FleetError(`Invalid dag id ${JSON.stringify(dagId)}: lowercase alphanumerics and dashes only.`)
  let dag = emptyDag()
  for (const entry of raw.tasks) {
    if (!isRecord(entry)) throw new FleetError(`Roadmap ${file} has a non-object task.`)
    try {
      dag = addTask(dag, entry, now)
    } catch (error) {
      throw new FleetError(
        `Roadmap ${file} has an invalid task: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (Object.keys(dag.tasks).length === 0) throw new FleetError(`Roadmap ${file} has no tasks.`)
  return { dagId, dag }
}

export interface RunDagOptions {
  readonly repoRoot: string
  readonly stateRoot: string
  readonly esBin: string
  readonly roadmapFile: string
  readonly concurrency?: number
  readonly fleetCeilingUsd: number
  readonly checkGates: GateCheck
  readonly spawnWorker?: (spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void) => WorkerPort
  /** Stamp override (tests, determinism). */
  readonly now?: string
  /** Stuck-turn timeout forwarded to the daemon (default: disabled; the verb sets 30min). */
  readonly stuckTimeoutMs?: number
  /** Settle delay between ticks for async worker reports (default 10ms). */
  readonly settleMs?: number
  /** Safety bound on ticks (default 500). */
  readonly maxTicks?: number
}

const settled = (dag: DagState): boolean =>
  Object.values(dag.tasks).every((task) => TERMINAL.has(task.status) || task.status === "waiting-human")

/**
 * Run one roadmap file to completion: persist the DAG, then tick the daemon
 * until every task is done, failed, cancelled, or waiting on a human. A
 * waiting-human task stops the run (a human repairs and re-runs); it is not
 * an error. Returns the final DAG. Throws when maxTicks is exhausted first.
 */
export async function runDag(options: RunDagOptions): Promise<DagState> {
  const { dagId, dag } = await loadRoadmapFile(options.roadmapFile, options.now)
  await saveDag(options.stateRoot, dag)
  const daemon = new FleetDaemon({
    repoRoot: options.repoRoot,
    stateRoot: options.stateRoot,
    esBin: options.esBin,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    fleetCeilingUsd: options.fleetCeilingUsd,
    checkGates: options.checkGates,
    ...(options.spawnWorker ? { spawnWorker: options.spawnWorker } : {}),
    ...(options.stuckTimeoutMs !== undefined ? { stuckTimeoutMs: options.stuckTimeoutMs } : {}),
    dagId,
  })
  await daemon.recover([])
  const settleMs = options.settleMs ?? 10
  const maxTicks = options.maxTicks ?? 500
  for (let tick = 0; tick < maxTicks; tick++) {
    await daemon.tick()
    // Worker reports land through async callbacks: let them fold before the
    // terminal check, so a finished task is seen as finished.
    await sleep(settleMs)
    const current = (await loadDag(options.stateRoot)) ?? emptyDag()
    if (settled(current)) {
      await daemon.shutdown()
      return current
    }
  }
  await daemon.shutdown()
  throw new FleetError(`run-dag did not settle after ${maxTicks} ticks; the DAG is resumable in the fleet state.`)
}
