// Fleet workers (#125): argv construction, event mapping, spend/token
// folding, supervision, restart recovery and the StillDown circuit breaker.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildWorkerArgv, CircuitBreaker, foldWorkerEvent, prepareTaskRun, WorkerSupervisor } from "../src/worker.ts"

const spec = (extra: Record<string, unknown> = {}) => ({
  taskId: "task-a",
  worktreeDir: "/repo/.fleet/worktrees/task-a",
  ceilingUSD: 7,
  kind: "factory-run" as const,
  objective: "build the thing",
  esBin: "/repo/packages/cli/bin/es.js",
  ...extra,
})

describe("worker argv", () => {
  test("argv-only spawn: headless factory run in the task worktree", () => {
    const argv = buildWorkerArgv(spec())
    expect(argv[0]).toBe("/repo/packages/cli/bin/es.js")
    expect(argv).toContain("factory")
    expect(argv).toContain("run")
    expect(argv).toContain("--headless")
    expect(argv).toContain("--events")
    expect(argv).toContain("jsonl")
    expect(argv).toContain("--cwd")
    expect(argv[argv.indexOf("--cwd") + 1]).toBe("/repo/.fleet/worktrees/task-a")
    // A single argv array: no shell string joins it, so no quoting hazards.
    expect(argv.every((word) => typeof word === "string")).toBe(true)
  })

  test("no --max-usd on the argv: factory run has no such flag (drift #125); the ceiling is provisioned into run state", () => {
    expect(buildWorkerArgv(spec())).not.toContain("--max-usd")
  })

  test("research-run tasks refuse until a headless research driver exists", () => {
    expect(() => buildWorkerArgv(spec({ kind: "research-run" }))).toThrow(/headless research/i)
  })
})

describe("event mapping and spend folding", () => {
  const acc = () => ({ spendUsd: 0, tokensIn: 0, tokensOut: 0 })
  test.each([
    ["waiting", { type: "waiting", reason: "frontier approval" }, "waiting-human"],
    ["done", { type: "done" }, "done"],
    ["halted", { type: "halted", reason: "STOP" }, "failed"],
    ["stalled", { type: "stalled", turns: 9, headline: "stuck" }, "failed"],
    ["turn-cap", { type: "turn-cap", turns: 40 }, "failed"],
    ["error", { type: "error", message: "boom" }, "failed"],
    ["cancelled", { type: "cancelled", reason: "SIGTERM" }, "cancelled"],
  ] as const)("headless %s maps to task %s", (_kind, event, status) => {
    const folded = foldWorkerEvent(acc(), {
      v: 1,
      at: "2026-10-09T12:00:00.000Z",
      runId: "r1",
      kind: event.type,
      event,
    })
    expect(folded.report?.outcome).toBe(status)
  })

  test("turn-metrics add spend and tokens without a status report", () => {
    const state = acc()
    const folded = foldWorkerEvent(state, {
      v: 1,
      at: "2026-10-09T12:00:00.000Z",
      runId: "r1",
      kind: "turn-metrics",
      event: { type: "turn-metrics", turn: 2, costUSD: 1.5, tokensIn: 100, tokensOut: 50, tools: [] },
    })
    expect(folded.report).toBeUndefined()
    expect(folded.acc.spendUsd).toBe(1.5)
    expect(folded.acc.tokensIn).toBe(100)
    expect(folded.acc.tokensOut).toBe(50)
  })

  test("progress chatter produces no report and no spend", () => {
    for (const kind of ["start", "turn", "progress", "driver"] as const) {
      const folded = foldWorkerEvent(acc(), {
        v: 1,
        at: "2026-10-09T12:00:00.000Z",
        runId: "r1",
        kind,
        event: { type: kind },
      })
      expect(folded.report).toBeUndefined()
      expect(folded.acc.spendUsd).toBe(0)
    }
  })
})

describe("run preparation", () => {
  test("factory-run: the task ceiling is provisioned into the worktree run state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-fleet-prep-"))
    try {
      await prepareTaskRun({ ...spec(), worktreeDir: dir })
      const { Factory, gateRunner } = await import("@heretek-ai/es-core")
      const state = await new Factory(dir, { gates: gateRunner({}) }).read()
      expect(state?.spendCeilingUSD).toBe(7)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("research-run: a research run opens with the objective and ceiling", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-fleet-prep-r-"))
    try {
      await prepareTaskRun({ ...spec(), kind: "research-run", worktreeDir: dir })
      const { Factory, gateRunner } = await import("@heretek-ai/es-core")
      const state = await new Factory(dir, { gates: gateRunner({}) }).read()
      expect(state?.mode).toBe("research")
      expect(state?.objective).toBe("build the thing")
      expect(state?.spendCeilingUSD).toBe(7)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("supervision", () => {
  test("a live tracked worker cannot be double-started", async () => {
    const supervisor = new WorkerSupervisor()
    supervisor.track("task-a", 999999321, { spendUsd: 0, tokensIn: 0, tokensOut: 0 })
    expect(() => supervisor.requireStartable("task-a")).toThrow(/already running/)
  })

  test("restart recovery: live pids reattach, dead pids report failure", async () => {
    const supervisor = new WorkerSupervisor()
    // This process is alive; 2^30 is certainly dead.
    const live = supervisor.recover([{ taskId: "task-a", pid: process.pid }], Date.now())
    expect(live.reattached).toEqual(["task-a"])
    expect(live.failed).toEqual([])
    expect(() => supervisor.requireStartable("task-a")).toThrow(/already running/)
    const dead = supervisor.recover([{ taskId: "task-b", pid: 1073741824 }], Date.now())
    expect(dead.reattached).toEqual([])
    expect(dead.failed[0]).toMatchObject({ taskId: "task-b" })
    expect(dead.failed[0]!.reason).toMatch(/daemon restarted/i)
  })
})

describe("StillDown circuit breaker", () => {
  test("repeated crashes refuse restarts until the cooldown passes", () => {
    const breaker = new CircuitBreaker({ maxRestarts: 2, windowMs: 60_000, cooldownMs: 60_000, massThreshold: 10 })
    const t0 = 1_000_000
    expect(breaker.probe("task-a", t0)).toBe("ok")
    breaker.noteCrash("task-a", t0)
    breaker.noteCrash("task-a", t0 + 1_000)
    const refused = breaker.probe("task-a", t0 + 2_000)
    expect(typeof refused).not.toBe("string")
    if (refused !== "ok") expect(refused.refused).toMatch(/crash/i)
    expect(breaker.probe("task-a", t0 + 61_000)).toBe("ok")
  })

  test("mass death opens the breaker for every task", () => {
    const breaker = new CircuitBreaker({ maxRestarts: 5, windowMs: 60_000, cooldownMs: 60_000, massThreshold: 3 })
    const t0 = 2_000_000
    breaker.noteCrash("a", t0)
    breaker.noteCrash("b", t0 + 100)
    breaker.noteCrash("c", t0 + 200)
    const refused = breaker.probe("zzz-fresh", t0 + 300)
    expect(refused).not.toBe("ok")
    expect(breaker.probe("zzz-fresh", t0 + 61_000)).toBe("ok")
  })
})

describe("worker process (stub CLI)", () => {
  const stub = async (script: string): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-fleet-stub-"))
    const file = path.join(dir, "stub.mjs")
    await writeFile(file, script)
    return file
  }

  test("scripted JSONL drives the task to done with accumulated spend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-fleet-wrun-"))
    try {
      const stubFile = await stub(`const lines = [
        { v: 1, at: new Date().toISOString(), runId: "r1", kind: "turn-metrics", event: { type: "turn-metrics", turn: 1, costUSD: 2, tools: [] } },
        { v: 1, at: new Date().toISOString(), runId: "r1", kind: "done", event: { type: "done" } },
      ];
      for (const line of lines) console.log(JSON.stringify(line));`)
      const { Worker } = await import("../src/worker.ts")
      const reports: Array<{ taskId: string; report: unknown }> = []
      const worker = new Worker({
        taskId: "task-a",
        worktreeDir: dir,
        ceilingUSD: 7,
        kind: "factory-run",
        objective: "x",
        esBin: stubFile,
        spawn: { command: process.execPath, args: [stubFile] },
        onReport: (taskId, report) => void reports.push({ taskId, report }),
      })
      const outcome = await worker.run()
      expect(outcome).toMatchObject({ status: "done" })
      expect(worker.snapshot().spendUsd).toBe(2)
      expect(reports.at(-1)).toMatchObject({ taskId: "task-a", report: { outcome: "done" } })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("exit 130 with no terminal event reports cancelled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-fleet-wrun-"))
    try {
      const stubFile = await stub(`process.exit(130);`)
      const { Worker } = await import("../src/worker.ts")
      const worker = new Worker({
        taskId: "task-a",
        worktreeDir: dir,
        ceilingUSD: 7,
        kind: "factory-run",
        objective: "x",
        esBin: stubFile,
        spawn: { command: process.execPath, args: [stubFile] },
        onReport: () => {},
      })
      await expect(worker.run()).resolves.toMatchObject({ status: "cancelled" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
