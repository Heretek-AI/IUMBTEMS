// Deterministic DAG scheduler (#123, clean-room): `schedule` is pure — the
// same DAG and caps give the same decision, with no clock reads. Time enters
// only through `applyDecision`/`reportTask`, which stamp the transitions.
// Iteration is always id-sorted.
import { FleetError } from "./lifecycle.ts"
import { type DagState, type Task, TERMINAL, validateDag } from "./tasks.ts"

export interface Capacity {
  /** Max tasks with status `running` (`waiting-human` frees capacity). */
  readonly concurrency: number
  /** Max summed `ceilingUSD` over running tasks. */
  readonly fleetCeilingUsd: number
}

export interface CancelEntry {
  readonly id: string
  readonly reason: string
}

export interface Decision {
  /** Pending tasks whose deps are met: transition to `ready`. */
  readonly unblock: readonly string[]
  /** Ready tasks to launch now, id-sorted, within concurrency and ceiling. */
  readonly start: readonly string[]
  /** Tasks that can never run (dead deps): transition to `cancelled`. */
  readonly cancel: readonly CancelEntry[]
}

export type TaskReport =
  | { readonly outcome: "running"; readonly reason?: string }
  | { readonly outcome: "done"; readonly reason?: string; readonly spendUsd?: number; readonly summary?: string }
  | { readonly outcome: "failed"; readonly reason?: string; readonly spendUsd?: number }
  | { readonly outcome: "waiting-human"; readonly reason: string }
  | { readonly outcome: "cancelled"; readonly reason?: string }

const TERMINAL_DEP: ReadonlySet<string> = new Set(["done", "failed", "cancelled"])

/**
 * Compute the next decision for a DAG. Throws FleetError on an invalid DAG.
 * A task that can never run is cancelled here (transitively: every task is
 * evaluated against the current statuses in one pass, id-sorted).
 */
export function schedule(dag: DagState, caps: Capacity): Decision {
  validateDag(dag)
  if (!Number.isInteger(caps.concurrency) || caps.concurrency < 1)
    throw new FleetError(`Concurrency must be an integer >= 1 (got ${caps.concurrency}).`)
  if (!(caps.fleetCeilingUsd > 0) || !Number.isFinite(caps.fleetCeilingUsd))
    throw new FleetError(`Fleet ceiling must be positive (got ${caps.fleetCeilingUsd}).`)
  const unblock: string[] = []
  const cancel: CancelEntry[] = []
  for (const id of Object.keys(dag.tasks).sort()) {
    const task = dag.tasks[id]!
    if (task.status !== "pending" && task.status !== "ready") continue
    const depStatus = task.deps.map((dep) => dag.tasks[dep]!.status)
    if (task.trigger === "all_success") {
      const failedDep = task.deps.find((dep) => {
        const status = dag.tasks[dep]!.status
        return status === "failed" || status === "cancelled"
      })
      if (failedDep !== undefined) {
        cancel.push({ id, reason: `dependency ${failedDep} ${dag.tasks[failedDep]!.status}` })
        continue
      }
      if (depStatus.every((status) => status === "done")) {
        if (task.status === "pending") unblock.push(id)
      }
    } else {
      const anyDone = depStatus.includes("done")
      if (anyDone) {
        if (task.status === "pending") unblock.push(id)
        continue
      }
      const allTerminal = depStatus.every((status) => TERMINAL_DEP.has(status))
      if (allTerminal && task.deps.length > 0) {
        cancel.push({ id, reason: "no dependency succeeded" })
        continue
      }
      if (task.deps.length === 0 && task.status === "pending") unblock.push(id)
    }
  }
  // Start within concurrency and ceiling, id-sorted. `waiting-human` tasks
  // are already running elsewhere in human hands: they free both.
  const running = Object.values(dag.tasks).filter((task) => task.status === "running")
  let usedSlots = running.length
  let usedCeiling = running.reduce((sum, task) => sum + task.ceilingUSD, 0)
  const candidates = Object.keys(dag.tasks)
    .sort()
    .filter((id) => {
      const task = dag.tasks[id]!
      return task.status === "ready" || (task.status === "pending" && unblock.includes(id))
    })
  const start: string[] = []
  for (const id of candidates) {
    const task = dag.tasks[id]!
    if (usedSlots + 1 > caps.concurrency) break
    if (usedCeiling + task.ceilingUSD > caps.fleetCeilingUsd) continue
    start.push(id)
    usedSlots += 1
    usedCeiling += task.ceilingUSD
  }
  return { unblock, start, cancel }
}

/** Apply a decision, stamping with `now`. Transitions are idempotent. */
export function applyDecision(dag: DagState, decision: Decision, now: string): DagState {
  const tasks = { ...dag.tasks }
  const set = (id: string, task: Task) => {
    tasks[id] = task
  }
  for (const entry of decision.cancel) {
    const task = tasks[entry.id]
    if (task && !TERMINAL.has(task.status))
      set(entry.id, { ...task, status: "cancelled", reason: entry.reason, updatedAt: now })
  }
  for (const id of decision.unblock) {
    const task = tasks[id]
    if (task && task.status === "pending") set(id, { ...task, status: "ready", updatedAt: now })
  }
  for (const id of decision.start) {
    const task = tasks[id]
    if (task && (task.status === "pending" || task.status === "ready"))
      set(id, { ...task, status: "running", attempts: task.attempts + 1, updatedAt: now })
  }
  return { v: dag.v, tasks }
}

/**
 * Fold a worker report into the DAG, stamping with `now`. Reports for
 * terminal tasks are ignored (at-least-once delivery). A failed task follows
 * its own failure policy: `retry` re-queues while attempts remain, `replan`
 * parks it for a human, otherwise it is terminal and the next `schedule`
 * cancels its dependents.
 */
export function reportTask(
  dag: DagState,
  id: string,
  report: TaskReport,
  now: string,
): { dag: DagState; changed: boolean } {
  const task = dag.tasks[id]
  if (!task) throw new FleetError(`Unknown task ${JSON.stringify(id)}.`)
  if (TERMINAL.has(task.status)) return { dag, changed: false }
  const spend = report.outcome === "done" || report.outcome === "failed" ? report.spendUsd : undefined
  const result =
    spend === undefined ? task.result : { spendUsd: spend, summary: "summary" in report ? report.summary : undefined }
  switch (report.outcome) {
    case "running":
      if (task.status === "running") return { dag, changed: false }
      return {
        dag: {
          v: dag.v,
          tasks: { ...dag.tasks, [id]: { ...task, status: "running", attempts: task.attempts + 1, updatedAt: now } },
        },
        changed: true,
      }
    case "done":
      return {
        dag: {
          v: dag.v,
          tasks: { ...dag.tasks, [id]: { ...task, status: "done", reason: report.reason, updatedAt: now, result } },
        },
        changed: true,
      }
    case "waiting-human":
      return {
        dag: {
          v: dag.v,
          tasks: { ...dag.tasks, [id]: { ...task, status: "waiting-human", reason: report.reason, updatedAt: now } },
        },
        changed: true,
      }
    case "cancelled":
      return {
        dag: {
          v: dag.v,
          tasks: { ...dag.tasks, [id]: { ...task, status: "cancelled", reason: report.reason, updatedAt: now } },
        },
        changed: true,
      }
    case "failed": {
      if (task.policy.strategy === "retry" && task.attempts <= task.policy.maxAttempts)
        return {
          dag: {
            v: dag.v,
            tasks: {
              ...dag.tasks,
              [id]: { ...task, status: "pending", reason: report.reason, updatedAt: now, result: undefined },
            },
          },
          changed: true,
        }
      if (task.policy.strategy === "replan")
        return {
          dag: {
            v: dag.v,
            tasks: {
              ...dag.tasks,
              [id]: {
                ...task,
                status: "waiting-human",
                reason: `replan: ${report.reason ?? "failed run"}`,
                updatedAt: now,
                result,
              },
            },
          },
          changed: true,
        }
      return {
        dag: {
          v: dag.v,
          tasks: { ...dag.tasks, [id]: { ...task, status: "failed", reason: report.reason, updatedAt: now, result } },
        },
        changed: true,
      }
    }
  }
}
