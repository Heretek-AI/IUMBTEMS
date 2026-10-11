// PR-opener guard (#238): `ghPrOpener.open()` refuses `branch === base`
// and non-`factory/` branches before any git call, and builds the draft-PR
// argv through the shared builder. No network and no `gh` invocation: every
// refusal throws before the push, and the draft shape is asserted on the
// argv (the `gh pr create` spawn itself never runs in tests).
// Union of the audit (#202) and remediation suites at the #290 merge: the
// remediation side proves refusal order without any repo (plus the preset
// guard and argv shape); the audit side additionally proves against a real
// repo with a bare remote that refused attempts move no ref.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildPrArgs } from "@heretek-ai/es-core"
import { ghPrOpener } from "../src/pr.ts"

const open = (root: string, overrides: { branch: string; base?: string; preset?: string } = { branch: "x" }) =>
  ghPrOpener.open({
    root,
    branch: overrides.branch,
    base: overrides.base ?? "main",
    title: "t",
    body: "b",
    ...(overrides.preset !== undefined ? { preset: overrides.preset } : {}),
  })

const gitSync = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

/** An empty git repo without any remote: any push attempt would fail loudly. */
const lonelyRepo = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-pr-guard-"))
  gitSync(root, "init", "-q", "-b", "main")
  gitSync(root, "config", "user.name", "test")
  gitSync(root, "config", "user.email", "test@test")
  gitSync(root, "commit", "-q", "--allow-empty", "-m", "init")
  return root
}

describe("ghPrOpener.open() branch guard", () => {
  test("branch === base is refused", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-pr-guard-"))
    try {
      await expect(open(root, { branch: "main", base: "main" })).rejects.toThrow(/refusing to push "main"/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("non-factory/ branches are refused", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-pr-guard-"))
    try {
      for (const branch of ["main", "feature/x", "improve/20260101", "factory"]) {
        await expect(open(root, { branch })).rejects.toThrow(/refusing to push/)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the refusal precedes any git call (a non-repo root still reports the refusal)", async () => {
    // `root` is not a git repository: had the push run first, the failure
    // would be git's, not the guard's. The guard's error proves the order
    // (`pr.ts` checks the branch before `git push --set-upstream`).
    const root = await mkdtemp(path.join(tmpdir(), "es-pr-guard-"))
    try {
      await open(root, { branch: "main", base: "main" })
      expect.unreachable("a non-factory/ branch must be refused")
    } catch (error) {
      expect((error as Error).message).toMatch(/refusing to push "main"/)
      expect((error as Error).message).not.toMatch(/git/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the branch guard runs before the preset-base guard", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-pr-guard-"))
    try {
      await open(root, { branch: "main", base: "main", preset: "self-dogfood" })
      expect.unreachable("branch == base must be refused first")
    } catch (error) {
      expect((error as Error).message).toMatch(/refusing to push "main"/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refused attempts move no ref on a real repo with a bare remote", async () => {
    // The audit side of the union: same refusal, proven by side effect
    // (no ref created or moved) rather than by error precedence.
    const root = await lonelyRepo()
    // A bare remote stands in for GitHub: refused attempts must not create
    // or move any ref on it.
    const bare = await mkdtemp(path.join(tmpdir(), "es-pr-guard-bare-"))
    try {
      gitSync(root, "init", "-q", "--bare", bare)
      gitSync(root, "remote", "add", "origin", bare)
      gitSync(root, "push", "-q", "origin", "main")
      const before = gitSync(root, "ls-remote", bare)
      await expect(
        ghPrOpener.open({ root, branch: "main", base: "main", title: "factory: test", body: "test body" }),
      ).rejects.toThrow(/refusing to push/)
      await expect(
        ghPrOpener.open({ root, branch: "feature/x", base: "main", title: "factory: test", body: "test body" }),
      ).rejects.toThrow(/refusing to push/)
      expect(gitSync(root, "ls-remote", bare)).toBe(before)
      expect(before.split("\n")).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
    }
  })
})

describe("release PR argv", () => {
  test("a factory branch opens a draft PR against the base", () => {
    const argv = buildPrArgs({ branch: "factory/run-1/integration", base: "main", title: "t", body: "b" })
    expect(argv.slice(0, 4)).toEqual(["gh", "pr", "create", "--draft"])
    expect(argv.slice(argv.indexOf("--head") + 1, argv.indexOf("--head") + 2)).toEqual(["factory/run-1/integration"])
    expect(argv.slice(argv.indexOf("--base") + 1, argv.indexOf("--base") + 2)).toEqual(["main"])
  })
})
