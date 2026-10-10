// Release base-branch safety on the real host (issue #202): with a local
// bare remote standing in for GitHub (file transport, no network) and a fake
// `gh` on PATH (no real GitHub CLI), the release opener pushes the run's
// `factory/...` integration branch only, opens the PR as a draft, and refuses
// `branch === base` before anything is pushed. The harness itself runs with
// `pr: "off"`, so the `es_release` tool refuses and the base SHA is unchanged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildPrArgs,
  Factory,
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

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const green = { passed: true, findings: [] as never[], summary: "green" }

const git = (cwd: string, ...args: string[]) => {
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
  git(h.directory, "init", "-q", "--bare", bare)
  git(h.directory, "remote", "add", "origin", bare)
  git(h.directory, "push", "-q", "origin", "main")
  baseBefore = git(h.directory, "rev-parse", "main")

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
    expect(git(h.directory, "ls-remote", bare).split("\n")).toHaveLength(1)
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
        git(h.directory, "ls-remote", bare)
          .split("\n")
          .filter(Boolean)
          .map((line: string) => {
            const [sha, ref] = line.split("\t")
            return [ref, sha] as const
          }),
      )
      expect([...refs.keys()].sort()).toEqual(["refs/heads/main", `refs/heads/${branch}`].sort())
      expect(refs.get("refs/heads/main")).toBe(baseBefore)
      expect(refs.get(`refs/heads/${branch}`)).toBe(git(h.directory, "rev-parse", branch))
      expect(git(h.directory, "rev-parse", "main")).toBe(baseBefore)

      // With `pr: "off"` the host tool refuses instead of pushing: the stage
      // stays RELEASE for the human, and the remote does not move.
      const refsBeforeTool = git(h.directory, "ls-remote", bare)
      const refused = await h.run(`ship ${call("es_release", {})}`, { agent: "factory" })
      expect(refused.tools[0]?.status).toBe("error")
      expect((await factory().read())?.stage).toBe("RELEASE")
      expect(git(h.directory, "ls-remote", bare)).toBe(refsBeforeTool)

      // The human records the PR; the run is DONE.
      const done = await factory().recordPr("tester", "https://example.test/pr/9")
      expect([done.stage, done.release?.prUrl]).toEqual(["DONE", "https://example.test/pr/9"])
    } finally {
      process.env.PATH = savedPath
    }
  }, 120_000)
})
