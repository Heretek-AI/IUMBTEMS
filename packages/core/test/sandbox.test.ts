// The 1.1.1 OS sandbox, against the real bwrap (skipped where it cannot run).
// Each case is an attack the 1.1.0 audit ran through a text-matched policy:
// forging control files, reading the signing key and the OpenCode server
// password, using push credentials, reaching the network from a cached-web
// seat, and escaping the programmer's worktree.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { bwrapAvailable } from "../src/index.ts"
import { type SandboxKind, sandboxArgv } from "../src/trust/sandbox.ts"

let base: string
let home: string
let root: string
let worktree: string
let state: string

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "es-sandbox-"))
  home = path.join(base, "home")
  root = path.join(base, "proj")
  state = path.join(home, ".local/state/epistemic-swarm")
  worktree = path.join(root, ".factory/worktrees/phase-01")
  const files: Record<string, string> = {
    [path.join(state, "key")]: "SECRET-SIGNING-KEY\n",
    [path.join(home, ".config/opencode/service.json")]: '{"password":"SERVER-PASSWORD"}\n',
    [path.join(home, ".ssh/id_ed25519")]: "SSH-PRIVATE-KEY\n",
    [path.join(home, ".git-credentials")]: "https://user:TOKEN@github.com\n",
    [path.join(root, ".factory/gates.json")]: '{"commands":[]}\n',
    [path.join(root, ".factory/research/sources/index.json")]: "{}\n",
    [path.join(root, "src/a.ts")]: "export const a = 1\n",
    [path.join(worktree, "src/a.ts")]: "export const a = 1\n",
    [path.join(worktree, ".git")]: "gitdir: ../../../.git/worktrees/phase-01\n",
  }
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }
  spawnSync("git", ["init", "-q"], { cwd: root })
})
afterAll(() => rm(base, { recursive: true, force: true }))

const sh = (kind: SandboxKind, command: string, extra: { cwd?: string; offline?: boolean; overlay?: boolean } = {}) => {
  const cwd = extra.cwd ?? (kind === "programmer" ? worktree : root)
  const argv = sandboxArgv(
    {
      kind,
      root,
      cwd,
      stateDir: state,
      home,
      offline: extra.offline,
      writable: kind === "programmer" ? worktree : undefined,
    },
    ["sh", "-c", command],
    ...(extra.overlay === false ? [{ exists: existsSync, overlay: false, uid: process.getuid?.() }] : []),
  )
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", timeout: 20_000 })
  return { code: result.status, out: `${result.stdout}${result.stderr}` }
}
/** Async variant, for commands that talk to a server in this process (spawnSync would block it). */
const shAsync = async (kind: SandboxKind, command: string, offline: boolean) => {
  const argv = sandboxArgv({ kind, root, cwd: root, stateDir: state, home, offline }, ["sh", "-c", command])
  const child = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 20_000)
  const out = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`
  await child.exited
  clearTimeout(timer)
  return out
}
const text = (file: string) => readFile(file, "utf8").catch(() => undefined)

describe.skipIf(!bwrapAvailable())("the agent sandbox (real bwrap)", () => {
  test("user: the project stays writable; .factory/ is read-only; secrets are masked; credentials stay", async () => {
    expect(sh("user", "echo 'export const b = 2' > src/b.ts").code).toBe(0)
    expect(await text(path.join(root, "src/b.ts"))).toContain("b = 2")
    // The audit's forgeries: redirection, interpreters, find -fprintf, sort -o, cd.
    for (const forge of [
      "echo forged > .factory/gates.json",
      `env python3 -c 'open(".factory/research/sources/x.md","w").write("forged")'`,
      "find . -maxdepth 0 -fprintf .factory/research/sources/y.md forged",
      "sort -o .factory/gates.json src/a.ts",
      "cd .fac''tory && echo forged > research/sources/z.md",
    ])
      expect([forge, sh("user", forge).code === 0]).toEqual([forge, false])
    expect(await text(path.join(root, ".factory/gates.json"))).toBe('{"commands":[]}\n')
    expect(await text(path.join(root, ".factory/research/sources/x.md"))).toBeUndefined()
    expect(sh("user", `cat ${state}/key ${state}/k*`).out).not.toContain("SECRET-SIGNING-KEY")
    expect(sh("user", `cat ${home}/.config/opencode/service.json`).out).not.toContain("SERVER-PASSWORD")
    expect(sh("user", `cat ${home}/.ssh/id_ed25519`).out).toContain("SSH-PRIVATE-KEY")
  })

  test("seat: git and host config are read-only; push credentials are masked", async () => {
    expect(sh("seat", "git config core.hooksPath /tmp/hooks").code).not.toBe(0)
    expect(await text(path.join(root, ".git/config"))).not.toContain("hooksPath")
    expect(sh("seat", `cat ${home}/.ssh/id_ed25519 ${home}/.git-credentials`).out).not.toMatch(/SSH-PRIVATE-KEY|TOKEN/)
    expect(sh("seat", "echo x > notes.md").code).toBe(0)
  })

  test("programmer: only its worktree is writable; it cannot climb out to .factory or retarget .git", async () => {
    expect(sh("programmer", "echo 'export const c = 3' > src/c.ts").code).toBe(0)
    expect(await text(path.join(worktree, "src/c.ts"))).toContain("c = 3")
    expect(sh("programmer", "cd ../../.. && echo forged > .factory/gates.json").code).not.toBe(0)
    expect(sh("programmer", "cd ../../.. && echo forged > src/escape.ts; true").code).toBe(0)
    expect(await text(path.join(root, "src/escape.ts"))).toBeUndefined()
    expect(sh("programmer", "echo gitdir: /tmp/evil > .git").code).not.toBe(0)
    expect(sh("programmer", `cat ${state}/key`).out).not.toContain("SECRET-SIGNING-KEY")
  })

  test("without overlay support (bwrap 0.9, as on Ubuntu 24.04) the same boundaries hold", async () => {
    const old = { overlay: false }
    expect(sh("programmer", "echo 'export const d = 4' > src/d.ts", old).code).toBe(0)
    expect(await text(path.join(worktree, "src/d.ts"))).toContain("d = 4")
    expect(sh("programmer", "cd ../../.. && echo forged > .factory/gates.json", old).code).not.toBe(0)
    expect(sh("programmer", "cd ../../.. && echo forged > src/escape2.ts", old).code).not.toBe(0)
    expect(sh("readonly", "echo forged > src/a.ts", old).code).not.toBe(0)
    expect(await text(path.join(root, "src/a.ts"))).toBe("export const a = 1\n")
    expect(sh("readonly", `cat ${state}/key`, old).out).not.toContain("SECRET-SIGNING-KEY")
  })

  test("readonly + offline: nothing persists and the network is unreachable", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("REACHED") })
    try {
      sh("readonly", "echo forged > src/a.ts; true")
      expect(await text(path.join(root, "src/a.ts"))).toBe("export const a = 1\n")
      const probe = `python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${server.port}/').read())"`
      expect(await shAsync("readonly", probe, true)).not.toContain("REACHED")
      expect(await shAsync("readonly", probe, false)).toContain("REACHED")
    } finally {
      server.stop(true)
    }
  })
})

describe("sandboxArgv", () => {
  const probe = { exists: () => true, overlay: false, uid: 1000 }
  const argv = (kind: SandboxKind, offline = false) =>
    sandboxArgv({ kind, root: "/p", cwd: "/p", stateDir: "/h/.local/state/es", home: "/h", offline }, ["true"], probe)

  test("every kind masks the state dir and the server password; only non-user kinds mask credentials", () => {
    for (const kind of ["user", "seat", "programmer", "readonly", "gate"] as const) {
      const args = argv(kind)
      expect([kind, args.join(" ")]).toEqual([kind, expect.stringContaining("--tmpfs /h/.local/state/es")])
      expect(args.join(" ")).toContain("--ro-bind /dev/null /h/.config/opencode/service.json")
      expect(args.join(" ")).toContain("--unsetenv OPENCODE_SERVER_PASSWORD")
      // Provider and gateway API keys never reach a seat shell (#106, #107).
      for (const secret of ["BRAVE_API_KEY", "FIRECRAWL_API_KEY", "ES_SCRAPER_SWARM_TOKEN"])
        expect([kind, secret, args.join(" ")]).toEqual([kind, secret, expect.stringContaining(`--unsetenv ${secret}`)])
      expect([kind, args.includes("SSH_AUTH_SOCK")]).toEqual([kind, kind !== "user"])
    }
  })

  test("offline seats lose the network; the user's agent keeps background processes", () => {
    expect(argv("readonly", true)).toContain("--unshare-net")
    expect(argv("readonly")).not.toContain("--unshare-net")
    expect(argv("user")).not.toContain("--die-with-parent")
    expect(argv("seat")).toContain("--die-with-parent")
  })
})
