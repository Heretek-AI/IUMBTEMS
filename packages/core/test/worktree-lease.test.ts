import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Factory } from "../src/factory/machine.ts"
import { exists } from "../src/util/fs.ts"
import * as Git from "../src/worktree/git.ts"
import { DEFAULT_LEASE_TTL_MS, LeaseError, pruneWorktrees, WorktreeLeaseManager } from "../src/worktree/lease.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

let fx: Fixture
beforeEach(async () => {
  fx = await gitRepo("es-lease-")
})
afterEach(() => fx.cleanup())

const info = (slug: string) => ({
  branch: `phase/6-${slug}`,
  dir: path.join(fx.root, ".worktrees", slug),
})

describe("worktree lease lifecycle (#160)", () => {
  test("TTL defaults to 120s; acquire → heartbeat → release round-trips", async () => {
    expect(DEFAULT_LEASE_TTL_MS).toBe(120_000)
    const leases = new WorktreeLeaseManager(fx.root)
    const first = await leases.acquire("a", info("a"))
    expect(first.slug).toBe("a")
    expect(first.ttlMs).toBe(120_000)
    const listed = await leases.list()
    expect(listed.map((lease) => lease.slug)).toEqual(["a"])
    const beat = await leases.heartbeat("a")
    expect(Date.parse(beat.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(first.heartbeatAt))
    await leases.release("a")
    expect(await leases.list()).toEqual([])
  })

  test("a live lease refuses a second acquisition", async () => {
    const leases = new WorktreeLeaseManager(fx.root)
    await leases.acquire("a", info("a"))
    const other = new WorktreeLeaseManager(fx.root)
    await expect(other.acquire("a", info("a"))).rejects.toThrow(LeaseError)
  })

  test("an expired lease is taken over by the next acquirer", async () => {
    const leases = new WorktreeLeaseManager(fx.root, { ttlMs: 60 })
    await leases.acquire("a", info("a"))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const other = new WorktreeLeaseManager(fx.root, { ttlMs: 60 })
    const retaken = await other.acquire("a", info("a"))
    expect(retaken.slug).toBe("a")
    // The stale holder's token is dead: its heartbeat and release are refused.
    await expect(leases.heartbeat("a")).rejects.toThrow(LeaseError)
    await expect(leases.release("a")).rejects.toThrow(LeaseError)
    await other.release("a")
  })

  test("a crashed holder's lease (dead pid, fresh heartbeat) is reclaimable", async () => {
    const leases = new WorktreeLeaseManager(fx.root)
    await leases.acquire("a", info("a"))
    // Simulate a SIGKILLed holder: rewrite the lease with an unusable pid but a fresh heartbeat.
    const file = path.join(fx.root, ".worktrees", ".leases", "a.json")
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    await writeFile(file, `${JSON.stringify({ ...raw, pid: 2 ** 30, heartbeatAt: new Date().toISOString() })}\n`)
    const other = new WorktreeLeaseManager(fx.root)
    const retaken = await other.acquire("a", info("a"))
    expect(retaken.pid).toBe(process.pid)
    await other.release("a")
  })

  test("invalid slugs are refused", async () => {
    const leases = new WorktreeLeaseManager(fx.root)
    await expect(leases.acquire("../escape", info("x"))).rejects.toThrow(LeaseError)
    await expect(leases.acquire("UPPER", info("x"))).rejects.toThrow(LeaseError)
  })

  test("withLease releases after success and after failure", async () => {
    const leases = new WorktreeLeaseManager(fx.root)
    const value = await leases.withLease("a", info("a"), async (lease) => `${lease.slug}!`)
    expect(value).toBe("a!")
    expect(await leases.list()).toEqual([])
    await expect(
      leases.withLease("a", info("a"), async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(await leases.list()).toEqual([])
  })
})

describe("worktree lease concurrency stress (#160)", () => {
  test("32 racing acquisitions elect exactly one winner", async () => {
    const managers = Array.from({ length: 32 }, () => new WorktreeLeaseManager(fx.root))
    const results = await Promise.allSettled(managers.map((manager) => manager.acquire("race", info("race"))))
    const winners = results.filter((result) => result.status === "fulfilled")
    const losers = results.filter((result) => result.status === "rejected")
    expect(winners.length).toBe(1)
    expect(losers.length).toBe(31)
    for (const loser of losers) expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(LeaseError)
    const winner = managers[results.findIndex((result) => result.status === "fulfilled")]!
    await winner.release("race")
  })

  test("two racing reclaimers of one stale lease elect exactly one winner", async () => {
    const setup = new WorktreeLeaseManager(fx.root, { ttlMs: 40 })
    await setup.acquire("stale", info("stale"))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const racers = [new WorktreeLeaseManager(fx.root), new WorktreeLeaseManager(fx.root)]
    const results = await Promise.allSettled(racers.map((racer) => racer.acquire("stale", info("stale"))))
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1)
    const winner = racers[results.findIndex((result) => result.status === "fulfilled")]!
    await winner.release("stale")
  })

  test("a cross-process race elects exactly one winner", async () => {
    // The winner holds the lease (heartbeating, pid alive) for 1.5s while
    // the losers attempt: losers must see a live lease and lose. Short-lived
    // winners would look crashed to later acquirers, so holding is the point.
    const script = path.join(fx.root, "race-child.mjs")
    await writeFile(
      script,
      `import { WorktreeLeaseManager } from ${JSON.stringify(new URL("../src/worktree/lease.ts", import.meta.url).href)};
const leases = new WorktreeLeaseManager(${JSON.stringify(fx.root)}, { ttlMs: 10_000 });
try {
  await leases.withLease("proc-race", { branch: "phase/6-proc-race", dir: ${JSON.stringify(path.join(fx.root, ".worktrees", "proc-race"))} }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log("WON");
  });
} catch { console.log("LOST"); }\n`,
    )
    const children = Array.from({ length: 6 }, () => Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" }))
    const outputs = await Promise.all(
      children.map(async (child) => {
        const text = await new Response(child.stdout).text()
        await child.exited
        return text.trim()
      }),
    )
    expect(outputs.filter((line) => line === "WON").length).toBe(1)
    expect(outputs.filter((line) => line === "LOST").length).toBe(5)
    await rm(script, { force: true })
    await new WorktreeLeaseManager(fx.root).release("proc-race").catch(() => undefined)
  }, 30_000)
})

describe("worktree prune (#160)", () => {
  test("prune drops dead leases and force-removes orphaned worktrees, keeping live ones", async () => {
    const base = await Git.headCommit(fx.root)
    const leases = new WorktreeLeaseManager(fx.root)
    // Live: a lease whose worktree checkout exists.
    await leases.acquire("live", info("live"))
    await Git.addWorktree(fx.root, info("live").dir, info("live").branch, base)
    // Orphan: a registered git worktree with no lease (crashed holder, lease file gone).
    const orphanDir = path.join(fx.root, ".worktrees", "orphan")
    await Git.addWorktree(fx.root, orphanDir, "phase/6-orphan", base)
    await writeFile(path.join(orphanDir, "work.txt"), "orphaned\n")
    // Dead lease: an expired lease file with no checkout.
    const dead = new WorktreeLeaseManager(fx.root, { ttlMs: 40 })
    await dead.acquire("dead", {
      branch: "phase/6-dead",
      dir: path.join(fx.root, ".worktrees", "dead"),
    })
    await new Promise((resolve) => setTimeout(resolve, 60))

    const report = await pruneWorktrees(fx.root)
    expect(report.dropped).toContain("dead")
    expect(report.removed).toContain(orphanDir)
    expect(report.kept).toContain("live")
    expect(await Bun.file(path.join(orphanDir, "work.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(info("live").dir, ".git")).exists()).toBe(true)
    // The orphan's branch is kept (prune never deletes branches); the live lease survives.
    expect(await Git.branchExists(fx.root, "phase/6-orphan")).toBe(true)
    expect((await leases.list()).map((lease) => lease.slug)).toEqual(["live"])
    await leases.release("live")
    await Git.removeWorktree(fx.root, info("live").dir)
  })

  test("prune on an empty root is a no-op", async () => {
    const report = await pruneWorktrees(fx.root)
    expect(report).toEqual({ dropped: [], removed: [], kept: [] })
  })
})

describe("factory startup prunes orphaned worktrees (#160)", () => {
  test("begin() garbage-collects a stale lease and its orphaned checkout", async () => {
    const base = await Git.headCommit(fx.root)
    const orphanDir = path.join(fx.root, ".worktrees", "startup-orphan")
    await Git.addWorktree(fx.root, orphanDir, "phase/6-startup-orphan", base)
    const dead = new WorktreeLeaseManager(fx.root, { ttlMs: 40 })
    await dead.acquire("startup-orphan", { branch: "phase/6-startup-orphan", dir: orphanDir })
    await new Promise((resolve) => setTimeout(resolve, 60))

    const gates = async () => ({ passed: true as const, findings: [], summary: "green" })
    const factory = new Factory(fx.root, { gates, stateDir: fx.state })
    await factory.begin("human:tester")
    expect(await Bun.file(orphanDir).exists()).toBe(false)
  })
})

describe("worktree lease with a custom worktree root (#340)", () => {
  const customRoot = () => path.join(fx.root, ".factory", "worktrees")
  const opts = (extra: Record<string, unknown> = {}) => ({ worktreeRoot: customRoot(), ...extra })
  const finfo = (slug: string) => ({
    branch: `factory/run-1/phase-${slug}`,
    dir: path.join(customRoot(), slug),
  })

  test("acquire → heartbeat → release round-trips under a custom root", async () => {
    const leases = new WorktreeLeaseManager(fx.root, opts())
    const first = await leases.acquire("alpha", finfo("alpha"))
    expect(first.slug).toBe("alpha")
    expect(first.branch).toBe("factory/run-1/phase-alpha")
    const beat = await leases.heartbeat("alpha")
    expect(Date.parse(beat.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(first.heartbeatAt))
    await leases.release("alpha")
    expect(await leases.list()).toEqual([])
  })

  test("a live lease under a custom root refuses a second acquisition", async () => {
    const leases = new WorktreeLeaseManager(fx.root, opts())
    await leases.acquire("alpha", finfo("alpha"))
    const other = new WorktreeLeaseManager(fx.root, opts())
    await expect(other.acquire("alpha", finfo("alpha"))).rejects.toThrow(LeaseError)
    await leases.release("alpha")
  })

  test("dirs outside the custom root are refused (confinement preserved)", async () => {
    const leases = new WorktreeLeaseManager(fx.root, opts())
    // Inside the default `.worktrees/` root but outside the custom one.
    await expect(
      leases.acquire("alpha", {
        branch: "phase/6-alpha",
        dir: path.join(fx.root, ".worktrees", "alpha"),
      }),
    ).rejects.toThrow(LeaseError)
    await expect(leases.acquire("alpha", { branch: "phase/6-alpha", dir: "/tmp/not-managed" })).rejects.toThrow(
      LeaseError,
    )
  })

  test("prune with a custom root collects only that root", async () => {
    const base = await Git.headCommit(fx.root)
    let nowMs = Date.now()
    const now = () => nowMs
    // Orphan under the custom root: stale lease + registered checkout.
    const customOrphan = path.join(customRoot(), "orphan")
    await Git.addWorktree(fx.root, customOrphan, "factory/run-1/phase-orphan", base)
    const customLeases = new WorktreeLeaseManager(fx.root, { ...opts(), ttlMs: 1000, now })
    await customLeases.acquire("orphan", { branch: "factory/run-1/phase-orphan", dir: customOrphan })
    // Orphan under the default root: stale lease + registered checkout.
    const defaultOrphan = path.join(fx.root, ".worktrees", "orphan")
    await Git.addWorktree(fx.root, defaultOrphan, "phase/6-orphan", base)
    const defaultLeases = new WorktreeLeaseManager(fx.root, { ttlMs: 1000, now })
    await defaultLeases.acquire("orphan", { branch: "phase/6-orphan", dir: defaultOrphan })
    nowMs += 5000

    const report = await pruneWorktrees(fx.root, { ...opts(), now })
    expect(report.dropped).toEqual(["orphan"])
    expect(report.removed).toEqual([customOrphan])
    expect(await exists(customOrphan)).toBe(false)
    // The default root is untouched by a custom-root prune.
    expect(await exists(defaultOrphan)).toBe(true)
    expect(await Git.branchExists(fx.root, "phase/6-orphan")).toBe(true)
    await pruneWorktrees(fx.root, { now })
  })
})
