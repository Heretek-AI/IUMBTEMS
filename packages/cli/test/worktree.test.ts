// Agent-safe leased worktree CLI pair (#340): `es worktree create` takes a
// heartbeat lease around a `.worktrees/<slug>` checkout and
// `es worktree release` drops it. Release never removes another holder's live
// checkout and never deletes branches.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { evaluateShell, exists, invokesHumanOnly, WorktreeLeaseManager } from "@heretek-ai/es-core"
import { main } from "../src/main.ts"
import type { ConfirmIO } from "../src/tty.ts"

let root: string
let state: string
const realXdgConfig = process.env.XDG_CONFIG_HOME

const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
  return proc
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-worktree-cli-"))
  state = await mkdtemp(path.join(tmpdir(), "es-worktree-cli-state-"))
  process.env.XDG_CONFIG_HOME = path.join(state, "xdg-config")
  await git("init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# x\n")
  await git("add", "-A")
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
})
afterEach(async () => {
  if (realXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = realXdgConfig
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" }

async function run(argv: string[]) {
  const printed: string[] = []
  const code = await main(argv, { print: (text) => printed.push(text), confirm: pipe, cwd: root, stateDir: state })
  return { code, out: printed.join("\n") }
}

const branchExists = async (branch: string) => {
  const proc = Bun.spawn(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.exited
  return proc.exitCode === 0
}

const leaseFile = (slug: string) => path.join(root, ".worktrees", ".leases", `${slug}.json`)

describe("es worktree create/release (#340)", () => {
  test("create takes a live lease; release drops it and removes the checkout", async () => {
    const created = await run(["worktree", "create", "demo", "--branch", "demo-branch"])
    expect(created.code).toBe(0)
    expect(await exists(path.join(root, ".worktrees", "demo"))).toBe(true)
    const manager = new WorktreeLeaseManager(root)
    const record = (await manager.list()).find((lease) => lease.slug === "demo")
    expect(record && manager.isLive(record)).toBe(true)

    const released = await run(["worktree", "release", "demo"])
    expect(released.code).toBe(0)
    expect(await exists(path.join(root, ".worktrees", "demo"))).toBe(false)
    expect(await Bun.file(leaseFile("demo")).exists()).toBe(false)
    // Prune invariant: checkouts go, branches stay.
    expect(await branchExists("demo-branch")).toBe(true)
  })

  test("creating twice refuses the second holder", async () => {
    expect((await run(["worktree", "create", "demo", "--branch", "demo-branch"])).code).toBe(0)
    const second = await run(["worktree", "create", "demo", "--branch", "demo-branch"])
    expect(second.code).toBe(1)
    expect(second.out).toMatch(/leas|held/i)
  })

  test("release refuses another holder's live checkout and leaves it alone", async () => {
    const dir = path.join(root, ".worktrees", "demo")
    const add = Bun.spawn(["git", "worktree", "add", "-B", "demo-branch", dir, "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    await add.exited
    expect(add.exitCode).toBe(0)
    // Another holder object (no shared token): the lease is live, pid alive.
    const holder = new WorktreeLeaseManager(root)
    await holder.acquire("demo", { branch: "demo-branch", dir })
    const refused = await run(["worktree", "release", "demo"])
    expect(refused.code).toBe(1)
    expect(refused.out).toMatch(/held|live/i)
    expect(await exists(dir)).toBe(true)
    expect(await Bun.file(leaseFile("demo")).exists()).toBe(true)
    await holder.release("demo")
    const released = await run(["worktree", "release", "demo"])
    expect(released.code).toBe(0)
    expect(await exists(dir)).toBe(false)
    expect(await branchExists("demo-branch")).toBe(true)
  })

  test("release reclaims a crashed holder and keeps the branch", async () => {
    const dir = path.join(root, ".worktrees", "doomed")
    const add = Bun.spawn(["git", "worktree", "add", "-B", "doomed-branch", dir, "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    await add.exited
    expect(add.exitCode).toBe(0)
    const holder = new WorktreeLeaseManager(root)
    await holder.acquire("doomed", { branch: "doomed-branch", dir })
    // Simulate SIGKILL: the lease file keeps a fresh heartbeat but a dead pid.
    const raw = JSON.parse(await readFile(leaseFile("doomed"), "utf8")) as Record<string, unknown>
    await writeFile(leaseFile("doomed"), `${JSON.stringify({ ...raw, pid: 2 ** 30 })}\n`)
    const released = await run(["worktree", "release", "doomed"])
    expect(released.code).toBe(0)
    expect(await exists(dir)).toBe(false)
    expect(await branchExists("doomed-branch")).toBe(true)
    await holder.release("doomed").catch(() => undefined)
  })

  test("release of an orphaned checkout (no lease) removes it and keeps the branch", async () => {
    const add = Bun.spawn(
      ["git", "worktree", "add", "-B", "orphan-branch", path.join(root, ".worktrees", "orphan"), "HEAD"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    await add.exited
    expect(add.exitCode).toBe(0)
    const released = await run(["worktree", "release", "orphan"])
    expect(released.code).toBe(0)
    expect(await exists(path.join(root, ".worktrees", "orphan"))).toBe(false)
    expect(await branchExists("orphan-branch")).toBe(true)
  })

  test("missing slug is usage, not an error", async () => {
    expect((await run(["worktree", "create"])).code).toBe(2)
    expect((await run(["worktree", "release"])).code).toBe(2)
  })
})

describe("worktree CLI pair policy (#340)", () => {
  const ctx = () => ({ root, stateDir: state })
  const shell = (agent: string | undefined, command: string) =>
    evaluateShell(ctx(), agent, command, { sandboxAvailable: true })

  test("the pair is agent-safe (not human-only)", () => {
    expect(invokesHumanOnly("es worktree create demo --branch demo-branch")).toBe(false)
    expect(invokesHumanOnly("es worktree release demo")).toBe(false)
    expect(invokesHumanOnly("es worktree prune")).toBe(false)
  })

  test("seats may not manage worktrees from the shell; user agents may", () => {
    expect(shell("es-programmer", "es worktree create demo --branch b").effect).toBe("deny")
    expect(shell("es-programmer", "es worktree release demo").effect).toBe("deny")
    expect(shell("factory", "es worktree release demo").effect).toBe("deny")
    expect(shell(undefined, "es worktree create demo --branch b").effect).toBe("allow")
    expect(shell(undefined, "es worktree release demo").effect).toBe("allow")
  })

  test("seats keep the agent-safe prune and plain --help", () => {
    expect(shell("es-programmer", "es worktree prune").effect).toBe("allow")
    expect(shell("es-programmer", "es worktree create demo --help").effect).toBe("allow")
  })
})
