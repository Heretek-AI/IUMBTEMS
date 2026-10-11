// Release base-branch safety against a local bare remote (#238): the
// factory release pushes a `factory/` branch only, `branch == base` (or a
// non-`factory/` branch) is refused before anything is pushed, and the base
// SHA on the remote is byte-identical afterwards. Local bare-remote fixture
// only (no real remote, no network); `gh` is never invoked — the authorized
// push runs the same `git push --set-upstream origin <branch>:<branch>`
// argv `pr.ts` uses, and the draft shape is asserted on the shared argv.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildPrArgs, git } from "@heretek-ai/es-core"
import { ghPrOpener } from "../src/pr.ts"

const BASE = "rewrite"
const BRANCH = "factory/run-test-1/integration"

interface Remote {
  readonly root: string
  readonly remote: string
  readonly baseSha: string
  cleanup(): Promise<void>
}

/** A repo with a base branch pushed to a local bare remote, plus one factory-branch commit. */
async function bareRemote(): Promise<Remote> {
  const root = await mkdtemp(path.join(tmpdir(), "es-release-"))
  const remote = await mkdtemp(path.join(tmpdir(), "es-release-remote-"))
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
  try {
    await git(remote, ["init", "--bare", "-q"])
    await git(root, ["init", "-q", "-b", BASE])
    await writeFile(path.join(root, "README.md"), "# release fixture\n")
    await git(root, ["add", "-A"])
    await git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"])
    await git(root, ["remote", "add", "origin", remote])
    await git(root, ["push", "-q", "-u", "origin", `${BASE}:${BASE}`])
    const baseSha = (await git(root, ["rev-parse", BASE])).stdout.trim()
    await git(root, ["checkout", "-q", "-b", BRANCH])
    await writeFile(path.join(root, "work.txt"), "factory work\n")
    await git(root, ["add", "-A"])
    await git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "factory work"])
    return { root, remote, baseSha, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

const remoteSha = async (remote: string, ref: string) =>
  (await git(remote, ["rev-parse", "--verify", ref])).stdout.trim()

const remoteBranches = async (remote: string) =>
  (await git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/"])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

describe("release against a local bare remote", () => {
  test("branch == base is refused and the remote is untouched", async () => {
    const fx = await bareRemote()
    try {
      await expect(ghPrOpener.open({ root: fx.root, branch: BASE, base: BASE, title: "t", body: "b" })).rejects.toThrow(
        `refusing to push "${BASE}"`,
      )
      expect(await remoteBranches(fx.remote)).toEqual(["refs/heads/rewrite"])
      expect(await remoteSha(fx.remote, "refs/heads/rewrite")).toBe(fx.baseSha)
    } finally {
      await fx.cleanup()
    }
  })

  test("a non-factory/ branch is refused and the remote is untouched", async () => {
    const fx = await bareRemote()
    try {
      await expect(
        ghPrOpener.open({ root: fx.root, branch: "feature/x", base: BASE, title: "t", body: "b" }),
      ).rejects.toThrow(/refusing to push/)
      expect(await remoteBranches(fx.remote)).toEqual(["refs/heads/rewrite"])
      expect(await remoteSha(fx.remote, "refs/heads/rewrite")).toBe(fx.baseSha)
    } finally {
      await fx.cleanup()
    }
  })

  test("the authorized push lands only the factory branch; the base SHA is byte-identical", async () => {
    const fx = await bareRemote()
    try {
      const local = (await git(fx.root, ["rev-parse", BRANCH])).stdout.trim()
      // The same argv `pr.ts` pushes with (the `gh pr create` spawn never
      // runs in tests: no `gh` invocation here).
      await git(fx.root, ["push", "--set-upstream", "origin", `${BRANCH}:${BRANCH}`])
      expect(await remoteBranches(fx.remote)).toEqual(
        ["refs/heads/factory/run-test-1/integration", "refs/heads/rewrite"].sort(),
      )
      expect(await remoteSha(fx.remote, `refs/heads/${BRANCH}`)).toBe(local)
      expect(await remoteSha(fx.remote, "refs/heads/rewrite")).toBe(fx.baseSha)
      // The release PR itself is a draft against the base.
      const argv = buildPrArgs({ branch: BRANCH, base: BASE, title: "t", body: "b" })
      expect(argv.slice(0, 4)).toEqual(["gh", "pr", "create", "--draft"])
      expect(argv.slice(argv.indexOf("--base") + 1, argv.indexOf("--base") + 2)).toEqual([BASE])
    } finally {
      await fx.cleanup()
    }
  })
})
