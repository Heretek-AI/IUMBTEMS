// Audit proofs for #330 (fleet process orchestrator, #161): daemon kill +
// restart, cyclic-roadmap refusal pre-start, and the human-only gate on
// `es-fleet run-dag`. Complements packages/fleet/test/run-dag.test.ts (order,
// heartbeats, stuck restart, late settlement) with the exact acceptance shapes.
import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { git as coreGit, evaluateShell, invokesHumanOnly } from "@heretek-ai/es-core"
import { FleetDaemon, type WorkerPort } from "../src/daemon.ts"
import { loadRoadmapFile, runDag } from "../src/run-dag.ts"
import type { TaskReport } from "../src/scheduler.ts"
import { addTask, emptyDag, loadDag, saveDag } from "../src/tasks.ts"
import type { WorkerOutcome, WorkerSpec } from "../src/worker.ts"

const STAMP = "2026-10-12T00:00:00.000Z"

async function gitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "es-fleet-audit-"))
  const state = await mkdtemp(path.join(tmpdir(), "es-fleet-audit-state-"))
  const git = (args: string[], cwd = root) => coreGit(cwd, args)
  await git(["init", "-b", "main"])
  await git(["config", "user.name", "fleet-audit"])
  await git(["config", "user.email", "fleet@audit.local"])
  await git(["config", "commit.gpgsign", "false"])
  await writeFile(path.join(root, "file.txt"), "base\n")
  await git(["add", "-A"])
  await git(["commit", "--no-verify", "-m", "base"])
  return { root, state }
}

const gatesOk = () => Promise.resolve({ ok: true as const })

const completingDriver = (started: string[]) => {
  const spawner = (spec: WorkerSpec, onReport: (taskId: string, report: TaskReport) => void): WorkerPort => {
    started.push(spec.taskId)
    return {
      run: async () => {
        onReport(spec.taskId, { outcome: "done", spendUsd: 1 })
        return { status: "done" as const, spendUsd: 1 }
      },
      stop: () => Promise.resolve(),
      snapshot: () => ({ taskId: spec.taskId, pid: -1, spendUsd: 0, tokensIn: 0, tokensOut: 0 }),
    }
  }
  return spawner
}

describe("audit #330: a daemon killed mid-DAG restarts and finishes each task once", () => {
  test("SIGKILL between tasks loses nothing; a dead hung turn fails over to its retry policy", async () => {
    const { root, state } = await gitFixture()
    const nowMs = Date.parse(STAMP)
    const now = () => nowMs
    // Two-task chain; b retries once (its hung first attempt must re-queue, not die).
    let dag = emptyDag()
    dag = addTask(
      dag,
      { id: "k-a", title: "k a", kind: "factory-run", input: { objective: "do k-a" }, ceilingUSD: 5 },
      STAMP,
    )
    dag = addTask(
      dag,
      {
        id: "k-b",
        title: "k b",
        kind: "factory-run",
        deps: ["k-a"],
        input: { objective: "do k-b" },
        ceilingUSD: 5,
        policy: { strategy: "retry", maxAttempts: 2 },
      },
      STAMP,
    )
    await saveDag(state, dag)

    const started: string[] = []
    // Daemon 1 finishes a but wedges on b (never reports, like a killed headless run).
    const daemon1 = new FleetDaemon({
      repoRoot: root,
      stateRoot: state,
      esBin: "/stub/es.js",
      fleetCeilingUsd: 100,
      checkGates: gatesOk,
      spawnWorker: (spec, onReport) => {
        started.push(spec.taskId)
        if (spec.taskId === "k-a")
          return {
            run: async () => {
              onReport(spec.taskId, { outcome: "done", spendUsd: 1 })
              return { status: "done" as const, spendUsd: 1 }
            },
            stop: () => Promise.resolve(),
            snapshot: () => ({ taskId: spec.taskId, pid: -1, spendUsd: 0, tokensIn: 0, tokensOut: 0 }),
          }
        return {
          run: () => new Promise<WorkerOutcome>(() => {}),
          stop: () => Promise.resolve(),
          snapshot: () => ({ taskId: spec.taskId, pid: -1, spendUsd: 0, tokensIn: 0, tokensOut: 0 }),
        }
      },
      now,
    })
    await daemon1.tick()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await daemon1.tick()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await loadDag(state))?.tasks["k-a"]?.status).toBe("done")
    expect((await loadDag(state))?.tasks["k-b"]?.status).toBe("running")
    // SIGKILL: no shutdown, no cleanup — the process is just gone.
    // Daemon 2 starts cold on the same roots. Its worker table names the hung
    // turn's pid, which is dead, so recover() fails it into the retry policy.
    const daemon2 = new FleetDaemon({
      repoRoot: root,
      stateRoot: state,
      esBin: "/stub/es.js",
      fleetCeilingUsd: 100,
      checkGates: gatesOk,
      spawnWorker: completingDriver(started),
      now,
    })
    await daemon2.recover([{ taskId: "k-b", pid: 2 ** 30 }])
    await daemon2.tick()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await daemon2.tick()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const final = (await loadDag(state))!
    expect(final.tasks["k-a"]?.status).toBe("done")
    expect(final.tasks["k-b"]?.status).toBe("done")
    // k-a launched exactly once (never reduplicated); k-b launched twice (the
    // hung attempt plus exactly one relaunch) and completed exactly once.
    expect(started.filter((id) => id === "k-a")).toEqual(["k-a"])
    expect(started.filter((id) => id === "k-b").length).toBe(2)
    await daemon2.shutdown()
  }, 60_000)
})

describe("audit #330: invalid roadmaps are refused before any task starts", () => {
  test("cycles, duplicates, unknown and self deps refuse; runDag spawns nothing", async () => {
    const { root, state } = await gitFixture()
    const task = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      title: id,
      kind: "factory-run",
      input: { objective: `do ${id}` },
      ceilingUSD: 5,
      ...extra,
    })
    const write = (name: string, tasks: unknown[]) =>
      writeFile(path.join(root, name), JSON.stringify({ dagId: "audit", tasks })).then(() => path.join(root, name))

    await expect(
      write("cycle.json", [task("x", { deps: ["y"] }), task("y", { deps: ["x"] })]).then((f) =>
        loadRoadmapFile(f, STAMP),
      ),
    ).rejects.toThrow(/cycle/)
    await expect(write("dup.json", [task("d"), task("d")]).then((f) => loadRoadmapFile(f, STAMP))).rejects.toThrow(
      /Duplicate/,
    )
    await expect(
      write("unknown.json", [task("u", { deps: ["ghost"] })]).then((f) => loadRoadmapFile(f, STAMP)),
    ).rejects.toThrow(/unknown task/)
    await expect(
      write("self.json", [task("s", { deps: ["s"] })]).then((f) => loadRoadmapFile(f, STAMP)),
    ).rejects.toThrow(/itself/)

    // Pre-start refusal at the runDag boundary: no worker ever spawns.
    const started: string[] = []
    const cycleFile = await write("run-cycle.json", [task("x", { deps: ["y"] }), task("y", { deps: ["x"] })])
    await expect(
      runDag({
        repoRoot: root,
        stateRoot: state,
        esBin: "/stub/es.js",
        roadmapFile: cycleFile,
        fleetCeilingUsd: 100,
        checkGates: gatesOk,
        spawnWorker: completingDriver(started),
      }),
    ).rejects.toThrow(/cycle/)
    expect(started).toEqual([])
  })
})

describe("audit #330: es-fleet run-dag is human-only in an agent shell", () => {
  test("run-dag is denied for seats and user agents; plain status stays allowed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-fleet-audit-policy-"))
    const ctx = () => ({ root })
    try {
      expect(invokesHumanOnly("es-fleet run-dag roadmap.json --max-usd 10")).toBe(true)
      for (const command of [
        "es-fleet run-dag roadmap.json --max-usd 10",
        'es-fleet "run-dag" roadmap.json --max-usd 10',
        "es-fleet --state-dir /tmp/s run-dag roadmap.json --max-usd 10",
        "es-fleet -- run-dag roadmap.json --max-usd 10",
      ])
        for (const agent of ["build", "factory", "es-programmer", undefined])
          expect([agent, command, evaluateShell(ctx(), agent, command, { sandboxAvailable: true }).effect]).toEqual([
            agent,
            command,
            "deny",
          ])
      // Discrimination: a token-less status is a read and stays allowed.
      for (const agent of ["build", "es-programmer", undefined])
        expect(evaluateShell(ctx(), agent, "es-fleet status", { sandboxAvailable: true }).effect).toBe("allow")
      expect(evaluateShell(ctx(), "build", "es-fleet status --token", { sandboxAvailable: true }).effect).toBe("deny")
    } finally {
      const { rm } = await import("node:fs/promises")
      await rm(root, { recursive: true, force: true })
    }
  })
})
