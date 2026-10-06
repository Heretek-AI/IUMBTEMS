import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import * as Git from "../src/worktree/index.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

let fx: Fixture
beforeEach(async () => {
  fx = await gitRepo("es-wt-")
})
afterEach(() => fx.cleanup())

describe("git worktree ops", () => {
  test("worktree lifecycle, commit, diff and ancestry without touching the main checkout", async () => {
    const base = await Git.headCommit(fx.root)
    const dir = path.join(fx.root, ".factory/worktrees/p1")
    await Git.addWorktree(fx.root, dir, "factory/run/phase-p1", base)
    expect(await Git.currentBranch(fx.root)).toBe("main")
    expect(await Git.currentBranch(dir)).toBe("factory/run/phase-p1")

    await mkdir(path.join(dir, "src"), { recursive: true })
    await writeFile(path.join(dir, "src/a.ts"), "export const a = 1\nexport const b = 2\n")
    const stats = await Git.diffStats(dir, base)
    expect(stats.files).toEqual(["src/a.ts"])
    expect(stats.added).toBe(2)

    const commit = await Git.commitAll(dir, "phase p1")
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(await Git.commitAll(dir, "nothing")).toBeUndefined()
    expect(await Git.isAncestor(fx.root, base, commit!)).toBe(true)
    expect((await Git.commitFiles(dir, base))[0]?.files).toEqual(["src/a.ts"])

    await Git.removeWorktree(fx.root, dir)
    expect(await Bun.file(path.join(dir, "src/a.ts")).exists()).toBe(false)
    expect(await Git.branchExists(fx.root, "factory/run/phase-p1")).toBe(true)
  })

  test("tree fingerprint changes when the checkout changes", async () => {
    const before = await Git.treeFingerprint(fx.root)
    await writeFile(path.join(fx.root, "new.txt"), "x")
    expect(await Git.treeFingerprint(fx.root)).not.toBe(before)
  })
})
