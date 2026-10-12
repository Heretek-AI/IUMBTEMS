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
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

// Publish tag guard (#328): the `publish.yml` publish guard refuses a
// non-dry-run publish when the release tag already exists, before `npm
// publish` runs. Fake-binary style: the extracted workflow step runs against
// fake `bun`/`git` binaries over a fixture with agreeing manifests.
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

/** A fixture repo root with agreeing manifests, a CHANGELOG and fake `bun`/`git`. */
const tagFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-publish-tag-"))
  const bin = await mkdtemp(path.join(tmpdir(), "es-publish-tag-bin-"))
  for (const dir of ["core", "cli", "opencode"]) {
    await mkdir(path.join(root, "packages", dir), { recursive: true })
    await writeFile(
      path.join(root, "packages", dir, "package.json"),
      `${JSON.stringify({ name: `@scope/${dir}`, version: "2.3.0" }, null, 2)}\n`,
    )
  }
  await writeFile(
    path.join(root, "CHANGELOG.md"),
    "# Changelog\n\n## 2.3.0 — 2026-10-11\n\nThe headline feature ships.\n",
  )
  await writeFile(
    path.join(bin, "bun"),
    "#!/bin/sh\nprintf 'core heretek-ai-es-core\\ncli heretek-ai-es-cli\\nopencode heretek-ai-epistemic-swarm\\n'\nexit 0\n",
  )
  await writeFile(
    path.join(bin, "git"),
    '#!/bin/sh\nif [ "$1" = "ls-remote" ]; then\nif [ "${FAKE_GIT_TAG_EXISTS:-0}" = "1" ]; then exit 0; else exit 1; fi\nfi\nexit 0\n',
  )
  for (const tool of ["bun", "git"]) await chmod(path.join(bin, tool), 0o755)
  return { root, bin }
}

/** Run the extracted guard step with the fixture on PATH. */
const runGuard = (script: string, fx: { root: string; bin: string }, env: Record<string, string>) => {
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

describe("publish tag guard (#328)", () => {
  test("an existing tag refuses the publish before npm publish runs", async () => {
    const fx = await tagFixture()
    try {
      const script = extractStep(await readWorkflow(), "Publish guard: version parity and free tag")
      const run = runGuard(script, fx, { DRY_RUN: "false", FAKE_GIT_TAG_EXISTS: "1" })
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toMatch(/tag v2\.3\.0 already exists/)
    } finally {
      await rm(fx.root, { recursive: true, force: true })
      await rm(fx.bin, { recursive: true, force: true })
    }
  })

  test("a free tag lets the guarded publish proceed", async () => {
    const fx = await tagFixture()
    try {
      const script = extractStep(await readWorkflow(), "Publish guard: version parity and free tag")
      const run = runGuard(script, fx, { DRY_RUN: "false", FAKE_GIT_TAG_EXISTS: "0" })
      expect(run.exitCode).toBe(0)
      expect(run.stdout).toMatch(/tag v2\.3\.0 free/)
    } finally {
      await rm(fx.root, { recursive: true, force: true })
      await rm(fx.bin, { recursive: true, force: true })
    }
  })
})
