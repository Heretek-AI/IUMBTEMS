// Fleet integration suite (#127, merge-blocking): concurrency without
// interference, proven on the real host with the fake model. One booted
// testkit host is the fleet repo: task work is scripted seat turns through
// @@CALL (real host tools, fake model) writing into real isolated git
// worktrees, driven by the real FleetDaemon tick loop, landed by the real
// gated landing, and observed over the real telemetry bus.
//
// Three cases plus two break probes:
//  1. happy DAG (A, then B and C in parallel): ordering, overlap, ownership,
//     gated merges, base stability, bus event order;
//  2. failure: error, retry(1), cancellation of dependents, merge conflict
//     repair (conflict -> waiting-human, tip stable);
//  3. cancellation and cleanup: mid-run stop, resumable record, salvage, gc.
// Probes prove the suite bites: a shared worktree and an early start both
// fail the ownership/ordering checks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { git as coreGit } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { FleetDaemon, type WorkerPort } from "../src/daemon.ts"
import type { TaskReport } from "../src/scheduler.ts"
import { addTask, type DagState, emptyDag, loadDag, saveDag } from "../src/tasks.ts"
import { type BusEvent, TelemetryServer } from "../src/telemetry.ts"
import { Worker, type WorkerOutcome, type WorkerSpec } from "../src/worker.ts"
import { loadRegistry } from "../src/worktree.ts"

const STAMP = "2026-10-09T12:00:00.000Z"
const TICK_MS = 250

const git = (cwd: string, args: string[]) => coreGit(cwd, args)
const tip = async (cwd: string, ref: string) => (await git(cwd, ["rev-parse", ref])).stdout.trim()
const tree = async (cwd: string, branch: string) =>
  (await git(cwd, ["ls-tree", "-r", "--name-only", branch])).stdout.split("\n").filter(Boolean)

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

const waitFor = async (condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, TICK_MS))
  }
}

const dagStatus = async (state: string, id: string) => (await loadDag(state))?.tasks[id]?.status

export type TurnBehavior = "ok" | "failOnce" | "failAlways" | "conflict"

/** Scripted host turn for one task: timestamp, work, write, timestamp. */
const turnPrompt = (id: string, dir: string, marks: string, behavior: TurnBehavior, attempt: number): string => {
  if (behavior === "failAlways" || (behavior === "failOnce" && attempt <= 1))
    return [
      `fleet task ${id} attempt ${attempt}`,
      `@@CALL shell {"command": "date +%s%N > ${marks}/started-${id}", "description": "mark start"}@@`,
      // Unknown tools fail the turn deterministically (shell exit codes do not).
      `@@CALL does-not-exist {"task": "${id}"}@@`,
    ].join(" ")
  const conflictStep =
    behavior === "conflict" ? ` @@CALL write {"path": "${dir}/conflict.txt", "content": "${id}\\n"}@@` : ""
  return [
    `fleet task ${id}`,
    `@@CALL shell {"command": "date +%s%N > ${marks}/started-${id}", "description": "mark start"}@@`,
    `@@CALL shell {"command": "sleep 1", "description": "do the work"}@@`,
    `@@CALL write {"path": "${dir}/out-${id}.txt", "content": "${id}\\n"}@@`,
    conflictStep,
    `@@CALL shell {"command": "date +%s%N > ${marks}/finished-${id}", "description": "mark finish"}@@`,
  ].join(" ")
}

/** Spawner driving tasks as scripted seat turns on the shared host. */
const hostSpawner = (
  h: Harness,
  marks: string,
  behaviors: Record<string, TurnBehavior> = {},
): ((spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void) => WorkerPort) => {
  const repo = h.directory
  const attempts = new Map<string, number>()
  return (spec, onReport) => {
    const rel = path.relative(repo, spec.worktreeDir)
    const behavior = behaviors[spec.taskId] ?? "ok"
    return {
      run: async (): Promise<WorkerOutcome> => {
        const attempt = (attempts.get(spec.taskId) ?? 0) + 1
        attempts.set(spec.taskId, attempt)
        const result = await h.run(turnPrompt(spec.taskId, rel, marks, behavior, attempt))
        const bad = result.tools.find((tool) => tool.status !== "completed")
        if (bad) {
          const report: TaskReport = { outcome: "failed", reason: `${bad.name}: ${bad.text.slice(0, 200)}` }
          onReport(spec.taskId, report)
          return { status: "failed", reason: report.reason, spendUsd: 0 }
        }
        // Commit the work. .factory/runtime/ is gitignored (mirroring the
        // real repo), so run state stays local; the ownership check below
        // proves no branch tree ever carries it.
        await git(spec.worktreeDir, ["add", "-A"])
        await git(spec.worktreeDir, [
          "-c",
          "user.name=fleet-test",
          "-c",
          "user.email=fleet@test.local",
          "commit",
          "--no-verify",
          "-q",
          "-m",
          `work by ${spec.taskId}`,
        ])
        onReport(spec.taskId, { outcome: "done", spendUsd: 0 })
        return { status: "done", spendUsd: 0 }
      },
      stop: () => Promise.resolve(),
      snapshot: () => ({ taskId: spec.taskId, pid: -1, spendUsd: 0, tokensIn: 0, tokensOut: 0 }),
    }
  }
}

const readNs = async (file: string): Promise<bigint> => BigInt((await readFile(file, "utf8")).trim())

/** Release every still-allocated worktree (test hermeticity between cases). */
const releaseAll = async (root: string, dagState: string): Promise<void> => {
  const { releaseWorktree } = await import("../src/worktree.ts")
  const registry = await loadRegistry(dagState)
  for (const [id, record] of Object.entries(registry?.worktrees ?? {}))
    if (record.status === "allocated") await releaseWorktree(root, dagState, id, "abandoned")
}

/** Run the daemon loop until `condition` holds (the loop stops on clear). */
const drive = async (
  daemon: FleetDaemon,
  condition: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> => {
  let lastError = ""
  const timer = setInterval(
    () =>
      void daemon.tick().catch((error) => {
        lastError = String(error).slice(0, 300)
      }),
    TICK_MS,
  )
  try {
    await daemon.tick().catch((error) => {
      lastError = String(error).slice(0, 300)
    })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await condition()) return
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}${lastError ? ` (last tick error: ${lastError})` : ""}`)
      await new Promise((resolve) => setTimeout(resolve, TICK_MS))
    }
  } finally {
    clearInterval(timer)
  }
}

const busFor = async (dagState: string): Promise<{ bus: TelemetryServer; seen: BusEvent[] }> => {
  const bus = new TelemetryServer({
    stateRoot: dagState,
    port: 0,
    token: "x".repeat(40),
    getSnapshot: () => ({
      daemon: { running: true, pid: 1, maxUsd: 100, concurrency: 4 },
      tasks: [],
      spendUsd: 0,
      pending: [],
    }),
  })
  await bus.start()
  const seen: BusEvent[] = []
  bus.log.onAppend((event) => void seen.push(event))
  return { bus, seen }
}

const daemonFor = (
  h: Harness,
  dagState: string,
  bus: TelemetryServer,
  extra: {
    behaviors?: Record<string, TurnBehavior>
    checkGates?: () => Promise<{ ok: true } | { ok: false; reason?: string }>
    spawn?: (spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void) => WorkerPort
    marks?: string
  } = {},
): FleetDaemon =>
  new FleetDaemon({
    repoRoot: h.directory,
    stateRoot: dagState,
    esBin: "es",
    fleetCeilingUsd: 100,
    checkGates: extra.checkGates ?? (() => Promise.resolve({ ok: true as const })),
    spawnWorker: extra.spawn ?? hostSpawner(h, extra.marks ?? dagState, extra.behaviors),
    onTransition: (event) => void bus.log.appendSync("changed", { taskId: event.taskId, kind: event.type }),
  })

describe("fleet integration (real host, fake model)", () => {
  let h: Harness
  let state: string
  let base = ""

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-fleet-int-state-"))
    h = await boot({
      git: true,
      script: directiveScript,
      files: {
        "README.md": "# fleet integration\n",
        // Mirror the real repo: run state and fleet checkouts never commit.
        ".gitignore": ".factory/runtime/\n.fleet/\n",
      },
    })
    base = await tip(h.directory, "HEAD")
  }, 120_000)

  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("case 1: A, then B and C in parallel, isolated and ordered", async () => {
    const root = h.directory
    const dagState = await mkdtemp(path.join(tmpdir(), "es-fleet-int-1-"))
    const marks = await mkdtemp(path.join(tmpdir(), "es-fleet-int-1-marks-"))
    try {
      let dag: DagState = emptyDag()
      dag = addTask(dag, taskInput("int1-a"), STAMP)
      dag = addTask(dag, taskInput("int1-b", ["int1-a"]), STAMP)
      dag = addTask(dag, taskInput("int1-c", ["int1-a"]), STAMP)
      await saveDag(dagState, dag)
      const { bus, seen } = await busFor(dagState)
      const daemon = daemonFor(h, dagState, bus, { marks })
      try {
        await drive(
          daemon,
          async () =>
            (await dagStatus(dagState, "int1-b")) === "done" && (await dagStatus(dagState, "int1-c")) === "done",
          90_000,
          "B and C to finish",
        )
        await drive(
          daemon,
          async () => (await loadRegistry(dagState))?.worktrees["int1-c"]?.status === "merged",
          30_000,
          "landing",
        )
      } finally {
        await bus.stop()
      }
      // Ordering from stable marks: B and C start only after A finishes...
      const [aDone, bStart, cStart, bDone, cDone] = await Promise.all(
        ["finished-int1-a", "started-int1-b", "started-int1-c", "finished-int1-b", "finished-int1-c"].map((file) =>
          readNs(path.join(marks, file)),
        ),
      )
      expect(bStart).toBeGreaterThan(aDone)
      expect(cStart).toBeGreaterThan(aDone)
      // ...and B and C overlap.
      expect(bStart).toBeLessThan(cDone)
      expect(cStart).toBeLessThan(bDone)
      // The bus agrees: A starts first, then B and C.
      const order = seen
        .filter((event) => (event.payload.kind as string) === "started")
        .map((event) => event.payload.taskId)
      expect(order[0]).toBe("int1-a")
      expect(order.slice(1).sort()).toEqual(["int1-b", "int1-c"])
      // Ownership: each branch tree carries only its own output — and never
      // run state (.factory/), which would collide across branches on landing.
      for (const id of ["int1-a", "int1-b", "int1-c"]) {
        const files = await tree(root, `fleet/${id}`)
        expect(files).toContain(`out-${id}.txt`)
        expect(files.some((file) => file.startsWith(".factory/"))).toBe(false)
        for (const other of ["int1-a", "int1-b", "int1-c"]) {
          if (other !== id) expect(files).not.toContain(`out-${other}.txt`)
        }
      }
      // Integration has every output; the base never moves.
      const landed = await tree(root, "fleet/integration/fleet")
      for (const id of ["int1-a", "int1-b", "int1-c"]) expect(landed).toContain(`out-${id}.txt`)
      expect(await tip(root, "main")).toBe(base)
    } finally {
      await rm(dagState, { recursive: true, force: true })
      await rm(marks, { recursive: true, force: true })
    }
  }, 150_000)

  test("case 2: failure, retry, cancellation of dependents, conflict repair", async () => {
    const root = h.directory
    const dagState = await mkdtemp(path.join(tmpdir(), "es-fleet-int-2-"))
    const marks = await mkdtemp(path.join(tmpdir(), "es-fleet-int-2-marks-"))
    try {
      let dag: DagState = emptyDag()
      dag = addTask(dag, taskInput("int2-f", [], { policy: { strategy: "retry", maxAttempts: 1 } }), STAMP)
      dag = addTask(dag, taskInput("int2-g", ["int2-f"]), STAMP)
      dag = addTask(dag, taskInput("int2-x", [], { policy: { strategy: "fail" } }), STAMP)
      dag = addTask(dag, taskInput("int2-y", ["int2-x"]), STAMP)
      dag = addTask(dag, taskInput("int2-p"), STAMP)
      dag = addTask(dag, taskInput("int2-q"), STAMP)
      await saveDag(dagState, dag)
      const { bus, seen } = await busFor(dagState)
      void seen
      const daemon = daemonFor(h, dagState, bus, {
        marks,
        behaviors: { "int2-f": "failOnce", "int2-x": "failAlways", "int2-p": "conflict", "int2-q": "conflict" },
      })
      try {
        await drive(
          daemon,
          async () => (await dagStatus(dagState, "int2-f")) === "done",
          90_000,
          "F to be retried to done",
        )
        await drive(daemon, async () => (await dagStatus(dagState, "int2-y")) === "cancelled", 60_000, "Y to cancel")
        await drive(
          daemon,
          async () => (await dagStatus(dagState, "int2-q")) === "waiting-human",
          90_000,
          "Q to wait on conflict",
        )
        await drive(
          daemon,
          async () => (await dagStatus(dagState, "int2-g")) === "done",
          90_000,
          "G to finish after F's retry",
        )
        await drive(
          daemon,
          async () => (await loadRegistry(dagState))?.worktrees["int2-g"]?.status === "merged",
          60_000,
          "G to land",
        )
        const final = (await loadDag(dagState))!
        // Retry(1): two attempts, then done; the dependent still runs.
        expect(final.tasks["int2-f"]?.attempts).toBe(2)
        expect(final.tasks["int2-f"]?.status).toBe("done")
        expect(final.tasks["int2-g"]?.status).toBe("done")
        // Terminal failure cancels dependents with the reason.
        expect(final.tasks["int2-x"]?.status).toBe("failed")
        expect(final.tasks["int2-y"]?.status).toBe("cancelled")
        expect(final.tasks["int2-y"]?.reason).toMatch(/int2-x/)
        // Conflict: P lands, Q waits for a human, the integration tip is stable.
        expect(final.tasks["int2-p"]?.status).toBe("done")
        expect(final.tasks["int2-q"]?.status).toBe("waiting-human")
        expect(final.tasks["int2-q"]?.reason).toMatch(/conflict/i)
        const landed = await tree(root, "fleet/integration/fleet")
        expect(landed).toContain("out-int2-f.txt")
        expect(landed).toContain("conflict.txt")
        expect(landed).not.toContain("out-int2-y.txt")
        const stableTip = await tip(root, "fleet/integration/fleet")
        await daemon.tick()
        await daemon.tick()
        expect(await tip(root, "fleet/integration/fleet")).toBe(stableTip)
        expect(await tip(root, "main")).toBe(base)
      } finally {
        await bus.stop().catch(() => undefined)
        await releaseAll(root, dagState)
      }
    } finally {
      await rm(dagState, { recursive: true, force: true })
      await rm(marks, { recursive: true, force: true })
    }
  }, 240_000)

  test("case 3: mid-run stop cancels workers, then salvage and gc clean up", async () => {
    const root = h.directory
    const dagState = await mkdtemp(path.join(tmpdir(), "es-fleet-int-3-"))
    try {
      const stubDir = await mkdtemp(path.join(tmpdir(), "es-fleet-int-3-stub-"))
      const stub = path.join(stubDir, "long.mjs")
      await writeFile(stub, `await new Promise(() => {});\n`)
      let dag: DagState = emptyDag()
      dag = addTask(dag, taskInput("int3-long"), STAMP)
      await saveDag(dagState, dag)
      const { bus } = await busFor(dagState)
      const daemon = daemonFor(h, dagState, bus, {
        spawn: (spec, onReport) =>
          new Worker({
            ...spec,
            esBin: stub,
            spawn: { command: process.execPath, args: [stub] },
            onReport,
          }),
      })
      const timer = setInterval(() => void daemon.tick().catch(() => undefined), TICK_MS)
      try {
        await daemon.tick()
        await waitFor(async () => (await dagStatus(dagState, "int3-long")) === "running", 30_000, "LONG to start")
        await daemon.shutdown()
      } finally {
        clearInterval(timer)
      }
      // The cancellation is recorded as resumable...
      const final = (await loadDag(dagState))!
      expect(final.tasks["int3-long"]?.status).toBe("cancelled")
      expect(final.tasks["int3-long"]?.reason).toMatch(/resumable/)
      // ...the abandoned work is salvaged, and gc removes the worktree.
      const { releaseWorktree, gcWorktrees } = await import("../src/worktree.ts")
      await releaseWorktree(root, dagState, "int3-long", "abandoned")
      const salvage = await tip(root, "refs/fleet-salvage/int3-long")
      expect(salvage.length).toBe(40)
      const report = await gcWorktrees(root, dagState)
      expect(report.removed).toHaveLength(0)
      const registry = await loadRegistry(dagState)
      expect(registry?.worktrees["int3-long"]?.status).toBe("abandoned")
      expect(await tip(root, "main")).toBe(base)
      await bus.stop()
      await rm(stubDir, { recursive: true, force: true })
    } finally {
      await rm(dagState, { recursive: true, force: true })
    }
  }, 120_000)

  test("case 4: a gate failure marks the task failed and moves no branch", async () => {
    const root = h.directory
    const dagState = await mkdtemp(path.join(tmpdir(), "es-fleet-int-4-"))
    const marks = await mkdtemp(path.join(tmpdir(), "es-fleet-int-4-marks-"))
    try {
      let dag: DagState = emptyDag()
      dag = addTask(dag, taskInput("int4-gated"), STAMP)
      await saveDag(dagState, dag)
      const intTip = async (): Promise<string | undefined> => {
        try {
          return await tip(root, "fleet/integration/fleet")
        } catch {
          return undefined
        }
      }
      const before = await intTip()
      const { bus } = await busFor(dagState)
      const daemon = daemonFor(h, dagState, bus, {
        marks,
        checkGates: () => Promise.resolve({ ok: false as const, reason: "int4 test gate failure" }),
      })
      try {
        await drive(daemon, async () => (await dagStatus(dagState, "int4-gated")) === "failed", 90_000, "GATED to fail")
        const final = (await loadDag(dagState))!
        expect(final.tasks["int4-gated"]?.status).toBe("failed")
        expect(final.tasks["int4-gated"]?.reason).toMatch(/int4 test gate failure/)
        expect(await intTip()).toBe(before)
        expect(await tip(root, "main")).toBe(base)
      } finally {
        await bus.stop().catch(() => undefined)
        await releaseAll(root, dagState)
      }
    } finally {
      await rm(dagState, { recursive: true, force: true })
      await rm(marks, { recursive: true, force: true })
    }
  }, 150_000)

  test("break probes: shared worktrees and early starts fail the checks", async () => {
    const root = h.directory
    // Probe 1: two tasks pointed at one worktree break output ownership.
    const shared = await tree(root, "fleet/int1-a")
    const owned = (files: string[], id: string, others: string[]) =>
      files.includes(`out-${id}.txt`) && others.every((other) => !files.includes(`out-${other}.txt`))
    expect(owned(shared, "int1-a", ["int1-b", "int1-c"])).toBe(true)
    expect(owned([...shared, "out-int1-b.txt"], "int1-a", ["int1-b", "int1-c"])).toBe(false)
    // Probe 2: a task started before its deps violates ordering.
    const { applyDecision } = await import("../src/scheduler.ts")
    let dag: DagState = emptyDag()
    dag = addTask(dag, taskInput("probe-a"), STAMP)
    dag = addTask(dag, taskInput("probe-b", ["probe-a"]), STAMP)
    const rigged = applyDecision(dag, { start: ["probe-b"], unblock: [], cancel: [] }, STAMP)
    const violations = Object.values(rigged.tasks).filter(
      (task) => task.status === "running" && !task.deps.every((dep) => rigged.tasks[dep]?.status === "done"),
    )
    expect(violations.map((task) => task.id)).toEqual(["probe-b"])
    expect(root.length).toBeGreaterThan(0)
  })
})
