// Issue #205 opener half: `ghPrOpener.open` with `preset: self-dogfood` and
// `--base main` refuses before anything is pushed. Local bare remote only, no
// network and no `gh` invocation: the shared argv builder throws first, so the
// test asserts the bare remote holds no new ref afterwards.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "@heretek-ai/es-core"
import { ghPrOpener } from "../src/pr.ts"

const sh = async (args: string[], cwd: string) => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

const showRefs = async (bare: string, cwd: string) =>
  (await run(["git", "--git-dir", bare, "show-ref"], { cwd })).stdout.trim()

describe("self-dogfood opener refuses --base main without pushing (#205)", () => {
  test("preset run against main is refused and the remote is unchanged", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "es-205-bare-"))
    const repo = await mkdtemp(path.join(tmpdir(), "es-205-repo-"))
    try {
      await sh(["init", "--bare", "-q"], bare)
      await sh(["init", "-q", "-b", "rewrite"], repo)
      await sh(["config", "user.email", "t@t"], repo)
      await sh(["config", "user.name", "t"], repo)
      await sh(["remote", "add", "origin", bare], repo)
      await Bun.write(path.join(repo, "base.txt"), "base\n")
      await sh(["add", "base.txt"], repo)
      await sh(["commit", "-q", "-m", "init"], repo)
      await sh(["push", "-q", "origin", "rewrite"], repo)
      await sh(["checkout", "-qb", "factory/run-205/integration"], repo)
      await Bun.write(path.join(repo, "work.txt"), "work\n")
      await sh(["add", "work.txt"], repo)
      await sh(["commit", "-q", "-m", "work"], repo)

      const before = await showRefs(bare, repo)
      expect(before).toContain("refs/heads/rewrite")
      expect(before).not.toContain("factory/run-205/integration")

      await expect(
        ghPrOpener.open({
          root: repo,
          branch: "factory/run-205/integration",
          base: "main",
          title: "dogfood",
          body: "body",
          preset: "self-dogfood",
        }),
      ).rejects.toThrow(/refusing.*main|rewrite/)

      // Refusal happened before the push: the bare remote is byte-identical.
      const after = await showRefs(bare, repo)
      expect(after).toBe(before)
      expect(after).not.toContain("factory/run-205/integration")
      const lsRemote = await run(["git", "ls-remote", "origin"], { cwd: repo })
      expect(lsRemote.stdout).not.toContain("factory/run-205/integration")
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
    }
  })
})
