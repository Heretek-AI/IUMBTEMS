// S5.6 liveness for #130 (repair-151, feeds S7): per-task liveness computed
// in fleet with core's factory/liveness.ts, served on the bus as JSON-safe
// data exported as a *type* for the web control plane.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readTaskLiveness, type TaskLiveness } from "../src/liveness.ts"

const STATE = {
  version: 2,
  runId: "run-live-1",
  stage: "BUILD",
  mode: "build",
  createdAt: "2026-10-09T10:00:00.000Z",
  updatedAt: "2026-10-09T11:00:00.000Z",
  activePhase: "phase-1",
} as const

async function fixtureRun(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "es-fleet-live-"))
  const { mkdir } = await import("node:fs/promises")
  await mkdir(path.join(dir, ".factory", "runtime"), { recursive: true })
  await writeFile(path.join(dir, ".factory", "runtime", "state.json"), JSON.stringify(STATE))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe("readTaskLiveness (S5.6)", () => {
  test("a fixture run yields headline, stage and seat lines", async () => {
    const { dir, cleanup } = await fixtureRun()
    try {
      const live: TaskLiveness = await readTaskLiveness(dir, "task-live")
      expect(live.taskId).toBe("task-live")
      expect(live.stage).toBe("BUILD")
      expect(live.runId).toBe("run-live-1")
      expect(typeof live.headline).toBe("string")
      expect(live.headline.length).toBeGreaterThan(0)
      expect(Array.isArray(live.seats)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("a worktree without a run reports NONE", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-fleet-live-empty-"))
    try {
      const live = await readTaskLiveness(dir, "task-empty")
      expect(live.stage).toBe("NONE")
      expect(live.headline).toMatch(/no factory run/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("fleet.task.liveness bus method (S5.6)", () => {
  test("the bus returns liveness for a task with a fixture run", async () => {
    const { dir, cleanup } = await fixtureRun()
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-live-state-"))
    try {
      const { fleetPaths } = await import("../src/state.ts")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(fleetPaths(state).dir, { recursive: true })
      const base = "a".repeat(40)
      await writeFile(
        fleetPaths(state).worktrees,
        JSON.stringify({
          v: 1,
          worktrees: {
            "task-live": {
              taskId: "task-live",
              dir,
              branch: "fleet/task-live",
              base,
              createdAt: "2026-10-09T10:00:00.000Z",
              status: "allocated",
            },
          },
        }),
      )
      const { TelemetryServer } = await import("../src/telemetry.ts")
      const server = new TelemetryServer({
        stateRoot: state,
        port: 0,
        token: "t".repeat(40),
        getSnapshot: () => ({
          daemon: { running: true, pid: 1, maxUsd: 100, concurrency: 4 },
          tasks: [],
          spendUsd: 0,
          pending: [],
        }),
      })
      await server.start()
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/fleet/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${"t".repeat(40)}` },
          body: JSON.stringify({ method: "fleet.task.liveness", params: { id: "task-live" } }),
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as { result: TaskLiveness }
        expect(body.result.stage).toBe("BUILD")
        expect(body.result.headline.length).toBeGreaterThan(0)
        const missing = (await (
          await fetch(`http://127.0.0.1:${server.port}/fleet/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${"t".repeat(40)}` },
            body: JSON.stringify({ method: "fleet.task.liveness", params: { id: "ghost" } }),
          })
        ).json()) as { error: unknown }
        expect(missing.error).toBeDefined()
      } finally {
        await server.stop()
      }
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })
})
