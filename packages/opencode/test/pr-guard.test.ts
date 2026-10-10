// Cheap no-network guard tests for the release PR opener (bug #238):
// `ghPrOpener.open()` refuses `branch === base` and non-`factory/` branches
// before any push is attempted.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ghPrOpener } from "../src/pr.ts"

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

/** An empty git repo without any remote: any push attempt would fail loudly. */
const lonelyRepo = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-pr-guard-"))
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.name", "test")
  git(root, "config", "user.email", "test@test")
  git(root, "commit", "-q", "--allow-empty", "-m", "init")
  return root
}

const request = (root: string, branch: string, base = "main") => ({
  root,
  branch,
  base,
  title: "factory: test",
  body: "test body",
})

describe("ghPrOpener branch guard", () => {
  test("refuses branch === base", async () => {
    const root = await lonelyRepo()
    try {
      await expect(ghPrOpener.open(request(root, "main", "main"))).rejects.toThrow(/refusing to push/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refuses non-factory/ branches", async () => {
    const root = await lonelyRepo()
    try {
      for (const branch of ["feature/x", "improve/x", "main", "release-1", "factory"]) {
        await expect(ghPrOpener.open(request(root, branch))).rejects.toThrow(/refusing to push/)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the refusal precedes any push attempt", async () => {
    // No origin is configured, so a push attempt would fail with a remote
    // error — but the guard throws first, before git is ever invoked.
    const root = await lonelyRepo()
    // A bare remote stands in for GitHub: refused attempts must not create
    // or move any ref on it.
    const bare = await mkdtemp(path.join(tmpdir(), "es-pr-guard-bare-"))
    try {
      git(root, "init", "-q", "--bare", bare)
      git(root, "remote", "add", "origin", bare)
      git(root, "push", "-q", "origin", "main")
      const before = git(root, "ls-remote", bare)
      await expect(ghPrOpener.open(request(root, "main", "main"))).rejects.toThrow(/refusing to push/)
      await expect(ghPrOpener.open(request(root, "feature/x"))).rejects.toThrow(/refusing to push/)
      expect(git(root, "ls-remote", bare)).toBe(before)
      expect(before.split("\n")).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
    }
  })
})
