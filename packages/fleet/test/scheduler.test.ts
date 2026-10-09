// Deterministic DAG scheduler (#123): readiness, concurrency, the fleet
// ceiling, failure policies, waiting-human capacity, and determinism.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyDecision, markGateFailed, reportTask, schedule } from "../src/scheduler.ts"
import { addTask, type DagState, emptyDag, loadDag, saveDag, TaskSchema } from "../src/tasks.ts"

const NOW = "2026-10-09T12:00:00.000Z"
const CAPS = { concurrency: 4, fleetCeilingUsd: 100 }

const task = (id: string, deps: string[] = [], extra: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  kind: "factory-run" as const,
  deps,
  input: { objective: `do ${id}` },
  ceilingUSD: 5,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
})

const dagOf = (specs: Array<{ id: string; deps?: string[]; extra?: Record<string, unknown> }>): DagState => {
  let dag = emptyDag()
  for (const spec of specs) dag = addTask(dag, task(spec.id, spec.deps ?? [], spec.extra ?? {}), NOW)
  return dag
}

const runTo = (dag: DagState, ids: readonly string[], status: "done" | "failed" = "done"): DagState => {
  let next = dag
  for (const id of ids) {
    const scheduled = applyDecision(next, schedule(next, CAPS), NOW)
    next = reportTask(
      applyDecision(scheduled, { start: [id], unblock: [], cancel: [] }, NOW),
      id,
      { outcome: "running" },
      NOW,
    ).dag
    next = reportTask(next, id, { outcome: status }, NOW).dag
  }
  return next
}

describe("readiness and ordering", () => {
  test("nothing starts before its deps are done", () => {
    const dag = dagOf([{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }])
    const first = schedule(dag, CAPS)
    expect(first.start).toEqual(["a"])
    expect(first.unblock).toEqual(["a"])
    const afterA = runTo(dag, ["a"])
    const second = schedule(afterA, CAPS)
    expect([...second.start].sort()).toEqual(["b", "c"])
  })

  test("one_success starts on the first done dep", () => {
    const dag = dagOf([{ id: "a" }, { id: "b" }, { id: "c", deps: ["a", "b"], extra: { trigger: "one_success" } }])
    const afterA = runTo(dag, ["a"])
    expect(schedule(afterA, CAPS).start).toContain("c")
  })

  test("one_success waits while deps are pending, cancels when all fail", () => {
    const dag = dagOf([{ id: "a" }, { id: "b" }, { id: "c", deps: ["a", "b"], extra: { trigger: "one_success" } }])
    expect(schedule(dag, CAPS).start).not.toContain("c")
    const afterFail = runTo(dag, ["a", "b"], "failed")
    expect(schedule(afterFail, CAPS).cancel.map((c) => c.id)).toContain("c")
  })
})

describe("concurrency and ceilings", () => {
  test("starts stop at the concurrency limit, in id order", () => {
    const dag = dagOf([{ id: "a" }, { id: "b" }, { id: "c" }])
    const decision = schedule(dag, { concurrency: 2, fleetCeilingUsd: 100 })
    expect(decision.start).toEqual(["a", "b"])
  })

  test("the fleet ceiling caps concurrent starts by summed task ceilings", () => {
    const dag = dagOf([
      { id: "a", extra: { ceilingUSD: 60 } },
      { id: "b", extra: { ceilingUSD: 60 } },
    ])
    expect(schedule(dag, CAPS).start).toEqual(["a"])
  })

  test("waiting-human tasks free capacity and ceiling", () => {
    let dag = dagOf([{ id: "a" }, { id: "b" }])
    dag = applyDecision(dag, schedule(dag, { concurrency: 1, fleetCeilingUsd: 5 }), NOW)
    dag = reportTask(
      applyDecision(dag, { start: ["a"], unblock: [], cancel: [] }, NOW),
      "a",
      { outcome: "running" },
      NOW,
    ).dag
    dag = reportTask(dag, "a", { outcome: "waiting-human", reason: "frontier approval" }, NOW).dag
    // a waits on a human: b may start despite concurrency 1 and ceiling 5.
    expect(schedule(dag, { concurrency: 1, fleetCeilingUsd: 5 }).start).toEqual(["b"])
  })
})

describe("failure policies", () => {
  test("fail (default): dependents of a failed task are cancelled with a reason", () => {
    const dag = dagOf([{ id: "a" }, { id: "b", deps: ["a"] }])
    const afterFail = runTo(dag, ["a"], "failed")
    const decision = schedule(afterFail, CAPS)
    expect(decision.cancel.map((c) => c.id)).toEqual(["b"])
    expect(decision.cancel[0]!.reason).toMatch(/a/)
  })

  test("retry(n): re-queued up to n times, then failed", () => {
    let dag = dagOf([{ id: "a", extra: { policy: { strategy: "retry", maxAttempts: 1 } } }])
    dag = runTo(dag, ["a"], "failed")
    expect(dag.tasks.a!.status).toBe("pending")
    expect(dag.tasks.a!.attempts).toBe(1)
    dag = runTo(dag, ["a"], "failed")
    expect(dag.tasks.a!.status).toBe("failed")
    expect(dag.tasks.a!.attempts).toBe(2)
  })

  test("replan: the task waits for a human with the reason recorded", () => {
    let dag = dagOf([{ id: "a", extra: { policy: { strategy: "replan" } } }])
    dag = runTo(dag, ["a"], "failed")
    expect(dag.tasks.a!.status).toBe("waiting-human")
    expect(dag.tasks.a!.reason).toMatch(/replan/i)
  })

  test("a landing conflict reopens a done task as waiting-human (#127)", () => {
    let dag = dagOf([{ id: "a" }])
    dag = runTo(dag, ["a"], "done")
    expect(dag.tasks.a!.status).toBe("done")
    const next = reportTask(dag, "a", { outcome: "waiting-human", reason: "merge conflict landing" }, NOW)
    expect(next.changed).toBe(true)
    expect(next.dag.tasks.a!.status).toBe("waiting-human")
    // After human repair the task lands as done again.
    const redone = reportTask(next.dag, "a", { outcome: "done", reason: "landed after human repair" }, NOW)
    expect(redone.changed).toBe(true)
    expect(redone.dag.tasks.a!.status).toBe("done")
  })
})

describe("determinism", () => {
  test("replaying the same events gives an identical state", () => {
    const events: Array<{ id: string; outcome: "done" | "failed" }> = [
      { id: "a", outcome: "done" },
      { id: "b", outcome: "done" },
      { id: "c", outcome: "failed" },
    ]
    const replay = () => {
      let dag = dagOf([{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }])
      for (const event of events) dag = runTo(dag, [event.id], event.outcome)
      return dag
    }
    expect(replay()).toEqual(replay())
  })

  test("property: random DAGs never start early and never exceed capacity or ceiling", () => {
    const rand = mulberry32(123123)
    for (let trial = 0; trial < 50; trial++) {
      const n = 2 + Math.floor(rand() * 6)
      const ids = Array.from({ length: n }, (_, i) => `t${i}`)
      let dag = emptyDag()
      for (const [i, id] of ids.entries()) {
        const deps = ids.slice(0, i).filter(() => rand() < 0.4)
        dag = addTask(
          dag,
          task(id, deps, {
            ceilingUSD: 1 + Math.floor(rand() * 10),
            ...(rand() < 0.3 ? { trigger: "one_success" } : {}),
          }),
        )
      }
      const concurrency = 1 + Math.floor(rand() * 3)
      const fleetCeilingUsd = 5 + Math.floor(rand() * 20)
      // Randomly complete some tasks, then check the next decision.
      const done = new Set<string>()
      for (const id of ids) {
        if (rand() < 0.3 && dag.tasks[id]!.deps.every((d) => done.has(d))) {
          dag = { ...dag, tasks: { ...dag.tasks, [id]: { ...dag.tasks[id]!, status: "done" as const } } }
          done.add(id)
        }
      }
      const running = ids.filter((id) => dag.tasks[id]!.status === "running")
      const decision = schedule(dag, { concurrency, fleetCeilingUsd })
      for (const id of decision.start) {
        const t = dag.tasks[id]!
        expect(t.status === "pending" || t.status === "ready").toBe(true)
        // A task with no deps is immediately runnable under either trigger.
        if (t.deps.length === 0) continue
        if (t.trigger === "all_success") expect(t.deps.every((d) => done.has(d))).toBe(true)
        else expect(t.deps.some((d) => done.has(d))).toBe(true)
      }
      expect(running.length + decision.start.length).toBeLessThanOrEqual(concurrency)
      const spend =
        running.reduce((sum, id) => sum + dag.tasks[id]!.ceilingUSD, 0) +
        decision.start.reduce((sum, id) => sum + dag.tasks[id]!.ceilingUSD, 0)
      expect(spend).toBeLessThanOrEqual(fleetCeilingUsd)
    }
  })
})

describe("persistence", () => {
  test("save/load round-trips under the fleet lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-fleet-dag-"))
    try {
      const dag = dagOf([{ id: "a" }, { id: "b", deps: ["a"] }])
      await saveDag(root, dag)
      expect(await loadDag(root)).toEqual(dag)
      expect(await loadDag(await mkdtemp(path.join(tmpdir(), "es-fleet-empty-")))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("markGateFailed", () => {
  test("done becomes failed with the gate reason; other statuses are unchanged", () => {
    const done = reportTask(dagOf([{ id: "a" }]), "a", { outcome: "done" }, NOW).dag
    const failed = markGateFailed(done, "a", "gates failed", NOW)
    expect(failed.changed).toBe(true)
    expect(failed.dag.tasks.a.status).toBe("failed")
    expect(failed.dag.tasks.a.reason).toBe("gates failed")
    const untouched = markGateFailed(dagOf([{ id: "a" }]), "a", "gates failed", NOW)
    expect(untouched.changed).toBe(false)
    expect(untouched.dag.tasks.a.status).toBe("pending")
  })
})

/** Deterministic PRNG (mulberry32): the seed prints on failure, no dependency. */
function mulberry32(seed: number) {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Keep TaskSchema imported for the schema-level tests elsewhere.
void TaskSchema
