// Watch dashboard rendering (#126): pure text over a snapshot and events.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FleetSnapshot } from "../src/telemetry.ts"
import { readFleetSnapshot, renderDashboard } from "../src/watch.ts"

const snapshot: FleetSnapshot = {
  daemon: { running: true, pid: 4242, maxUsd: 50, concurrency: 2 },
  tasks: [
    { id: "a", title: "Alpha", status: "running", ceilingUSD: 5, spendUsd: 1.25, deps: [], reason: "building" },
    {
      id: "b",
      title: "Beta",
      status: "waiting-human",
      ceilingUSD: 5,
      spendUsd: 0,
      deps: ["a"],
      reason: "frontier approval",
    },
  ],
  spendUsd: 1.25,
  pending: [{ taskId: "b", reason: "frontier approval" }],
}

describe("dashboard rendering", () => {
  test("one frame shows the headline, tasks, pending and recent events", () => {
    const frame = renderDashboard(snapshot, [
      { seq: 7, at: "2026-10-09T12:00:00.000Z", type: "changed", payload: { taskId: "a", kind: "started" } },
    ])
    expect(frame).toContain("4242")
    expect(frame).toContain("$1.25 / $50")
    expect(frame).toContain("a")
    expect(frame).toContain("running")
    expect(frame).toContain("Waiting on a human:")
    expect(frame).toContain("b: frontier approval")
    expect(frame).toContain("#7 changed")
  })

  test("a stopped fleet with no tasks renders plainly", () => {
    const frame = renderDashboard(
      { daemon: { running: false, pid: null, maxUsd: null, concurrency: 4 }, tasks: [], spendUsd: 0, pending: [] },
      [],
    )
    expect(frame).toContain("Fleet stopped.")
    expect(frame).toContain("No tasks.")
  })

  test("readFleetSnapshot folds the DAG and daemon state", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-snap-"))
    try {
      const { addTask, emptyDag, saveDag } = await import("../src/tasks.ts")
      const { reportTask } = await import("../src/scheduler.ts")
      let dag = addTask(emptyDag(), {
        id: "a",
        title: "a",
        kind: "factory-run",
        input: { objective: "x" },
        ceilingUSD: 5,
        createdAt: "2026-10-09T12:00:00.000Z",
        updatedAt: "2026-10-09T12:00:00.000Z",
      })
      dag = reportTask(dag, "a", { outcome: "waiting-human", reason: "frontier" }, "2026-10-09T12:00:00.000Z").dag
      await saveDag(state, dag)
      const read = await readFleetSnapshot(state)
      expect(read.daemon.running).toBe(false)
      expect(read.tasks).toHaveLength(1)
      expect(read.pending).toEqual([{ taskId: "a", reason: "frontier" }])
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})
