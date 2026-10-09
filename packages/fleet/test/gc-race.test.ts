// S5.1 gc race (repair-151): the allocator pre-registers `allocating` under
// the fleet lock before `addWorktree`, and gc holds the fleet lock for its
// whole read -> decide -> persist inside the repo lock. A gc landing between
// `addWorktree` and the commit must keep the new worktree and its record.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { git as coreGit } from "@heretek-ai/es-core"
import { allocateWorktree, gcWorktrees, loadRegistry } from "../src/worktree.ts"

const git = (cwd: string, ...args: string[]) => coreGit(cwd, args, { allowFail: true })

async function fixture(): Promise<{ root: string; base: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "es-fleet-gcrace-"))
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

const stateRoot = () => mkdtemp(path.join(tmpdir(), "es-fleet-gcrace-state-"))
const tip = (root: string, ref: string) => git(root, "rev-parse", ref).then((r) => r.stdout.trim())

describe("gc race (S5.1)", () => {
  test("gc in the allocation window keeps the new worktree and its record", async () => {
    const { root, base, cleanup } = await fixture()
    const state = await stateRoot()
    try {
      let hooked = false
      const record = await allocateWorktree(root, state, "task-race", {
        base,
        hooks: {
          afterAdd: async () => {
            hooked = true
            await gcWorktrees(root, state)
          },
        },
      })
      expect(hooked).toBe(true)
      expect(record.status).toBe("allocated")
      const listed = (await git(root, "worktree", "list", "--porcelain")).stdout
      expect(listed).toContain(record.dir)
      const registry = await loadRegistry(state)
      expect(registry?.worktrees["task-race"]?.status).toBe("allocated")
      expect(await tip(root, "main")).toBe(base)
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a stale allocating record with no dir or branch is dropped", async () => {
    const { root, base, cleanup } = await fixture()
    const state = await stateRoot()
    try {
      const dir = path.join(root, ".fleet", "worktrees", "task-stale")
      await mkdir(path.join(state, "fleet"), { recursive: true })
      await writeFile(
        path.join(state, "fleet", "worktrees.json"),
        JSON.stringify({
          v: 1,
          worktrees: {
            "task-stale": {
              taskId: "task-stale",
              dir,
              branch: "fleet/task-stale",
              base,
              createdAt: "2020-01-01T00:00:00.000Z",
              status: "allocating",
            },
          },
        }),
      )
      const report = await gcWorktrees(root, state)
      expect(report.dropped).toContain("task-stale")
      expect(await tip(root, "main")).toBe(base)
    } finally {
      await cleanup()
      await rm(state, { recursive: true, force: true })
    }
  })
})
