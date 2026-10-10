// Daemon loop (#125): schedule → allocate → launch → report → land →
// release, with injected spawning and gates, on a real temp git repo.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { git as coreGit } from "@heretek-ai/es-core"
import { FleetDaemon, type TransitionEvent, type WorkerPort } from "../src/daemon.ts"
import type { TaskReport } from "../src/scheduler.ts"
import { addTask, emptyDag, loadDag, saveDag } from "../src/tasks.ts"
import type { WorkerOutcome, WorkerSpec } from "../src/worker.ts"
import { loadRegistry } from "../src/worktree.ts"

const STAMP = "2026-10-09T12:00:00.000Z"
const taskInput = (id: string, deps: string[] = []) => ({
  id,
  title: `task ${id}`,
  kind: "factory-run" as const,
  deps,
  input: { objective: `do ${id}` },
  ceilingUSD: 5,
  createdAt: STAMP,
  updatedAt: STAMP,
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "es-fleet-daemon-"))
  const state = await mkdtemp(path.join(tmpdir(), "es-fleet-daemon-state-"))
  const git = (args: string[], cwd = root) => coreGit(cwd, args)
  await git(["init", "-b", "main"])
  await git(["config", "user.name", "fleet-test"])
  await git(["config", "user.email", "fleet@test.local"])
  await git(["config", "commit.gpgsign", "false"])
  await writeFile(path.join(root, "file.txt"), "base\n")
  await git(["add", "-A"])
  await git(["commit", "--no-verify", "-m", "base"])
  const base = (await git(["rev-parse", "HEAD"])).stdout.trim()
  return {
    root,
    state,
    base,
    cleanup: () =>
      Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]).then(
        () => undefined,
      ),
  }
}

interface Fake {
  readonly started: string[]
  readonly stopped: string[]
  readonly reporters: Map<string, (report: TaskReport) => void>
  readonly spawner: (spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void) => WorkerPort
}

const fakeSpawner = (): Fake => {
  const started: string[] = []
  const stopped: string[] = []
  const reporters = new Map<string, (report: TaskReport) => void>()
  return {
    started,
    stopped,
    reporters,
    spawner: (spec, onReport) => {
      started.push(spec.taskId)
      reporters.set(spec.taskId, (report) => onReport(spec.taskId, report))
      return {
        run: () => new Promise<WorkerOutcome>(() => {}),
        stop: () => {
          stopped.push(spec.taskId)
          return Promise.resolve()
        },
        snapshot: () => ({ taskId: spec.taskId, pid: -1, spendUsd: 0, tokensIn: 0, tokensOut: 0 }),
      }
    },
  }
}

const gatesOk = () => Promise.resolve({ ok: true as const })

describe("daemon tick", () => {
  test("a one-task DAG runs to landed and released, base stable", async () => {
    const { root, state, base, cleanup } = await fixture()
    try {
      await saveDag(state, addTask(emptyDag(), taskInput("a"), STAMP))
      const events: TransitionEvent[] = []
      const fake = fakeSpawner()
      const daemon = new FleetDaemon({
        repoRoot: root,
        stateRoot: state,
        esBin: "/stub/es.js",
        fleetCeilingUsd: 100,
        checkGates: gatesOk,
        spawnWorker: fake.spawner,
        onTransition: (event) => void events.push(event),
      })
      await daemon.tick()
      expect(fake.started).toEqual(["a"])
      expect((await loadDag(state))?.tasks.a.status).toBe("running")
      expect((await loadRegistry(state))?.worktrees.a.status).toBe("allocated")
      // The worker reports done; the next tick lands and releases.
      await daemon.foldReport("a", { outcome: "done", spendUsd: 1 })
      await daemon.tick()
      expect((await loadDag(state))?.tasks.a.status).toBe("done")
      expect((await loadRegistry(state))?.worktrees.a.status).toBe("merged")
      const integration = (await coreGit(root, ["rev-parse", "fleet/integration/fleet"])).stdout.trim()
      expect(integration.length).toBe(40)
      expect((await coreGit(root, ["rev-parse", "main"])).stdout.trim()).toBe(base)
      expect(events.map((event) => event.type)).toContain("started")
      expect(events.map((event) => event.type)).toContain("released")
    } finally {
      await cleanup()
    }
  })

  test("shutdown stops workers and records resumable cancellations", async () => {
    const { root, state, base, cleanup } = await fixture()
    try {
      await saveDag(state, addTask(emptyDag(), taskInput("a"), STAMP))
      const fake = fakeSpawner()
      const daemon = new FleetDaemon({
        repoRoot: root,
        stateRoot: state,
        esBin: "/stub/es.js",
        fleetCeilingUsd: 100,
        checkGates: gatesOk,
        spawnWorker: fake.spawner,
      })
      await daemon.tick()
      expect(fake.started).toEqual(["a"])
      await daemon.shutdown()
      expect(fake.stopped).toEqual(["a"])
      const dag = (await loadDag(state))!
      expect(dag.tasks.a.status).toBe("cancelled")
      expect(dag.tasks.a.reason).toMatch(/resumable/)
      expect((await coreGit(root, ["rev-parse", "main"])).stdout.trim()).toBe(base)
    } finally {
      await cleanup()
    }
  })

  test("recover marks dead runs failed and reattaches live ones", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      let dag = addTask(emptyDag(), taskInput("a"), STAMP)
      dag = addTask(dag, taskInput("b"), STAMP)
      await saveDag(state, dag)
      const daemon = new FleetDaemon({
        repoRoot: root,
        stateRoot: state,
        esBin: "/stub/es.js",
        fleetCeilingUsd: 100,
        checkGates: gatesOk,
        spawnWorker: fakeSpawner().spawner,
      })
      await daemon.recover([
        { taskId: "a", pid: 1073741824 },
        { taskId: "b", pid: process.pid },
      ])
      const next = (await loadDag(state))!
      expect(next.tasks.a.status).toBe("failed")
      expect(next.tasks.a.reason).toMatch(/daemon restarted/i)
      // b reattached to its live run: unblocked to ready but never spawned twice.
      await daemon.tick()
      expect((await loadDag(state))?.tasks.b.status).toBe("ready")
    } finally {
      await cleanup()
    }
  })

  test("a gate failure marks the task failed and moves no branch", async () => {
    const { root, state, base, cleanup } = await fixture()
    try {
      await saveDag(state, addTask(emptyDag(), taskInput("a"), STAMP))
      const daemon = new FleetDaemon({
        repoRoot: root,
        stateRoot: state,
        esBin: "/stub/es.js",
        fleetCeilingUsd: 100,
        checkGates: () => Promise.resolve({ ok: false as const, reason: "test gate failure" }),
        spawnWorker: fakeSpawner().spawner,
      })
      await daemon.tick()
      await daemon.foldReport("a", { outcome: "done", spendUsd: 1 })
      await daemon.tick()
      const dag = (await loadDag(state))!
      expect(dag.tasks.a.status).toBe("failed")
      expect(dag.tasks.a.reason).toMatch(/test gate failure/)
      const integration = await coreGit(
        root,
        ["show-ref", "--verify", "--quiet", "refs/heads/fleet/integration/fleet"],
        {
          allowFail: true,
        },
      )
      expect(integration.code).not.toBe(0)
      expect((await coreGit(root, ["rev-parse", "main"])).stdout.trim()).toBe(base)
    } finally {
      await cleanup()
    }
  })
})
