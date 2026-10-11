// Canary self-compilation and hot-swap harness (#176): candidate versions
// build in an isolated sandbox, serve shadow jobs beside the live worker,
// and take over the active symlink only when green — instantly rolling back
// when red. OFF by default with explicit human enablement, and the canary
// can never modify its own rollback mechanism.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CanaryError, type CanaryPipeline, CanaryRunner } from "../src/canary.ts"

const approval = () => ({
  approver: "human-director",
  signedAt: "2026-10-11T00:00:00.000Z",
  reason: "cut 2.3.0 canary",
})

const setup = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "es-canary-"))
  const live = path.join(dir, "versions", "v1")
  const activeLink = path.join(dir, "active")
  await mkdir(live, { recursive: true })
  await writeFile(path.join(live, "es.js"), "v1")
  await symlink(live, activeLink)
  return { dir, live, activeLink }
}

const pipeline = (pass: boolean, versionDir?: (dir: string) => Promise<string>): CanaryPipeline => ({
  build: async (sandbox: string) => {
    const target = versionDir ? await versionDir(sandbox) : path.join(sandbox, "v2")
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, "es.js"), "v2")
    return { versionDir: target, log: "built v2 in sandbox" }
  },
  spawnWorker: async (candidate: string) => ({ pid: 4242, endpoint: `canary://${candidate}` }),
  runShadow: async () => ({ pass, log: pass ? "shadow green" : "shadow red" }),
})

describe("human enablement", () => {
  test("default OFF: construction without explicit enablement refuses", async () => {
    const { dir, live, activeLink } = await setup()
    expect(() =>
      CanaryRunner.create({ activeLink, rollbackTarget: live, stagingDir: dir, pipeline: pipeline(true) }),
    ).toThrow(CanaryError)
    expect(() =>
      CanaryRunner.create({
        enabled: false,
        approval: approval(),
        activeLink,
        rollbackTarget: live,
        stagingDir: dir,
        pipeline: pipeline(true),
      }),
    ).toThrow(CanaryError)
    await rm(dir, { recursive: true, force: true })
  })

  test("explicit enablement needs a recorded human approval", async () => {
    const { dir, live, activeLink } = await setup()
    const base = { enabled: true as const, activeLink, rollbackTarget: live, stagingDir: dir, pipeline: pipeline(true) }
    expect(() => CanaryRunner.create(base)).toThrow(CanaryError)
    expect(() => CanaryRunner.create({ ...base, approval: { ...approval(), approver: "" } })).toThrow(CanaryError)
    expect(() => CanaryRunner.create({ ...base, approval: { ...approval(), signedAt: "not-a-date" } })).toThrow(
      CanaryError,
    )
    const runner = CanaryRunner.create({ ...base, approval: approval() })
    expect(runner.enabled).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("promote / rollback", () => {
  test("green shadow atomically re-points the active symlink", async () => {
    const { dir, live, activeLink } = await setup()
    const runner = CanaryRunner.create({
      enabled: true,
      approval: approval(),
      activeLink,
      rollbackTarget: live,
      stagingDir: path.join(dir, "staging"),
      pipeline: pipeline(true),
    })
    const result = await runner.runCanary(path.join(dir, "src"))
    expect(result.promoted).toBe(true)
    expect(await readlink(activeLink)).toBe(result.versionDir)
    await rm(dir, { recursive: true, force: true })
  })

  test("red shadow rolls back instantly to the recorded target", async () => {
    const { dir, live, activeLink } = await setup()
    const runner = CanaryRunner.create({
      enabled: true,
      approval: approval(),
      activeLink,
      rollbackTarget: live,
      stagingDir: path.join(dir, "staging"),
      pipeline: pipeline(false),
    })
    const result = await runner.runCanary(path.join(dir, "src"))
    expect(result.promoted).toBe(false)
    expect(await readlink(activeLink)).toBe(live)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("rollback immutability", () => {
  test("the canary cannot modify its own rollback mechanism", async () => {
    const { dir, live, activeLink } = await setup()
    const runner = CanaryRunner.create({
      enabled: true,
      approval: approval(),
      activeLink,
      rollbackTarget: live,
      stagingDir: path.join(dir, "staging"),
      pipeline: pipeline(true),
    })
    // Frozen config: reassignment throws (strict mode) or silently fails —
    // either way the recorded target does not change.
    try {
      ;(runner as { rollbackTarget: string }).rollbackTarget = path.join(dir, "evil")
    } catch {
      // Expected under strict mode: the freeze holds.
    }
    expect(runner.rollbackTarget).toBe(live)
    // Guarded writes: the canary tree and the active link are off-limits.
    await expect(runner.canaryWrite(path.join(live, "es.js"), "evil")).rejects.toThrow(CanaryError)
    await expect(runner.canaryWrite(activeLink, "evil")).rejects.toThrow(CanaryError)
    await expect(runner.canaryWrite("/etc/passwd", "evil")).rejects.toThrow(CanaryError)
    await rm(dir, { recursive: true, force: true })
  })

  test("a candidate built inside the rollback tree is refused", async () => {
    const { dir, live, activeLink } = await setup()
    const runner = CanaryRunner.create({
      enabled: true,
      approval: approval(),
      activeLink,
      rollbackTarget: live,
      stagingDir: path.join(dir, "staging"),
      pipeline: pipeline(true, async () => live),
    })
    await expect(runner.runCanary(path.join(dir, "src"))).rejects.toThrow(CanaryError)
    expect(await readlink(activeLink)).toBe(live)
    await rm(dir, { recursive: true, force: true })
  })
})
