// Fleet task model and DAG validation (#123, clean-room): tasks are pure
// data with a zod schema; the DAG is validated on add (unknown deps,
// self-deps, cycles). Persistence lives in `<stateDir>/fleet/tasks.json`
// under the shared fleet lock.

import { readJson, withLock, writeJson } from "@heretek-ai/es-core"
import { z } from "zod"
import { FleetError } from "./lifecycle.ts"
import { fleetPaths } from "./state.ts"

export const TaskStatusSchema = z.enum(["pending", "ready", "running", "waiting-human", "done", "failed", "cancelled"])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const TriggerSchema = z.enum(["all_success", "one_success"])
export type Trigger = z.infer<typeof TriggerSchema>

export const FailurePolicySchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("fail") }),
  z.object({ strategy: z.literal("retry"), maxAttempts: z.number().int().min(1) }),
  z.object({ strategy: z.literal("replan") }),
])
export type FailurePolicy = z.infer<typeof FailurePolicySchema>

export const TaskInputSchema = z.object({
  objective: z.string().min(1),
  tier: z.string().min(1).optional(),
})
export type TaskInput = z.infer<typeof TaskInputSchema>

export const TaskResultSchema = z.object({
  spendUsd: z.number().min(0),
  summary: z.string().optional(),
})
export type TaskResult = z.infer<typeof TaskResultSchema>

export const TaskSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "task ids are lowercase alphanumerics and dashes"),
  title: z.string().min(1),
  kind: z.enum(["factory-run", "research-run"]),
  deps: z.array(z.string().min(1)).default([]),
  trigger: TriggerSchema.default("all_success"),
  input: TaskInputSchema,
  ceilingUSD: z.number().positive(),
  policy: FailurePolicySchema.default({ strategy: "fail" }),
  status: TaskStatusSchema.default("pending"),
  attempts: z.number().int().min(0).default(0),
  reason: z.string().optional(),
  result: TaskResultSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type Task = z.infer<typeof TaskSchema>

export const DAG_VERSION = 1 as const

export const DagStateSchema = z.object({
  v: z.literal(DAG_VERSION),
  tasks: z.record(z.string(), TaskSchema),
})
export type DagState = z.infer<typeof DagStateSchema>

export const emptyDag = (): DagState => ({ v: DAG_VERSION, tasks: {} })

export const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"])

/**
 * Validate a DAG: every dep names a known task, no self-deps, no cycles.
 * Throws FleetError naming the offender. Iteration is id-sorted, so the
 * first error reported is deterministic.
 */
export function validateDag(dag: DagState): void {
  const ids = Object.keys(dag.tasks).sort((a, b) => a.localeCompare(b))
  for (const id of ids) {
    const task = dag.tasks[id]!
    if (task.id !== id) throw new FleetError(`Task key ${JSON.stringify(id)} holds task ${JSON.stringify(task.id)}.`)
    for (const dep of task.deps) {
      if (!(dep in dag.tasks))
        throw new FleetError(`Task ${JSON.stringify(id)} depends on unknown task ${JSON.stringify(dep)}.`)
      if (dep === id) throw new FleetError(`Task ${JSON.stringify(id)} depends on itself.`)
    }
  }
  // Iterative DFS with explicit colors; neighbours in id order.
  const color = new Map<string, "gray" | "black">()
  for (const root of ids) {
    if (color.has(root)) continue
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }]
    color.set(root, "gray")
    while (stack.length > 0) {
      const top = stack.at(-1)!
      const deps = [...dag.tasks[top.id]!.deps].sort((a, b) => a.localeCompare(b))
      if (top.next >= deps.length) {
        color.set(top.id, "black")
        stack.pop()
        continue
      }
      const dep = deps[top.next]!
      top.next += 1
      const seen = color.get(dep)
      if (seen === "gray") throw new FleetError(`Dependency cycle through ${JSON.stringify(dep)}.`)
      if (seen === undefined) {
        color.set(dep, "gray")
        stack.push({ id: dep, next: 0 })
      }
    }
  }
}

/** Add a task (stamping createdAt/updatedAt when absent); the result validates. */
export function addTask(dag: DagState, input: Record<string, unknown>, now = new Date().toISOString()): DagState {
  const parsed = TaskSchema.parse({
    deps: [],
    trigger: "all_success",
    policy: { strategy: "fail" },
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...input,
  })
  if (parsed.id in dag.tasks) throw new FleetError(`Duplicate task id ${JSON.stringify(parsed.id)}.`)
  const next: DagState = { v: DAG_VERSION, tasks: { ...dag.tasks, [parsed.id]: parsed } }
  validateDag(next)
  return next
}

/** Load the persisted DAG; undefined when missing, corrupt, or versioned away. */
export async function loadDag(stateRoot: string): Promise<DagState | undefined> {
  let raw: unknown
  try {
    raw = await readJson(fleetPaths(stateRoot).tasks)
  } catch {
    return undefined
  }
  if (raw === undefined) return undefined
  const parsed = DagStateSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/** Persist the DAG atomically under the fleet lock. */
export async function saveDag(stateRoot: string, dag: DagState): Promise<void> {
  validateDag(dag)
  const paths = fleetPaths(stateRoot)
  await withLock(paths.lock, () => writeJson(paths.tasks, dag))
}
