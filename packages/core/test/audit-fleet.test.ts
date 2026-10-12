// Audit proofs for #329 (worktree lease manager, #160): real git repos, real
// processes, injected clocks. Complements packages/core/test/worktree-lease.test.ts
// (race/concurrency stress, round-trips) with the exact acceptance shapes:
// prune on a real repo deletes the checkout and keeps the branch; a
// killed-process lease is reclaimed after the TTL; a stale lease at factory
// start is collected and the slug is acquirable again (lease-API surface — the
// Factory.begin wiring itself lives in packages/core/src/factory/machine.ts,
// outside this squad's Owns: CROSS-SQUAD, see report).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import * as Git from "../src/worktree/git.ts"
import { LeaseError, pruneWorktrees, WorktreeLeaseManager } from "../src/worktree/lease.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

let fx: Fixture
beforeEach(async () => {
  fx = await gitRepo("es-audit-lease-")
})
afterEach(() => fx.cleanup())

describe("audit #329: prune on a real repo deletes checkouts, never branches", () => {
  test("an orphaned checkout is force-removed while its branch stays reachable", async () => {
    const base = await Git.headCommit(fx.root)
    const orphanDir = path.join(fx.root, ".worktrees", "audit-orphan")
    await Git.addWorktree(fx.root, orphanDir, "phase/9-audit-orphan", base)
    await writeFile(path.join(orphanDir, "work.txt"), "orphaned\n")

    const report = await pruneWorktrees(fx.root)

    expect(report.removed).toContain(orphanDir)
    expect(await Bun.file(orphanDir).exists()).toBe(false)
    // The branch is kept: prune deletes checkouts, never history.
    expect(await Git.branchExists(fx.root, "phase/9-audit-orphan")).toBe(true)
    const branches = (await Git.git(fx.root, ["branch", "--list", "phase/9-audit-orphan"])).stdout.trim()
    expect(branches).toContain("phase/9-audit-orphan")
    await Git.git(fx.root, ["branch", "-D", "phase/9-audit-orphan"])
  })
})

describe("audit #329: a killed-process lease is reclaimed after the TTL", () => {
  test("dead pid + expired heartbeat (injected clock) is taken over; the dead token is refused", async () => {
    let nowMs = Date.parse("2026-10-12T00:00:00.000Z")
    const holder = new WorktreeLeaseManager(fx.root, { ttlMs: 120_000, now: () => nowMs })
    const dir = path.join(fx.root, ".worktrees", "killed")
    await holder.acquire("killed", { branch: "phase/9-killed", dir })
    // Simulate SIGKILL: rewrite the lease with an undead-usable pid but keep
    // the heartbeat fresh, then move the clock past the TTL.
    const file = path.join(fx.root, ".worktrees", ".leases", "killed.json")
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    await writeFile(file, `${JSON.stringify({ ...raw, pid: 2 ** 30 })}\n`)
    nowMs += 120_001

    const reclaimer = new WorktreeLeaseManager(fx.root, { ttlMs: 120_000, now: () => nowMs })
    const retaken = await reclaimer.acquire("killed", { branch: "phase/9-killed", dir })
    expect(retaken.pid).toBe(process.pid)
    // The killed holder's token is dead: heartbeat and release are refused.
    await expect(holder.heartbeat("killed")).rejects.toThrow(LeaseError)
    await expect(holder.release("killed")).rejects.toThrow(LeaseError)
    await reclaimer.release("killed")
  })
})

describe("audit #329: factory start with a stale lease collects it and proceeds", () => {
  test("prune drops the stale lease, then the same slug is acquirable (lease-API surface)", async () => {
    // CROSS-SQUAD: Factory.begin's prune call lives in
    // packages/core/src/factory/machine.ts (outside this squad's Owns); the
    // existing factory-startup test in worktree-lease.test.ts covers the
    // wiring. Here we prove the lease half: collection + re-acquire.
    let nowMs = Date.parse("2026-10-12T00:00:00.000Z")
    const stale = new WorktreeLeaseManager(fx.root, { ttlMs: 50, now: () => nowMs })
    const dir = path.join(fx.root, ".worktrees", "startup")
    await stale.acquire("startup", { branch: "phase/9-startup", dir })
    nowMs += 5_000

    const report = await pruneWorktrees(fx.root, { ttlMs: 50, now: () => nowMs })
    expect(report.dropped).toContain("startup")

    const next = new WorktreeLeaseManager(fx.root, { now: () => nowMs })
    const lease = await next.acquire("startup", { branch: "phase/9-startup", dir })
    expect(lease.slug).toBe("startup")
    await next.release("startup")
  })
})

describe("audit #329: slug and root confinement", () => {
  test("slugs outside [a-z0-9-] and dirs outside the managed root are refused", async () => {
    const leases = new WorktreeLeaseManager(fx.root)
    const inside = (slug: string) => ({ branch: "phase/9-x", dir: path.join(fx.root, ".worktrees", slug) })
    await expect(leases.acquire("../escape", inside("x"))).rejects.toThrow(LeaseError)
    await expect(leases.acquire("UPPER", inside("x"))).rejects.toThrow(LeaseError)
    await expect(leases.acquire("has space", inside("x"))).rejects.toThrow(LeaseError)
    await expect(leases.acquire("ok-slug", { branch: "phase/9-x", dir: "/tmp/not-managed" })).rejects.toThrow(
      LeaseError,
    )
    await expect(
      leases.acquire("ok-slug", { branch: "phase/9-x", dir: path.join(fx.root, ".factory", "evil") }),
    ).rejects.toThrow(LeaseError)
    await expect(leases.acquire("ok-slug", { branch: "", dir: path.join(fx.root, ".worktrees", "x") })).rejects.toThrow(
      LeaseError,
    )
  })
})
