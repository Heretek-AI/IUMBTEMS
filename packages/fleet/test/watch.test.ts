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
  pending: [{ taskId: "b", reason: "frontier approval", stage: "frontier" }],
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
      // No worktree registry: the task reads waiting-human, but no stage is
      // actionable, so the pending list stays empty.
      const bare = await readFleetSnapshot(state)
      expect(bare.daemon.running).toBe(false)
      expect(bare.tasks).toHaveLength(1)
      expect(bare.pending).toEqual([])
      // With a registry pointing at a worktree that holds a pending
      // frontier, the pair becomes an actionable approval.
      const { writeJson, factoryLayout } = await import("@heretek-ai/es-core")
      const { fleetPaths } = await import("../src/state.ts")
      const { mkdir, writeFile } = await import("node:fs/promises")
      const repo = await mkdtemp(path.join(tmpdir(), "es-fleet-snap-repo-"))
      try {
        await mkdir(path.join(repo, ".factory", "runtime"), { recursive: true })
        await writeJson(factoryLayout(repo).pending, [
          { stage: "frontier", requestedBy: "factory", at: new Date().toISOString() },
        ])
        await mkdir(fleetPaths(state).dir, { recursive: true })
        await writeFile(
          fleetPaths(state).worktrees,
          JSON.stringify({
            v: 1,
            worktrees: {
              a: {
                taskId: "a",
                dir: repo,
                branch: "fleet/a",
                base: "0".repeat(40),
                createdAt: new Date().toISOString(),
                status: "allocated",
              },
            },
          }),
        )
        const read = await readFleetSnapshot(state)
        expect(read.pending).toEqual([{ taskId: "a", reason: "frontier", stage: "frontier" }])
      } finally {
        await rm(repo, { recursive: true, force: true })
      }
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})
