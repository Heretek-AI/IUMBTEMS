// Seat sandbox on the real host for issue #183 (beside scoping.test.ts):
// a cached-web research seat gets a network failure through curl
// (--unshare-net), a programmer seat shell cannot write outside its worktree,
// seat shells never leak server passwords or the scraper token, and without
// bwrap factory seats are refused while user agents keep the text policy.
// Real in-process OpenCode v2 host via @heretek-ai/es-testkit (scripted fake LLM).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os, { tmpdir } from "node:os"
import path from "node:path"
import { bwrapAvailable } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

describe("seat sandbox on the real host (#183)", () => {
  let h: Harness
  let state: string
  let isolatedHome: string
  let savedHome: string | undefined
  const origHomedir = os.homedir

  beforeAll(async () => {
    // Isolate the home the seat sandbox overlays onto tmpfs (/tmp): bwrap
    // --tmp-overlay on a btrfs home (e.g. /home) fails with "userxattr:
    // Invalid argument", while tmpfs succeeds — the same reason
    // sandbox.test.ts uses a home under /tmp. Bun's os.homedir() ignores a
    // $HOME change, so patch it (restored afterwards); the plugin resolves
    // the sandbox home through the same module instance.
    savedHome = process.env.HOME
    isolatedHome = await mkdtemp(path.join(tmpdir(), "es-sandbox-home-"))
    process.env.HOME = isolatedHome
    ;(os as unknown as { homedir: () => string }).homedir = () => isolatedHome
    state = await mkdtemp(path.join(tmpdir(), "es-sandbox-seats-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# sandbox seats\n" },
    })
  }, 120_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
    await rm(isolatedHome, { recursive: true, force: true })
    ;(os as unknown as { homedir: () => string }).homedir = origHomedir
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  })

  test.skipIf(!bwrapAvailable())(
    "a cached-web research seat gets a network failure through curl (--unshare-net)",
    async () => {
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response("OUTSIDE-REACHED"),
      })
      try {
        // The curl runs inside the seat sandbox: the host loopback is outside
        // its network namespace, so even --max-time curl cannot reach it.
        const offline = await h.run(
          `net ${call("shell", { command: `curl -sS --max-time 5 http://127.0.0.1:${server.port}/; echo CURL_EXIT:$?` })}`,
          { agent: "es-research-alpha" },
        )
        expect(offline.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:completed"])
        expect(offline.tools[0]?.text).not.toContain("OUTSIDE-REACHED")
        expect(offline.tools[0]?.text).toMatch(/CURL_EXIT:[1-9]/)
        // Control: the same curl outside the sandbox reaches the server, so
        // the failure is the sandbox, not the server.
        const online = await h.run(
          `net ${call("shell", { command: `curl -sS --max-time 5 http://127.0.0.1:${server.port}/; echo CURL_EXIT:$?` })}`,
          { agent: "build" },
        )
        expect(online.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:completed"])
        expect(online.tools[0]?.text).toContain("OUTSIDE-REACHED")
        expect(online.tools[0]?.text).toContain("CURL_EXIT:0")
      } finally {
        server.stop(true)
      }
    },
    60_000,
  )

  test.skipIf(!bwrapAvailable())(
    "a programmer seat shell cannot write outside its worktree",
    async () => {
      // No phase is building, so the programmer has no writable directory:
      // the whole project is outside its worktree and the sandbox holds it
      // read-only. The trailing echo proves the shell itself ran.
      const { tools } = await h.run(
        `write ${call("shell", { command: "echo PWNED > PROBE-OUTSIDE-183.md; echo MARKER" })}`,
        { agent: "es-programmer" },
      )
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:completed"])
      expect(tools[0]?.text).toContain("MARKER")
      expect(await Bun.file(path.join(h.directory, "PROBE-OUTSIDE-183.md")).exists()).toBe(false)
    },
    60_000,
  )

  test("seat shells never leak the server password or the scraper token", async () => {
    // End to end: both secrets sit in the host's own environment, and even a
    // seat's sandboxed shell must not see either (hook strips passwords,
    // bwrap unsets every SECRET_ENV entry).
    const savedPassword = process.env.OPENCODE_SERVER_PASSWORD
    const savedToken = process.env.ES_SCRAPER_SWARM_TOKEN
    process.env.OPENCODE_SERVER_PASSWORD = "probe-server-secret"
    process.env.ES_SCRAPER_SWARM_TOKEN = "probe-scraper-secret"
    try {
      for (const variable of ["OPENCODE_SERVER_PASSWORD", "ES_SCRAPER_SWARM_TOKEN"]) {
        const { tools } = await h.run(`leak ${call("shell", { command: `echo val=$${variable}` })}`, {
          agent: "es-programmer",
        })
        if (!bwrapAvailable()) {
          // Without the sandbox a seat shell never runs at all: still no leak.
          expect([variable, ...tools.map((tool) => `${tool.name}:${tool.status}`)]).toEqual([variable, "shell:error"])
          expect(tools[0]?.text).toContain("bubblewrap")
          expect(tools[0]?.text).not.toContain("probe-server-secret")
          expect(tools[0]?.text).not.toContain("probe-scraper-secret")
          continue
        }
        expect([variable, ...tools.map((tool) => `${tool.name}:${tool.status}`)]).toEqual([variable, "shell:completed"])
        expect(tools[0]?.text).toContain("val=")
        expect(tools[0]?.text).not.toContain("probe-server-secret")
        expect(tools[0]?.text).not.toContain("probe-scraper-secret")
      }
    } finally {
      if (savedPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = savedPassword
      if (savedToken === undefined) delete process.env.ES_SCRAPER_SWARM_TOKEN
      else process.env.ES_SCRAPER_SWARM_TOKEN = savedToken
    }
  }, 60_000)

  test("without bwrap factory seats are refused a shell; user agents keep the text policy", async () => {
    if (!bwrapAvailable()) {
      const seat = await h.run(`x ${call("shell", { command: "echo hi" })}`, { agent: "es-qa-functional" })
      expect(seat.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:error"])
      expect(seat.tools[0]?.text).toMatch(/bubblewrap/i)
      // The user's own agent still runs, but mutating control files is denied.
      const denied = await h.run(`x ${call("shell", { command: "echo x > .factory/gates.json" })}`, {
        agent: "build",
      })
      expect(denied.tools[0]?.status).toBe("error")
      const read = await h.run(`x ${call("shell", { command: "cat README.md" })}`, { agent: "build" })
      expect(read.tools[0]?.status).toBe("completed")
      return
    }
    // With bwrap the seat shell runs sandboxed, while the user's text policy
    // still denies the same mutating command (defence in depth).
    const seat = await h.run(`x ${call("shell", { command: "echo hi" })}`, { agent: "es-qa-functional" })
    expect(seat.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:completed"])
    const denied = await h.run(`x ${call("shell", { command: "echo x > .factory/gates.json" })}`, {
      agent: "build",
    })
    expect(denied.tools[0]?.status).toBe("error")
  }, 60_000)
})
