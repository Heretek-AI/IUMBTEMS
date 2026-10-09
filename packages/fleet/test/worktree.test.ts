// Fleet worktree coordinator (#124): isolated per-task worktrees, a locked
// registry, salvage + cleanup, gc, and gated transactional landing. Every
// case asserts the base branch never moves.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { git as coreGit } from "@heretek-ai/es-core"
import {
  allocateWorktree,
  fleetBranch,
  gcWorktrees,
  integrationBranch,
  landTask,
  loadRegistry,
  releaseWorktree,
} from "../src/worktree.ts"

const git = (cwd: string, ...args: string[]) => coreGit(cwd, args, { allowFail: true })

/** A temp repo with one commit on `main`; returns { root, base }. */
async function fixture(): Promise<{ root: string; base: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "es-fleet-wt-"))
  const cleanup = () => rm(root, { recursive: true, force: true })
  await git(root, "init", "-b", "main")
  await git(root, "config", "user.name", "fleet-test")
  await git(root, "config", "user.email", "fleet@test.local")
  await git(root, "config", "commit.gpgsign", "false")
  await writeFile(path.join(root, "file.txt"), "base\n")
  await git(root, "add", "-A")
  await git(root, "commit", "--no-verify", "-m", "base")
  const base = (await git(root, "rev-parse", "HEAD")).stdout.trim()
  return { root, base, cleanup }
}

const stateRoot = () => mkdtemp(path.join(tmpdir(), "es-fleet-wt-state-"))
const tip = (root: string, ref: string) => git(root, "rev-parse", ref).then((r) => r.stdout.trim())
const gatesOk = () => Promise.resolve({ ok: true as const })
const gatesNo = () => Promise.resolve({ ok: false as const, reason: "lint failed" })

describe("naming", () => {
  test("branches are namespaced and slugs are validated", () => {
    expect(fleetBranch("task-a")).toBe("fleet/task-a")
    expect(integrationBranch("dag-1")).toBe("fleet/integration/dag-1")
    expect(() => fleetBranch("../escape")).toThrow()
    expect(() => fleetBranch("Bad")).toThrow()
  })
})

describe("allocation", () => {
  test("each task gets its own worktree on its own branch from base", async () => {
    const { root, base, cleanup } = await fixture()
    const state = await stateRoot()
    try {
      const before = await tip(root, "main")
      const a = await allocateWorktree(root, state, "task-a", { base })
      const b = await allocateWorktree(root, state, "task-b", { base })
      expect(a.dir).not.toBe(b.dir)
      expect(a.branch).not.toBe(b.branch)
      expect((await git(root, "rev-parse", "HEAD")).stdout.trim()).toBe(before)
      expect(await tip(root, "main")).toBe(before)
      const registry = (await loadRegistry(state))!
      expect(Object.keys(registry.worktrees).sort()).toEqual(["task-a", "task-b"])
      expect(registry.worktrees["task-a"]).toMatchObject({ branch: "fleet/task-a", base, status: "allocated" })
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a double allocation is refused and the base never moves", async () => {
    const { root, base, cleanup } = await fixture()
    const state = await stateRoot()
    try {
      await allocateWorktree(root, state, "task-a", { base })
      await expect(allocateWorktree(root, state, "task-a", { base })).rejects.toThrow(/already has a worktree/)
      expect(await tip(root, "main")).toBe(base)
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("release and salvage", () => {
  test("release after a merge removes the worktree and keeps the branch", async () => {
    const { root, base, cleanup } = await fixture()
    const state = await stateRoot()
    try {
      const record = await allocateWorktree(root, state, "task-a", { base })
      await writeFile(path.join(record.dir, "work.txt"), "work\n")
      await git(record.dir, "add", "-A")
      await git(record.dir, "commit", "--no-verify", "-m", "task work")
      const landed = await landTask(root, state, "task-a", "dag-1", gatesOk)
      expect(landed).toMatchObject({ landed: true })
      const workTip = await tip(record.dir, "HEAD")
      await releaseWorktree(root, state, "task-a", "merged")
      const registry = (await loadRegistry(state))!
      expect(registry.worktrees["task-a"]!.status).toBe("merged")
      expect(await tip(root, "fleet/task-a")).toBe(workTip)
      expect(await tip(root, "main")).toBe(base)
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("abandoning anchors a salvage ref before removal", async () => {
    const { root, base, cleanup } = await fixture()
    const state = await stateRoot()
    try {
      const record = await allocateWorktree(root, state, "task-a", { base })
      await writeFile(path.join(record.dir, "work.txt"), "doomed\n")
      await git(record.dir, "add", "-A")
      await git(record.dir, "commit", "--no-verify", "-m", "doomed work")
      const workTip = await tip(record.dir, "HEAD")
      await releaseWorktree(root, state, "task-a", "abandoned")
      expect(await tip(root, "refs/fleet-salvage/task-a")).toBe(workTip)
      expect(await tip(root, "main")).toBe(base)
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("gated landing", () => {
  test("no merge happens when gates fail", async () => {
    const { root, base, cleanup } = await fixture()
    const state = await stateRoot()
    try {
      const record = await allocateWorktree(root, state, "task-a", { base })
      await writeFile(path.join(record.dir, "work.txt"), "x\n")
      await git(record.dir, "add", "-A")
      await git(record.dir, "commit", "--no-verify", "-m", "x")
      const result = await landTask(root, state, "task-a", "dag-1", gatesNo)
      expect(result).toMatchObject({ landed: false })
      expect("reason" in result && result.reason).toMatch(/lint failed/)
      const exists = await git(root, "show-ref", "--verify", "--quiet", "refs/heads/fleet/integration/dag-1")
      expect(exists.code).not.toBe(0)
      expect(await tip(root, "main")).toBe(base)
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a conflicting landing rolls back and reports conflict", async () => {
    const { root, base, cleanup } = await fixture()
    const state = await stateRoot()
    try {
      const a = await allocateWorktree(root, state, "task-a", { base })
      const b = await allocateWorktree(root, state, "task-b", { base })
      for (const [record, text] of [
        [a, "from-a\n"],
        [b, "from-b\n"],
      ] as const) {
        await writeFile(path.join(record.dir, "file.txt"), text)
        await git(record.dir, "add", "-A")
        await git(record.dir, "commit", "--no-verify", "-m", `change by ${record.taskId}`)
      }
      expect(await landTask(root, state, "task-a", "dag-1", gatesOk)).toMatchObject({ landed: true })
      const integrationTip = await tip(root, "fleet/integration/dag-1")
      const result = await landTask(root, state, "task-b", "dag-1", gatesOk)
      expect(result).toMatchObject({ landed: false, conflict: true })
      expect(await tip(root, "fleet/integration/dag-1")).toBe(integrationTip)
      expect(await tip(root, "main")).toBe(base)
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("gc", () => {
  test("orphaned worktrees are salvaged and removed, records dropped", async () => {
    const { root, base, cleanup } = await fixture()
    const state = await stateRoot()
    try {
      const record = await allocateWorktree(root, state, "task-a", { base })
      await writeFile(path.join(record.dir, "work.txt"), "orphan\n")
      await git(record.dir, "add", "-A")
      await git(record.dir, "commit", "--no-verify", "-m", "orphan work")
      // Simulate a lost registry (crashed daemon): wipe state, keep repo.
      await rm(state, { recursive: true, force: true })
      const fresh = state
      await mkdir(fresh, { recursive: true })
      const report = await gcWorktrees(root, fresh)
      expect(report.removed.length).toBe(1)
      expect(report.salvaged).toContain("fleet/task-a")
      expect(await tip(root, "main")).toBe(base)
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })
})
