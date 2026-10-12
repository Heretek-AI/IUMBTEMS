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

// Publish workflow guards (#328): the new `publish.yml` steps are executed
// here with fake `bun`/`git`/`gh` binaries, the existing fake-binary style.
// The guard refuses a non-dry-run publish when the three release manifests
// disagree with each other or with the top CHANGELOG entry, or when the tag
// already exists; the tag-and-release step tags the published commit and
// releases the CHANGELOG notes.
const workflowRoot = path.resolve(import.meta.dir, "../../..")
const readWorkflow = () => readFile(path.join(workflowRoot, ".github/workflows/publish.yml"), "utf8")

/** The `run: |` body of the step called `name`, dedented. Fails when absent. */
const extractStep = (yml: string, name: string): string => {
  const lines = yml.split("\n")
  const plain = (line: string) => line.trim().replace(/^(- name: )"(.*)"$/, "$1$2")
  const at = lines.findIndex((line) => plain(line) === `- name: ${name}`)
  expect(at).toBeGreaterThan(-1)
  const runAt = lines.findIndex((line, index) => index > at && /^\s*run: \|/.test(line))
  expect(runAt).toBeGreaterThan(-1)
  const indent = lines[runAt]!.search(/\S/)
  const body: string[] = []
  for (let i = runAt + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "") {
      body.push("")
      continue
    }
    if (line.search(/\S/) <= indent) break
    body.push(line.slice(indent + 2))
  }
  const script = body.join("\n").replace(/\n+$/, "")
  expect(script).not.toBe("")
  return script
}

interface GuardFixture {
  readonly root: string
  readonly bin: string
  readonly log: string
}

/** A fixture repo root with three release manifests, a CHANGELOG and fake binaries. */
const guardFixture = async (
  versions: readonly [string, string, string],
  changelogTop: string,
): Promise<GuardFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "es-publish-guard-"))
  const bin = await mkdtemp(path.join(tmpdir(), "es-publish-guard-bin-"))
  const log = path.join(bin, "calls.txt")
  const dirs = ["core", "cli", "opencode"] as const
  for (let i = 0; i < dirs.length; i++) {
    await mkdir(path.join(root, "packages", dirs[i]!), { recursive: true })
    await writeFile(
      path.join(root, "packages", dirs[i]!, "package.json"),
      `${JSON.stringify({ name: `@scope/${dirs[i]}`, version: versions[i] }, null, 2)}\n`,
    )
  }
  await writeFile(
    path.join(root, "CHANGELOG.md"),
    `# Changelog\n\n## ${changelogTop} — 2026-10-11\n\nThe headline feature ships.\n\n## 2.2.0 — 2026-10-11\n\nOlder notes.\n`,
  )
  await writeFile(
    path.join(bin, "bun"),
    `#!/bin/sh\nif [ "$1" = "scripts/packages.ts" ]; then\nprintf 'core heretek-ai-es-core\\ncli heretek-ai-es-cli\\nopencode heretek-ai-epistemic-swarm\\n'\nexit 0\nfi\necho "fake bun: unexpected $*" >&2\nexit 99\n`,
  )
  await writeFile(
    path.join(bin, "git"),
    `#!/bin/sh\necho "git $*" >> '${log}'\nif [ "$1" = "ls-remote" ]; then\nif [ "\${FAKE_GIT_TAG_EXISTS:-0}" = "1" ]; then exit 0; else exit 1; fi\nfi\nexit 0\n`,
  )
  await writeFile(
    path.join(bin, "gh"),
    // The real `gh` inside Actions refuses when GH_TOKEN is unset (exit 4);
    // mirror that so a missing token wiring fails here, not in the release.
    `#!/bin/sh\nif [ "$1" = "release" ] && [ -z "$GH_TOKEN" ]; then\necho "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable." >&2\nexit 4\nfi\necho "gh $*" >> '${log}'\nexit 0\n`,
  )
  for (const tool of ["bun", "git", "gh"]) await chmod(path.join(bin, tool), 0o755)
  return { root, bin, log }
}

const rmGuard = async (fx: GuardFixture) => {
  await rm(fx.root, { recursive: true, force: true })
  await rm(fx.bin, { recursive: true, force: true })
}

/** Run an extracted workflow script with the fixture on PATH; env keys override process.env. */
const runStep = (script: string, fx: GuardFixture, env: Record<string, string>) => {
  // NOTE: Bun.spawnSync does not pick up process.env mutations, so the
  // environment is passed explicitly (spread first, so the current PATH
  // and HOME survive under the fake bin dir).
  const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
    cwd: fx.root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}` },
  })
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

describe("publish workflow guards (#328)", () => {
  test("agreeing manifests and CHANGELOG pass the guard; the tag stays free", async () => {
    const fx = await guardFixture(["2.3.0", "2.3.0", "2.3.0"], "2.3.0")
    try {
      const script = extractStep(await readWorkflow(), "Publish guard: version parity and free tag")
      const run = runStep(script, fx, { DRY_RUN: "false", FAKE_GIT_TAG_EXISTS: "0" })
      expect(run.exitCode).toBe(0)
      expect(run.stdout).toMatch(/2\.3\.0 agreed/)
    } finally {
      await rmGuard(fx)
    }
  })

  test("manifests disagree → refuse before anything is published", async () => {
    const fx = await guardFixture(["2.3.0", "2.3.0", "9.9.9"], "2.3.0")
    try {
      const script = extractStep(await readWorkflow(), "Publish guard: version parity and free tag")
      const run = runStep(script, fx, { DRY_RUN: "false", FAKE_GIT_TAG_EXISTS: "0" })
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toMatch(/disagree/)
    } finally {
      await rmGuard(fx)
    }
  })

  test("a CHANGELOG skew → refuse before anything is published", async () => {
    const fx = await guardFixture(["2.3.0", "2.3.0", "2.3.0"], "9.9.9")
    try {
      const script = extractStep(await readWorkflow(), "Publish guard: version parity and free tag")
      const run = runStep(script, fx, { DRY_RUN: "false", FAKE_GIT_TAG_EXISTS: "0" })
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toMatch(/CHANGELOG/)
    } finally {
      await rmGuard(fx)
    }
  })

  test("an existing tag → refuse a second publish of the same version", async () => {
    const fx = await guardFixture(["2.3.0", "2.3.0", "2.3.0"], "2.3.0")
    try {
      const script = extractStep(await readWorkflow(), "Publish guard: version parity and free tag")
      const run = runStep(script, fx, { DRY_RUN: "false", FAKE_GIT_TAG_EXISTS: "1" })
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toMatch(/already exists/)
    } finally {
      await rmGuard(fx)
    }
  })

  test("a dry run skips every guard check", async () => {
    const fx = await guardFixture(["2.3.0", "2.3.0", "9.9.9"], "9.9.9")
    try {
      const script = extractStep(await readWorkflow(), "Publish guard: version parity and free tag")
      const run = runStep(script, fx, { DRY_RUN: "true", FAKE_GIT_TAG_EXISTS: "1" })
      expect(run.exitCode).toBe(0)
    } finally {
      await rmGuard(fx)
    }
  })

  test("tag and release: the published commit is tagged and the CHANGELOG notes released", async () => {
    const fx = await guardFixture(["2.3.0", "2.3.0", "2.3.0"], "2.3.0")
    try {
      const script = extractStep(await readWorkflow(), "Create tag and GitHub release")
      // GH_TOKEN is what the workflow's step-level `env:` provides in Actions.
      const run = runStep(script, fx, { GITHUB_SHA: "abc123", GH_TOKEN: "fake-token" })
      expect(run.exitCode).toBe(0)
      const calls = await readFile(fx.log, "utf8")
      expect(calls).toContain("tag -a v2.3.0")
      expect(calls).toContain("abc123")
      expect(calls).toContain("push origin v2.3.0")
      expect(calls).toContain("release create v2.3.0")
      expect(calls).toContain("--target abc123")
      expect(calls).toContain("The headline feature ships.")
    } finally {
      await rmGuard(fx)
    }
  })

  test("the release step authenticates gh: GH_TOKEN is wired to github.token", async () => {
    const yml = await readWorkflow()
    const lines = yml.split("\n")
    const at = lines.findIndex((line) => line.trim() === "- name: Create tag and GitHub release")
    expect(at).toBeGreaterThan(-1)
    const runAt = lines.findIndex((line, index) => index > at && /^\s*run: \|/.test(line))
    expect(runAt).toBeGreaterThan(at)
    // The `env:` block sits between `- name:` and `run: |`; it must hand the
    // Actions token to `gh release create` (exit 4 without it, 2026-10-12).
    const header = lines.slice(at, runAt).join("\n")
    expect(header).toMatch(/GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/)
  })

  test("contents:write is scoped to the tag job; the tag job follows a guarded publish", async () => {
    const yml = await readWorkflow()
    expect(yml).toMatch(/^permissions:\n {2}contents: read/m)
    expect(yml.match(/^\s*contents: write$/gm)).toHaveLength(1)
    const tagJobAt = yml.indexOf("tag-and-release:")
    expect(tagJobAt).toBeGreaterThan(-1)
    const writeAt = yml.search(/^\s*contents: write$/m)
    expect(writeAt).toBeGreaterThan(tagJobAt)
    expect(yml.slice(tagJobAt)).toMatch(/needs:\s*\[?publish\]?/)
    expect(yml.slice(tagJobAt)).toMatch(/inputs\.dry_run == false/)
  })
})
