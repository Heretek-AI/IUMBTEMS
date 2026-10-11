// Release base-branch safety: the factory release pushes a `factory/`
// branch only, `branch == base` (or a non-`factory/` branch) is refused
// before anything is pushed, and the base SHA on the remote is
// byte-identical afterwards.
// Union of the audit (#202) and remediation suites at the #290 merge: the
// remediation side proves refusal and push shape against a fast local
// bare-remote fixture (no host boot); the audit side drives a full run to
// RELEASE on the real host and proves the argv, the real push, the
// es_release refusal and recordPr-to-DONE through it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildPrArgs,
  Factory,
  git,
  type HumanSigner,
  recordApproval,
  researchSourcesDir,
  SourceCache,
  sealHumanKey,
  stringifyFrontmatter,
  unlockHumanKey,
  writeJson,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { ghPrOpener } from "../src/pr.ts"

const BASE = "main"
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
      expect(await remoteBranches(fx.remote)).toEqual(["refs/heads/main"])
      expect(await remoteSha(fx.remote, "refs/heads/main")).toBe(fx.baseSha)
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
      expect(await remoteBranches(fx.remote)).toEqual(["refs/heads/main"])
      expect(await remoteSha(fx.remote, "refs/heads/main")).toBe(fx.baseSha)
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
        ["refs/heads/factory/run-test-1/integration", "refs/heads/main"].sort(),
      )
      expect(await remoteSha(fx.remote, `refs/heads/${BRANCH}`)).toBe(local)
      expect(await remoteSha(fx.remote, "refs/heads/main")).toBe(fx.baseSha)
      // The release PR itself is a draft against the base.
      const argv = buildPrArgs({ branch: BRANCH, base: BASE, title: "t", body: "b" })
      expect(argv.slice(0, 4)).toEqual(["gh", "pr", "create", "--draft"])
      expect(argv.slice(argv.indexOf("--base") + 1, argv.indexOf("--base") + 2)).toEqual([BASE])
    } finally {
      await fx.cleanup()
    }
  })
})

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const green = { passed: true, findings: [] as never[], summary: "green" }

const gitSync = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

let h: Harness
let state: string
let signer: HumanSigner
let bare: string
let binDir: string
let captureFile: string
let baseBefore: string

const factory = () => new Factory(h.directory, { gates: async () => green, stateDir: state })

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-release-state-"))
  await sealHumanKey("test-passphrase-202", state)
  signer = await unlockHumanKey("test-passphrase-202", state)
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# release safety\n" },
  })
  // A local bare remote stands in for GitHub: file transport, no network.
  bare = await mkdtemp(path.join(tmpdir(), "es-release-bare-"))
  gitSync(h.directory, "init", "-q", "--bare", bare)
  gitSync(h.directory, "remote", "add", "origin", bare)
  gitSync(h.directory, "push", "-q", "origin", "main")
  baseBefore = gitSync(h.directory, "rev-parse", "main")

  // A fake `gh`: `auth status` succeeds, `pr create` captures its argv and
  // reports a PR URL. The capture path is baked in because the runner
  // scrubs the environment (only PATH survives).
  binDir = await mkdtemp(path.join(tmpdir(), "es-release-bin-"))
  captureFile = path.join(binDir, "pr-argv.txt")
  const gh = path.join(binDir, "gh")
  await writeFile(
    gh,
    `#!/bin/sh\nif [ "$1" = "auth" ]; then exit 0; fi\ni=0\nfor a in "$@"; do printf 'arg%s=%s\\n' "$i" "$a" >> '${captureFile}'; i=$((i + 1)); done\nprintf '%s\\n' '---' >> '${captureFile}'\nprintf '%s\\n' 'https://example.test/pr/7'\nexit 0\n`,
  )
  await chmod(gh, 0o755)
}, 60_000)

afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
  await rm(bare, { recursive: true, force: true })
  await rm(binDir, { recursive: true, force: true })
})

/** Drive the shared-state run to RELEASE with direct core calls (one phase). */
const toRelease = async () => {
  await factory().begin("human:tester")
  await factory().writeFrontier("grill", {
    version: "1.1",
    idea: "a greeting library",
    spendCeiling: { currency: "USD", maxAmount: 10 },
    settled: true,
    nodes: [{ id: "lang", question: "Language?", answer: "TypeScript", status: "settled" }],
  })
  await recordApproval(h.directory, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
  await factory().beginResearch("human:tester")
  const cache = new SourceCache(researchSourcesDir(h.directory), state)
  const source = await cache.put({
    url: "https://example.test/greeting",
    text: "Greeting libraries usually expose a single greet function.",
    provider: "fetch",
  })
  await mkdir(path.join(h.directory, ".factory/research"), { recursive: true })
  await writeFile(
    path.join(h.directory, ".factory/research/REPORT.md"),
    `# Research\n\n- A greet function is the conventional API [VERIFIED: sha256:${source.meta.sha256} "expose a single greet function"]\n`,
  )
  await factory().completeResearch("factory")
  await writeJson(path.join(h.directory, ".factory/roadmap.json"), {
    version: 1,
    title: "Greeting library",
    phases: [{ id: "alpha", title: "Greet" }],
  })
  await mkdir(path.join(h.directory, ".factory/specs/alpha"), { recursive: true })
  await writeFile(
    path.join(h.directory, ".factory/specs/alpha/GOAL.md"),
    stringifyFrontmatter(
      {
        phase: "alpha",
        title: "alpha",
        acceptance: [{ kind: "file", id: "impl", description: "implementation exists", path: "src/alpha.ts" }],
      },
      "Implement alpha.\n",
    ),
  )
  await recordApproval(h.directory, { stage: "spec", channel: "cli", approvedBy: "tester", signer })
  await factory().startBuild("factory")
  const wt = (await factory().activeWorktree())!
  const rel = (file: string) => path.relative(h.directory, path.join(wt, file))
  await mkdir(path.dirname(path.join(h.directory, rel("test/alpha.test.ts"))), { recursive: true })
  await writeFile(path.join(h.directory, rel("test/alpha.test.ts")), 'test("alpha", () => {})\n')
  await factory().recordGateRun("es-programmer", {
    passed: false,
    findings: [],
    summary: "red",
    failedTests: ["test/alpha.test.ts"],
  })
  await mkdir(path.dirname(path.join(h.directory, rel("src/alpha.ts"))), { recursive: true })
  await writeFile(path.join(h.directory, rel("src/alpha.ts")), "export const alpha = 1\n")
  await factory().complete("es-programmer")
  await factory().qaVerdict("es-qa-functional", "pass", "criteria met")
  await factory().qaVerdict("es-qa-adversarial", "pass", "nothing broke")
  const runState = (await factory().read())!
  expect(runState.stage).toBe("RELEASE")
  return runState
}

describe("release on the real host against a local bare remote", () => {
  test("the release argv names factory/... as a draft on the base; branch == base is refused", async () => {
    const runState = await toRelease()
    const branch = runState.runBranch!
    const base = runState.baseBranch!
    expect(branch).toMatch(/^factory\//)
    expect(base).toBe("main")

    // The argv the opener would use: a draft PR from the run branch onto base.
    const argv = buildPrArgs({ branch, base, title: "factory: Greet", body: "release body for #202" })
    expect(argv.slice(0, 4)).toEqual(["gh", "pr", "create", "--draft"])
    expect(argv[argv.indexOf("--head") + 1]).toBe(branch)
    expect(argv[argv.indexOf("--base") + 1]).toBe("main")

    // branch === base is refused before anything is pushed: the remote still
    // holds only the base.
    await expect(ghPrOpener.open({ root: h.directory, branch: base, base, title: "t", body: "b" })).rejects.toThrow(
      /refusing to push/,
    )
    expect(gitSync(h.directory, "ls-remote", bare).split("\n")).toHaveLength(1)
  }, 120_000)

  test("the real opener pushes factory/... only; the base SHA is unchanged; es_release stays refused", async () => {
    const runState = (await factory().read())!
    const branch = runState.runBranch!
    const savedPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`
    try {
      expect(await ghPrOpener.available(h.directory)).toBe(true)
      const opened = await ghPrOpener.open({
        root: h.directory,
        branch,
        base: "main",
        title: "factory: Greet",
        body: "release body for #202",
      })
      expect(opened.url).toBe("https://example.test/pr/7")

      // The draft PR went to the base from the run branch — nothing else.
      const captured = (await readFile(captureFile, "utf8"))
        .split("\n")
        .filter((line: string) => line.startsWith("arg"))
        .map((line: string) => line.slice(line.indexOf("=") + 1))
      expect(captured).toContain("--draft")
      expect(captured[captured.indexOf("--head") + 1]).toBe(branch)
      expect(captured[captured.indexOf("--base") + 1]).toBe("main")

      // The remote gained exactly the run branch; the base SHA is unchanged
      // on disk and on the remote.
      const refs = new Map(
        gitSync(h.directory, "ls-remote", bare)
          .split("\n")
          .filter(Boolean)
          .map((line: string) => {
            const [sha, ref] = line.split("\t")
            return [ref, sha] as const
          }),
      )
      expect([...refs.keys()].sort()).toEqual(["refs/heads/main", `refs/heads/${branch}`].sort())
      expect(refs.get("refs/heads/main")).toBe(baseBefore)
      expect(refs.get(`refs/heads/${branch}`)).toBe(gitSync(h.directory, "rev-parse", branch))
      expect(gitSync(h.directory, "rev-parse", "main")).toBe(baseBefore)

      // With `pr: "off"` the host tool refuses instead of pushing: the stage
      // stays RELEASE for the human, and the remote does not move.
      const refsBeforeTool = gitSync(h.directory, "ls-remote", bare)
      const refused = await h.run(`ship ${call("es_release", {})}`, { agent: "factory" })
      expect(refused.tools[0]?.status).toBe("error")
      expect((await factory().read())?.stage).toBe("RELEASE")
      expect(gitSync(h.directory, "ls-remote", bare)).toBe(refsBeforeTool)

      // The human records the PR; the run is DONE.
      const done = await factory().recordPr("tester", "https://example.test/pr/9")
      expect([done.stage, done.release?.prUrl]).toEqual(["DONE", "https://example.test/pr/9"])
    } finally {
      process.env.PATH = savedPath
    }
  }, 120_000)
})
