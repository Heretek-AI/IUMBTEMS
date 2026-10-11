// Fleet process orchestrator (#161): a roadmap.json file drives a multi-phase
// task DAG through the real FleetDaemon tick loop with a fake driver (no
// workers spawn, nothing spends). The daemon records heartbeats in
// `.factory/runtime/fleet.json` and restarts stuck turns.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { git as coreGit } from "@heretek-ai/es-core"
import { FleetDaemon, type WorkerPort } from "../src/daemon.ts"
import { loadFleetHeartbeat } from "../src/heartbeat.ts"
import { loadRoadmapFile, runDag } from "../src/run-dag.ts"
import type { TaskReport } from "../src/scheduler.ts"
import { addTask, emptyDag, loadDag, saveDag } from "../src/tasks.ts"
import type { WorkerOutcome, WorkerSpec } from "../src/worker.ts"

const STAMP = "2026-10-11T00:00:00.000Z"

const ROADMAP = {
  version: 1,
  dagId: "fleet",
  title: "three phases, no human",
  tasks: [
    {
      id: "phase-a",
      title: "phase a",
      kind: "factory-run",
      input: { objective: "do a" },
      ceilingUSD: 5,
    },
    {
      id: "phase-b",
      title: "phase b",
      kind: "factory-run",
      deps: ["phase-a"],
      input: { objective: "do b" },
      ceilingUSD: 5,
    },
    {
      id: "phase-c",
      title: "phase c",
      kind: "factory-run",
      deps: ["phase-b"],
      input: { objective: "do c" },
      ceilingUSD: 5,
    },
  ],
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "es-fleet-161-"))
  const state = await mkdtemp(path.join(tmpdir(), "es-fleet-161-state-"))
  const git = (args: string[], cwd = root) => coreGit(cwd, args)
  await git(["init", "-b", "main"])
  await git(["config", "user.name", "fleet-test"])
  await git(["config", "user.email", "fleet@test.local"])
  await git(["config", "commit.gpgsign", "false"])
  await writeFile(path.join(root, "file.txt"), "base\n")
  await git(["add", "-A"])
  await git(["commit", "--no-verify", "-m", "base"])
  return {
    root,
    state,
    cleanup: () =>
      Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]).then(
        () => undefined,
      ),
  }
}

/** Fake model driver: `run()` reports the outcome through the daemon callback, like a headless run would. */
const fakeDriver = (started: string[], outcomes: Record<string, WorkerOutcome["status"]> = {}, spendUsd = 1) => {
  const spawner = (spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void): WorkerPort => {
    started.push(spec.taskId)
    const status = outcomes[spec.taskId] ?? "done"
    return {
      run: async () => {
        if (status === "done") onReport(spec.taskId, { outcome: "done", spendUsd })
        else if (status === "waiting-human")
          onReport(spec.taskId, { outcome: "waiting-human", reason: "fake driver waits" })
        else onReport(spec.taskId, { outcome: "failed", reason: `fake ${status}`, spendUsd })
        return { status, spendUsd }
      },
      stop: () => Promise.resolve(),
      snapshot: () => ({ taskId: spec.taskId, pid: -1, spendUsd: 0, tokensIn: 0, tokensOut: 0 }),
    }
  }
  return spawner
}

const gatesOk = () => Promise.resolve({ ok: true as const })

describe("roadmap loading (#161)", () => {
  test("a three-phase roadmap file loads to a validated DAG", async () => {
    const { root, cleanup } = await fixture()
    try {
      const file = path.join(root, "roadmap.json")
      await writeFile(file, JSON.stringify(ROADMAP))
      const { dagId, dag } = await loadRoadmapFile(file, STAMP)
      expect(dagId).toBe("fleet")
      expect(Object.keys(dag.tasks).sort()).toEqual(["phase-a", "phase-b", "phase-c"])
      expect(dag.tasks["phase-c"]!.deps).toEqual(["phase-b"])
    } finally {
      await cleanup()
    }
  })

  test("unknown deps and cycles are refused", async () => {
    const { root, cleanup } = await fixture()
    try {
      const badDep = path.join(root, "bad-dep.json")
      await writeFile(badDep, JSON.stringify({ ...ROADMAP, tasks: [{ ...ROADMAP.tasks[0], deps: ["ghost"] }] }))
      await expect(loadRoadmapFile(badDep, STAMP)).rejects.toThrow(/unknown task/)
      const cycle = path.join(root, "cycle.json")
      await writeFile(
        cycle,
        JSON.stringify({
          ...ROADMAP,
          tasks: [
            { ...ROADMAP.tasks[0], id: "x", deps: ["y"] },
            { ...ROADMAP.tasks[1], id: "y", deps: ["x"] },
          ],
        }),
      )
      await expect(loadRoadmapFile(cycle, STAMP)).rejects.toThrow(/cycle/)
    } finally {
      await cleanup()
    }
  })
})

describe("daemon-driven DAG without human intervention (#161)", () => {
  test("three phases run to done in dependency order from one roadmap file", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      const file = path.join(root, "roadmap.json")
      await writeFile(file, JSON.stringify(ROADMAP))
      const started: string[] = []
      const final = await runDag({
        repoRoot: root,
        stateRoot: state,
        esBin: "/stub/es.js",
        roadmapFile: file,
        fleetCeilingUsd: 100,
        checkGates: gatesOk,
        spawnWorker: fakeDriver(started),
      })
      expect(started).toEqual(["phase-a", "phase-b", "phase-c"])
      expect(final.tasks["phase-a"]?.status).toBe("done")
      expect(final.tasks["phase-b"]?.status).toBe("done")
      expect(final.tasks["phase-c"]?.status).toBe("done")
      // The base branch never moves; every phase lands on the integration branch.
      expect((await coreGit(root, ["rev-parse", "main"])).stdout.trim().length).toBe(40)
      expect((await coreGit(root, ["rev-parse", "fleet/integration/fleet"])).stdout.trim().length).toBe(40)
      const persisted = (await loadDag(state))!
      expect(persisted.tasks["phase-c"]?.status).toBe("done")
    } finally {
      await cleanup()
    }
  })

  test("the daemon records heartbeats in .factory/runtime/fleet.json", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      const file = path.join(root, "roadmap.json")
      await writeFile(file, JSON.stringify(ROADMAP))
      const started: string[] = []
      await runDag({
        repoRoot: root,
        stateRoot: state,
        esBin: "/stub/es.js",
        roadmapFile: file,
        fleetCeilingUsd: 100,
        checkGates: gatesOk,
        spawnWorker: fakeDriver(started),
      })
      const raw = await readFile(path.join(root, ".factory", "runtime", "fleet.json"), "utf8")
      const heartbeat = loadFleetHeartbeat(JSON.parse(raw))
      expect(heartbeat.pid).toBe(process.pid)
      expect(heartbeat.tasks["phase-a"]?.status).toBe("done")
      expect(heartbeat.tasks["phase-c"]?.status).toBe("done")
      expect(Date.parse(heartbeat.at)).not.toBeNaN()
    } finally {
      await cleanup()
    }
  })

  test("a waiting-human task stops the run without human intervention", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      const file = path.join(root, "roadmap.json")
      await writeFile(
        file,
        JSON.stringify({ ...ROADMAP, tasks: [ROADMAP.tasks[0], { ...ROADMAP.tasks[1], id: "phase-w" }] }),
      )
      const started: string[] = []
      const final = await runDag({
        repoRoot: root,
        stateRoot: state,
        esBin: "/stub/es.js",
        roadmapFile: file,
        fleetCeilingUsd: 100,
        checkGates: gatesOk,
        spawnWorker: fakeDriver(started, { "phase-w": "waiting-human" }),
      })
      expect(final.tasks["phase-w"]?.status).toBe("waiting-human")
    } finally {
      await cleanup()
    }
  })
})

describe("stuck-turn restart (#161)", () => {
  /** Silent driver: launches but never reports, like a wedged headless run. */
  const silentDriver =
    (taskId: string) =>
    (_spec: WorkerSpec, _onReport: (taskId: string, report: TaskReport) => void): WorkerPort => ({
      run: () => new Promise<WorkerOutcome>(() => {}),
      stop: () => Promise.resolve(),
      snapshot: () => ({ taskId, pid: -1, spendUsd: 0, tokensIn: 0, tokensOut: 0 }),
    })

  const stuckDaemonFor = (
    root: string,
    state: string,
    spawner: (spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void) => WorkerPort,
    now: () => number,
  ): FleetDaemon =>
    new FleetDaemon({
      repoRoot: root,
      stateRoot: state,
      esBin: "/stub/es.js",
      fleetCeilingUsd: 100,
      checkGates: gatesOk,
      spawnWorker: spawner,
      stuckTimeoutMs: 60_000,
      now,
    })

  const saveStuckTask = async (state: string, id: string, extra: Record<string, unknown> = {}) => {
    await saveDag(
      state,
      addTask(
        emptyDag(),
        {
          id,
          title: id,
          kind: "factory-run",
          input: { objective: `do ${id}` },
          ceilingUSD: 5,
          createdAt: STAMP,
          updatedAt: STAMP,
          ...extra,
        },
        STAMP,
      ),
    )
  }

  test("a turn with no worker progress past the stuck timeout is failed for restart", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      let nowMs = Date.parse(STAMP)
      const daemon = stuckDaemonFor(root, state, silentDriver("stuck-a"), () => nowMs)
      await saveStuckTask(state, "stuck-a")
      await daemon.tick()
      expect((await loadDag(state))?.tasks["stuck-a"]?.status).toBe("running")
      // No progress for over the timeout: the next tick restarts the turn.
      nowMs += 61_000
      await daemon.tick()
      const task = (await loadDag(state))?.tasks["stuck-a"]
      expect(task?.status).toBe("failed")
      expect(task?.reason).toMatch(/stuck turn/)
      await daemon.shutdown()
    } finally {
      await cleanup()
    }
  })

  test("a stuck turn under a retry policy is re-queued, not failed", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      let nowMs = Date.parse(STAMP)
      const daemon = stuckDaemonFor(root, state, silentDriver("stuck-r"), () => nowMs)
      await saveStuckTask(state, "stuck-r", { policy: { strategy: "retry", maxAttempts: 2 } })
      await daemon.tick()
      nowMs += 61_000
      await daemon.tick()
      const task = (await loadDag(state))?.tasks["stuck-r"]
      expect(task?.status).toBe("pending")
      expect(task?.reason).toMatch(/stuck turn/)
      await daemon.shutdown()
    } finally {
      await cleanup()
    }
  })

  test("a restarted turn's late settlement does not disturb the relaunch", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      let nowMs = Date.parse(STAMP)
      let attempts = 0
      let resolveFirst: ((outcome: WorkerOutcome) => void) | undefined
      const spawner = (spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void): WorkerPort => {
        attempts += 1
        if (attempts === 1) {
          // First attempt wedges: run() only settles when the test says so.
          return {
            run: () =>
              new Promise<WorkerOutcome>((resolve) => {
                resolveFirst = resolve
              }),
            stop: () => Promise.resolve(),
            snapshot: () => ({ taskId: spec.taskId, pid: -1, spendUsd: 0, tokensIn: 0, tokensOut: 0 }),
          }
        }
        return {
          run: async () => {
            onReport(spec.taskId, { outcome: "done", spendUsd: 1 })
            return { status: "done" as const, spendUsd: 1 }
          },
          stop: () => Promise.resolve(),
          snapshot: () => ({ taskId: spec.taskId, pid: -1, spendUsd: 0, tokensIn: 0, tokensOut: 0 }),
        }
      }
      const daemon = stuckDaemonFor(root, state, spawner, () => nowMs)
      await saveStuckTask(state, "stuck-l", { policy: { strategy: "retry", maxAttempts: 2 } })
      await daemon.tick()
      nowMs += 61_000
      await daemon.tick()
      expect((await loadDag(state))?.tasks["stuck-l"]?.status).toBe("pending")
      // Relaunch reports done; then the wedged first attempt settles late.
      await daemon.tick()
      // The report folds through an async callback after the tick releases
      // its lock: let it land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect((await loadDag(state))?.tasks["stuck-l"]?.status).toBe("done")
      resolveFirst?.({ status: "failed", reason: "late crash", spendUsd: 0 })
      await new Promise((resolve) => setTimeout(resolve, 20))
      await daemon.tick()
      const task = (await loadDag(state))?.tasks["stuck-l"]
      expect(task?.status).toBe("done")
      expect(task?.reason ?? "").not.toMatch(/late crash/)
      await daemon.shutdown()
    } finally {
      await cleanup()
    }
  })
})
