// Audit proofs for #339 (canary harness): symlink confinement around the
// rollback tree, and crash-safety of the active link between build and promote.
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
  const dir = await mkdtemp(path.join(tmpdir(), "es-audit-canary-"))
  const live = path.join(dir, "versions", "v1")
  const activeLink = path.join(dir, "active")
  await mkdir(live, { recursive: true })
  await writeFile(path.join(live, "es.js"), "v1")
  await symlink(live, activeLink)
  return { dir, live, activeLink }
}

const greenPipeline = (): CanaryPipeline => ({
  build: async (sandbox: string) => {
    const target = path.join(sandbox, "v2")
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, "es.js"), "v2")
    return { versionDir: target, log: "built v2 in sandbox" }
  },
  spawnWorker: async (candidate: string) => ({ pid: 4242, endpoint: `canary://${candidate}` }),
  runShadow: async () => ({ pass: true, log: "shadow green" }),
})

describe("audit #339: symlink confinement", () => {
  test("a write through a staging symlink into the rollback tree is refused", async () => {
    const { dir, live, activeLink } = await setup()
    const runner = CanaryRunner.create({
      enabled: true,
      approval: approval(),
      activeLink,
      rollbackTarget: live,
      stagingDir: path.join(dir, "staging"),
      pipeline: greenPipeline(),
    })
    await mkdir(path.join(dir, "staging"), { recursive: true })
    const link = path.join(dir, "staging", "link")
    await symlink(live, link)
    await expect(runner.canaryWrite(path.join(link, "evil.js"), "evil")).rejects.toThrow(CanaryError)
    // The rollback tree is untouched.
    await expect(writeFile(path.join(live, "evil-check"), "x")).resolves.toBeUndefined()
    await rm(path.join(live, "evil-check"), { force: true })
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(live))
    expect(entries).not.toContain("evil.js")
    await rm(dir, { recursive: true, force: true })
  })

  test("a .. escape from the sandbox is refused", async () => {
    const { dir, live, activeLink } = await setup()
    const runner = CanaryRunner.create({
      enabled: true,
      approval: approval(),
      activeLink,
      rollbackTarget: live,
      stagingDir: path.join(dir, "staging"),
      pipeline: greenPipeline(),
    })
    await expect(runner.canaryWrite(path.join(dir, "staging", "..", "outside.js"), "evil")).rejects.toThrow(CanaryError)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("audit #339: crash between build and promote", () => {
  test("a spawn crash leaves the active link valid on the old version", async () => {
    const { dir, live, activeLink } = await setup()
    const crashing: CanaryPipeline = {
      ...greenPipeline(),
      spawnWorker: async () => {
        throw new Error("worker crashed before promote")
      },
    }
    const runner = CanaryRunner.create({
      enabled: true,
      approval: approval(),
      activeLink,
      rollbackTarget: live,
      stagingDir: path.join(dir, "staging"),
      pipeline: crashing,
    })
    await expect(runner.runCanary(path.join(dir, "src"))).rejects.toThrow("worker crashed")
    // The active link still resolves to the old, live version.
    expect(await readlink(activeLink)).toBe(live)
    const { readFile } = await import("node:fs/promises")
    expect(await readFile(path.join(activeLink, "es.js"), "utf8")).toBe("v1")
    await rm(dir, { recursive: true, force: true })
  })

  test("a shadow crash leaves the active link valid on the old version", async () => {
    const { dir, live, activeLink } = await setup()
    const crashing: CanaryPipeline = {
      ...greenPipeline(),
      runShadow: async () => {
        throw new Error("shadow crashed before promote")
      },
    }
    const runner = CanaryRunner.create({
      enabled: true,
      approval: approval(),
      activeLink,
      rollbackTarget: live,
      stagingDir: path.join(dir, "staging"),
      pipeline: crashing,
    })
    await expect(runner.runCanary(path.join(dir, "src"))).rejects.toThrow("shadow crashed")
    expect(await readlink(activeLink)).toBe(live)
    await rm(dir, { recursive: true, force: true })
  })
})
