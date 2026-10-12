// Scheduler canary seam (#346): the daemon scheduler runs a canary cycle
// only on explicit human enablement (`enabled: true` with a recorded human
// approval) — otherwise it does nothing. A red shadow run rolls back with no
// manual step, and the canary cannot change its own rollback target (frozen +
// guarded, per the #339 audit). Tests drive the build/spawn/shadow pipeline
// with harness doubles; no live daemon or canary is ever executed.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { canaryEnabled } from "../src/bin.ts"
import { CanaryError, type CanaryOptions, type CanaryPipeline, CanaryRunner } from "../src/canary.ts"
import { planCanaryCycle, runScheduledCanaryCycle } from "../src/scheduler.ts"

const approval = () => ({
  approver: "human-director",
  signedAt: "2026-10-11T00:00:00.000Z",
  reason: "wire canary behind human enablement",
})

const setup = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "es-scheduler-canary-"))
  const live = path.join(dir, "versions", "v1")
  const activeLink = path.join(dir, "active")
  await mkdir(live, { recursive: true })
  await writeFile(path.join(live, "es.js"), "v1")
  await symlink(live, activeLink)
  return { dir, live, activeLink }
}

const trackingPipeline = (pass: boolean) => {
  let builds = 0
  const pipeline: CanaryPipeline = {
    build: async (_sourceDir: string, sandboxDir: string) => {
      builds += 1
      const target = path.join(sandboxDir, "v2")
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, "es.js"), "v2")
      return { versionDir: target, log: "built v2 in sandbox" }
    },
    spawnWorker: async (candidate: string) => ({ pid: 4242, endpoint: `canary://${candidate}` }),
    runShadow: async () => ({ pass, log: pass ? "shadow green" : "shadow red" }),
  }
  return { pipeline, builds: () => builds }
}

const enabledOptions = (
  activeLink: string,
  live: string,
  stagingDir: string,
  pipeline: CanaryPipeline,
): CanaryOptions => ({
  enabled: true,
  approval: approval(),
  activeLink,
  rollbackTarget: live,
  stagingDir,
  pipeline,
})

describe("disabled by default: no cycle without explicit enablement", () => {
  test("the pure gate schedules nothing without an explicit opt-in", () => {
    expect(planCanaryCycle(undefined)).toEqual({ run: false })
  })

  test("no cycle runs without canary options, and the pipeline is untouched", async () => {
    const { dir, live, activeLink } = await setup()
    const outcome = await runScheduledCanaryCycle({ sourceDir: path.join(dir, "src") })
    expect(outcome).toEqual({ ran: false })
    expect(await readlink(activeLink)).toBe(live)
    await rm(dir, { recursive: true, force: true })
  })

  test("enabled:false and a missing flag run nothing and never build", async () => {
    const { dir, live, activeLink } = await setup()
    const stagingDir = path.join(dir, "staging")
    for (const canary of [
      { ...enabledOptions(activeLink, live, stagingDir, trackingPipeline(false).pipeline), enabled: false as const },
      { ...enabledOptions(activeLink, live, stagingDir, trackingPipeline(false).pipeline), enabled: undefined },
    ]) {
      const { pipeline, builds } = trackingPipeline(false)
      const options: CanaryOptions = { ...canary, pipeline }
      expect(planCanaryCycle(options)).toEqual({ run: false })
      const outcome = await runScheduledCanaryCycle({ canary: options, sourceDir: path.join(dir, "src") })
      expect(outcome).toEqual({ ran: false })
      expect(builds()).toBe(0)
      expect(await readlink(activeLink)).toBe(live)
    }
    await rm(dir, { recursive: true, force: true })
  })

  test("enabled:true without a recorded approval fails closed and never builds", async () => {
    const { dir, live, activeLink } = await setup()
    const { pipeline, builds } = trackingPipeline(false)
    const options: CanaryOptions = {
      enabled: true,
      activeLink,
      rollbackTarget: live,
      stagingDir: path.join(dir, "staging"),
      pipeline,
    }
    await expect(runScheduledCanaryCycle({ canary: options, sourceDir: path.join(dir, "src") })).rejects.toThrow(
      CanaryError,
    )
    expect(builds()).toBe(0)
    expect(await readlink(activeLink)).toBe(live)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("enabled cycles: red rolls back with no manual step", () => {
  test("a red shadow run re-points the active link at the recorded target in the one call", async () => {
    const { dir, live, activeLink } = await setup()
    const { pipeline } = trackingPipeline(false)
    const outcome = await runScheduledCanaryCycle({
      canary: enabledOptions(activeLink, live, path.join(dir, "staging"), pipeline),
      sourceDir: path.join(dir, "src"),
    })
    expect(outcome.ran).toBe(true)
    if (outcome.ran) expect(outcome.result.promoted).toBe(false)
    // No manual step: the single cycle already rolled back.
    expect(await readlink(activeLink)).toBe(live)
    expect(await readFile(path.join(activeLink, "es.js"), "utf8")).toBe("v1")
    await rm(dir, { recursive: true, force: true })
  })

  test("a green shadow run promotes to the candidate", async () => {
    const { dir, activeLink } = await setup()
    const { pipeline } = trackingPipeline(true)
    const outcome = await runScheduledCanaryCycle({
      canary: enabledOptions(activeLink, path.join(dir, "versions", "v1"), path.join(dir, "staging"), pipeline),
      sourceDir: path.join(dir, "src"),
    })
    expect(outcome.ran).toBe(true)
    if (outcome.ran) {
      expect(outcome.result.promoted).toBe(true)
      expect(await readlink(activeLink)).toBe(outcome.result.versionDir)
    }
    await rm(dir, { recursive: true, force: true })
  })
})

describe("rollback-target immutability through the scheduler seam", () => {
  test("the recorded target is frozen: reassignment does not stick", async () => {
    const { dir, live, activeLink } = await setup()
    const { pipeline } = trackingPipeline(false)
    const runner = CanaryRunner.create(enabledOptions(activeLink, live, path.join(dir, "staging"), pipeline))
    expect(Object.isFrozen(runner)).toBe(true)
    try {
      ;(runner as { rollbackTarget: string }).rollbackTarget = path.join(dir, "evil")
    } catch {
      // Expected under strict mode: the freeze holds.
    }
    expect(runner.rollbackTarget).toBe(live)
    await rm(dir, { recursive: true, force: true })
  })

  test("guarded writes still deny the rollback tree on a seam-built runner", async () => {
    const { dir, live, activeLink } = await setup()
    const { pipeline } = trackingPipeline(false)
    const runner = CanaryRunner.create(enabledOptions(activeLink, live, path.join(dir, "staging"), pipeline))
    await expect(runner.canaryWrite(path.join(live, "es.js"), "evil")).rejects.toThrow(CanaryError)
    await rm(dir, { recursive: true, force: true })
  })

  test("a candidate built inside the rollback tree is refused and stays rolled back", async () => {
    const { dir, live, activeLink } = await setup()
    const inTree: CanaryPipeline = {
      ...trackingPipeline(false).pipeline,
      build: async () => ({ versionDir: live, log: "built inside the rollback tree" }),
    }
    await expect(
      runScheduledCanaryCycle({
        canary: enabledOptions(activeLink, live, path.join(dir, "staging"), inTree),
        sourceDir: path.join(dir, "src"),
      }),
    ).rejects.toThrow(CanaryError)
    expect(await readlink(activeLink)).toBe(live)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("bin.ts: the canary enable flag defaults OFF", () => {
  test("no flag means no canary", () => {
    expect(canaryEnabled([])).toBe(false)
    expect(canaryEnabled(["start", "--max-usd", "10"])).toBe(false)
  })

  test("--enable-canary opts in explicitly", () => {
    expect(canaryEnabled(["start", "--max-usd", "10", "--enable-canary"])).toBe(true)
  })
})
