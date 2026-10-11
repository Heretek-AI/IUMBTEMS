// Fleet two-task DAG via a FAKE driver (#206, audit-tester): ordering,
// concurrency/fleet ceilings, worktree isolation and the failure-policy
// retry path, all through the real FleetDaemon tick loop with stubbed worker
// supervision (daemon.test.ts fake-spawner pattern). No workers are spawned,
// no testkit host is booted, no `es-fleet` verb runs: `run()` exits at once
// without reporting (so the supervisor untracks, like a process exit) and
// reports are folded manually, so every transition is daemon-owned.
//
// The issue's literal ask (testkit host as the opencode driver with real
// workers) is NEEDS HUMAN / UNPROVABLE-HERE: it requires launching headless
// runs, which is human-only and spend-bearing, so this suite proves the same
// DAG properties with a fake driver instead. The real-host variant already
// exists as packages/fleet/test/integration.test.ts (cases 1-2).
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { git as coreGit } from "@heretek-ai/es-core"
import { FleetDaemon, type WorkerPort } from "../src/daemon.ts"
import type { TaskReport } from "../src/scheduler.ts"
import { addTask, emptyDag, loadDag, saveDag } from "../src/tasks.ts"
import { buildWorkerArgv, type WorkerOutcome, type WorkerSpec } from "../src/worker.ts"
import { fleetBranch, fleetWorktreeDir, loadRegistry } from "../src/worktree.ts"

const STAMP = "2026-10-09T12:00:00.000Z"

const taskInput = (id: string, deps: string[] = [], extra: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  kind: "factory-run" as const,
  deps,
  input: { objective: `do ${id}` },
  ceilingUSD: 5,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "es-fleet-206-"))
  const state = await mkdtemp(path.join(tmpdir(), "es-fleet-206-state-"))
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
  readonly specs: Map<string, WorkerSpec>
  readonly stopped: string[]
  readonly spawner: (spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void) => WorkerPort
}

/** Stubbed supervision: records launches, exits without reporting (so the
 * supervisor untracks, exactly like a worker process exiting), never spawns.
 * DAG transitions stay manual via foldReport, keeping every assertion
 * daemon-owned and spend-free. */
const fakeSpawner = (outcomes: Record<string, WorkerOutcome["status"]> = {}): Fake => {
  const started: string[] = []
  const specs = new Map<string, WorkerSpec>()
  const stopped: string[] = []
  return {
    started,
    specs,
    stopped,
    spawner: (spec) => {
      started.push(spec.taskId)
      specs.set(spec.taskId, spec)
      const status = outcomes[spec.taskId] ?? "done"
      return {
        run: () => Promise.resolve({ status, spendUsd: 0 }),
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

const daemonFor = (
  root: string,
  state: string,
  fake: Fake,
  extra: { concurrency?: number; fleetCeilingUsd?: number } = {},
): FleetDaemon =>
  new FleetDaemon({
    repoRoot: root,
    stateRoot: state,
    esBin: "/stub/es.js",
    concurrency: extra.concurrency,
    fleetCeilingUsd: extra.fleetCeilingUsd ?? 100,
    checkGates: gatesOk,
    spawnWorker: fake.spawner,
  })

describe("two-task DAG ordering, isolation and landing (fake driver, #206)", () => {
  test("b starts only after a is done; each task lands from its own worktree; base stable", async () => {
    const { root, state, base, cleanup } = await fixture()
    try {
      let dag = addTask(emptyDag(), taskInput("a206-a"), STAMP)
      dag = addTask(dag, taskInput("a206-b", ["a206-a"]), STAMP)
      await saveDag(state, dag)
      const fake = fakeSpawner()
      const daemon = daemonFor(root, state, fake)

      await daemon.tick()
      // Ordering: only the dep-free task launches; the dependent stays pending.
      expect(fake.started).toEqual(["a206-a"])
      expect((await loadDag(state))?.tasks["a206-a"]?.status).toBe("running")
      expect((await loadDag(state))?.tasks["a206-b"]?.status).toBe("pending")
      // Stubbed supervision: a second tick never double-starts the live task.
      await daemon.tick()
      expect(fake.started).toEqual(["a206-a"])

      // The worker reports done; the next tick lands a and starts b.
      await daemon.foldReport("a206-a", { outcome: "done", spendUsd: 1 })
      await daemon.tick()
      expect((await loadDag(state))?.tasks["a206-a"]?.status).toBe("done")
      expect((await loadDag(state))?.tasks["a206-b"]?.status).toBe("running")
      expect(fake.started).toEqual(["a206-a", "a206-b"])

      // Worktree isolation: distinct dirs, distinct branches, distinct records.
      const dirA = fake.specs.get("a206-a")!.worktreeDir
      const dirB = fake.specs.get("a206-b")!.worktreeDir
      expect(dirA).toBe(fleetWorktreeDir(root, "a206-a"))
      expect(dirB).toBe(fleetWorktreeDir(root, "a206-b"))
      expect(dirA).not.toBe(dirB)
      expect(fleetBranch("a206-a")).not.toBe(fleetBranch("a206-b"))
      const registry = (await loadRegistry(state))!
      expect(registry.worktrees["a206-a"]?.dir).toBe(dirA)
      expect(registry.worktrees["a206-b"]?.dir).toBe(dirB)
      expect(registry.worktrees["a206-a"]?.branch).toBe("fleet/a206-a")
      expect(registry.worktrees["a206-b"]?.branch).toBe("fleet/a206-b")

      await daemon.foldReport("a206-b", { outcome: "done", spendUsd: 1 })
      await daemon.tick()
      expect((await loadDag(state))?.tasks["a206-b"]?.status).toBe("done")
      expect((await loadRegistry(state))?.worktrees["a206-a"]?.status).toBe("merged")
      expect((await loadRegistry(state))?.worktrees["a206-b"]?.status).toBe("merged")
      // Both tasks landed on the integration branch; the base never moves.
      const integration = (await coreGit(root, ["rev-parse", "fleet/integration/fleet"])).stdout.trim()
      expect(integration.length).toBe(40)
      expect((await coreGit(root, ["rev-parse", "main"])).stdout.trim()).toBe(base)
    } finally {
      await cleanup()
    }
  })

  test("parallel tasks hold simultaneous isolated allocations", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      let dag = addTask(emptyDag(), taskInput("a206-p"), STAMP)
      dag = addTask(dag, taskInput("a206-q"), STAMP)
      await saveDag(state, dag)
      const fake = fakeSpawner()
      const daemon = daemonFor(root, state, fake, { concurrency: 2 })
      await daemon.tick()
      // Both launch together and both hold an allocation at once.
      expect(fake.started).toEqual(["a206-p", "a206-q"])
      const registry = (await loadRegistry(state))!
      expect(registry.worktrees["a206-p"]?.status).toBe("allocated")
      expect(registry.worktrees["a206-q"]?.status).toBe("allocated")
      expect(registry.worktrees["a206-p"]?.dir).not.toBe(registry.worktrees["a206-q"]?.dir)
      expect(registry.worktrees["a206-p"]?.branch).not.toBe(registry.worktrees["a206-q"]?.branch)
    } finally {
      await cleanup()
    }
  })
})

describe("ceilings through the daemon (fake driver, #206)", () => {
  test("concurrency 1 serializes two independent tasks in id order", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      let dag = addTask(emptyDag(), taskInput("a206-c1"), STAMP)
      dag = addTask(dag, taskInput("a206-c2"), STAMP)
      await saveDag(state, dag)
      const fake = fakeSpawner()
      const daemon = daemonFor(root, state, fake, { concurrency: 1 })
      await daemon.tick()
      expect(fake.started).toEqual(["a206-c1"])
      await daemon.tick()
      expect(fake.started).toEqual(["a206-c1"])
      await daemon.foldReport("a206-c1", { outcome: "done", spendUsd: 1 })
      await daemon.tick()
      expect(fake.started).toEqual(["a206-c1", "a206-c2"])
      expect((await loadDag(state))?.tasks["a206-c2"]?.status).toBe("running")
    } finally {
      await cleanup()
    }
  })

  test("the fleet ceiling admits one 60-USD task of two under a 100-USD ceiling", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      let dag = addTask(emptyDag(), taskInput("a206-d1", [], { ceilingUSD: 60 }), STAMP)
      dag = addTask(dag, taskInput("a206-d2", [], { ceilingUSD: 60 }), STAMP)
      await saveDag(state, dag)
      const fake = fakeSpawner()
      const daemon = daemonFor(root, state, fake, { fleetCeilingUsd: 100 })
      await daemon.tick()
      expect(fake.started).toEqual(["a206-d1"])
      expect((await loadDag(state))?.tasks["a206-d2"]?.status).not.toBe("running")
      await daemon.foldReport("a206-d1", { outcome: "done", spendUsd: 1 })
      await daemon.tick()
      // d1's ceiling frees on completion, so d2 launches next.
      expect(fake.started).toEqual(["a206-d1", "a206-d2"])
    } finally {
      await cleanup()
    }
  })
})

describe("failure-policy retry path through the daemon (fake driver, #206)", () => {
  test("retry(1) re-queues once, then fails and cancels the dependent with a reason", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      let dag = addTask(emptyDag(), taskInput("a206-f", [], { policy: { strategy: "retry", maxAttempts: 1 } }), STAMP)
      dag = addTask(dag, taskInput("a206-g", ["a206-f"]), STAMP)
      await saveDag(state, dag)
      const fake = fakeSpawner({ "a206-f": "failed" })
      const daemon = daemonFor(root, state, fake)

      await daemon.tick()
      expect(fake.started).toEqual(["a206-f"])
      expect((await loadDag(state))?.tasks["a206-f"]?.attempts).toBe(1)

      // First failure re-queues: pending with attempts intact, dependent held.
      await daemon.foldReport("a206-f", { outcome: "failed", reason: "flake" })
      expect((await loadDag(state))?.tasks["a206-f"]?.status).toBe("pending")
      expect((await loadDag(state))?.tasks["a206-f"]?.attempts).toBe(1)

      // The retry relaunches the same task (stubbed supervision tracks it anew).
      await daemon.tick()
      expect(fake.started).toEqual(["a206-f", "a206-f"])
      expect((await loadDag(state))?.tasks["a206-f"]?.attempts).toBe(2)

      // Second failure is terminal; the dependent cancels naming the failed dep.
      await daemon.foldReport("a206-f", { outcome: "failed", reason: "still broken" })
      expect((await loadDag(state))?.tasks["a206-f"]?.status).toBe("failed")
      await daemon.tick()
      const final = (await loadDag(state))!
      expect(final.tasks["a206-g"]?.status).toBe("cancelled")
      expect(final.tasks["a206-g"]?.reason).toMatch(/a206-f/)
      expect(fake.started).not.toContain("a206-g")
    } finally {
      await cleanup()
    }
  })
})

describe("fake driver argv without spawning (fake driver, #206)", () => {
  test("each task's headless argv is argv-only, worktree-scoped, ceiling-free, and nothing spawns", async () => {
    const { root, state, cleanup } = await fixture()
    try {
      await saveDag(state, addTask(emptyDag(), taskInput("a206-a"), STAMP))
      const fake = fakeSpawner()
      void daemonFor(root, state, fake)
      for (const id of ["a206-a", "a206-b"]) {
        const argv = buildWorkerArgv({
          taskId: id,
          worktreeDir: fleetWorktreeDir(root, id),
          ceilingUSD: 5,
          kind: "factory-run",
          objective: `do ${id}`,
          esBin: "/stub/es.js",
        })
        expect(argv[0]).toBe("/stub/es.js")
        expect(argv).toContain("factory")
        expect(argv).toContain("run")
        expect(argv).toContain("--headless")
        expect(argv).toContain("--events")
        expect(argv).toContain("jsonl")
        expect(argv).toContain("--cwd")
        expect(argv[argv.indexOf("--cwd") + 1]).toBe(fleetWorktreeDir(root, id))
        // No --max-usd: the ceiling is provisioned into run state, never a flag.
        expect(argv).not.toContain("--max-usd")
        // argv-only: one string array, never joined through a shell.
        expect(argv.every((word) => typeof word === "string")).toBe(true)
      }
      // Proof nothing launched: the stubbed supervisor recorded zero starts.
      expect(fake.started).toEqual([])
    } finally {
      await cleanup()
    }
  })
})
