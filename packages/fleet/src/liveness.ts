// Per-task run liveness (#130, repair-151 S5.6, feeds S7): computed in fleet
// from the task worktree's factory state with core's factory/liveness.ts
// (`headline`, `seatLine`, `researchLine`). The payload is JSON-safe data
// exported as a *type* for the web control plane to `import type`
// (`import type { TaskLiveness } from "@heretek-ai/es-fleet"`); the bus
// serves it at `fleet.task.liveness`.
import {
  type FactoryState,
  FactoryStateSchema,
  factoryLayout,
  headline,
  readJson,
  readLiveness,
  researchLine,
  seatLine,
} from "@heretek-ai/es-core"

/**
 * Per-task liveness for one fleet task: the run's one-sentence headline, its
 * stage, one line per seat, and research progress when the run is in
 * RESEARCH. Served by the bus method `fleet.task.liveness {id}`.
 */
export interface TaskLiveness {
  readonly taskId: string
  readonly runId?: string
  readonly stage: string
  readonly headline: string
  readonly seats: readonly string[]
  readonly research?: string
  readonly lastActivityAt?: string
}

/** Read one task worktree's liveness (missing state reads as stage NONE). */
export async function readTaskLiveness(
  worktreeDir: string,
  taskId: string,
  now: Date = new Date(),
): Promise<TaskLiveness> {
  let state: FactoryState | undefined
  const raw = await readJson(factoryLayout(worktreeDir).state)
  if (raw !== undefined) {
    const parsed = FactoryStateSchema.safeParse(raw)
    if (parsed.success) state = parsed.data
  }
  const liveness = await readLiveness(worktreeDir, state, { now })
  const research = researchLine(liveness)
  return {
    taskId,
    ...(liveness.runId ? { runId: liveness.runId } : {}),
    stage: liveness.stage,
    headline: headline(state, liveness),
    seats: liveness.seats.map((seat) => seatLine(liveness, seat)),
    ...(research ? { research } : {}),
    ...(liveness.lastActivityAt ? { lastActivityAt: liveness.lastActivityAt } : {}),
  }
}
