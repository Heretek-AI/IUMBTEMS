import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exists, Factory, factoryLayout, gateRunner, readApproval } from "@heretek-ai/es-core"
import { parseArgs, parseExpiry } from "../src/args.ts"
import { type HarnessDriver, runHeadless } from "../src/headless.ts"
import { main } from "../src/main.ts"
import { createMcpServer } from "../src/mcp.ts"
import { type ConfirmIO, confirmWithCode, NotInteractive } from "../src/tty.ts"

let root: string
let state: string
// The global config layer lives under XDG_CONFIG_HOME: point it into the
// test's state dir so `--global` never touches the real ~/.config.
const realXdgConfig = process.env.XDG_CONFIG_HOME
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-cli-"))
  state = await mkdtemp(path.join(tmpdir(), "es-cli-state-"))
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

/** A human at a terminal who types back whatever code is shown (or `answer`). */
const human = (answer?: string): ConfirmIO & { output: string[] } => {
  const output: string[] = []
  return {
    interactive: true,
    output,
    write: (text) => output.push(text),
    readLine: async () => answer ?? /Type (\S+) to confirm/.exec(output.join(""))?.[1] ?? "",
  }
}
const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y" }

async function run(argv: string[], confirm: ConfirmIO = pipe) {
  const printed: string[] = []
  const code = await main(argv, { print: (text) => printed.push(text), confirm, cwd: root, stateDir: state })
  return { code, out: printed.join("\n") }
}

async function grilledFrontier() {
  const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
  await factory.writeFrontier("grill", {
    version: "1.1",
    idea: "cli test",
    spendCeiling: { currency: "USD", maxAmount: 3 },
    settled: true,
    nodes: [{ id: "a", question: "q?", answer: "yes", status: "settled" }],
  })
  return factory
}

describe("args", () => {
  test("flags, booleans and expiry", () => {
    expect(parseArgs(["gates", "run", "--full", "a.ts", "--base", "main"], ["full"])).toEqual({
      positionals: ["gates", "run", "a.ts"],
      flags: { full: true, base: "main" },
    })
    const now = new Date("2026-10-06T00:00:00Z")
    expect(parseExpiry("7d", now).toISOString()).toBe("2026-10-13T00:00:00.000Z")
    expect(() => parseExpiry("soon")).toThrow()
  })
})

describe("human-only confirmation", () => {
  test("needs a TTY and the exact typed code", async () => {
    await expect(confirmWithCode(pipe, "x", [])).rejects.toBeInstanceOf(NotInteractive)
    expect(await confirmWithCode(human("y"), "x", [])).toBe(false)
    expect(await confirmWithCode(human(), "x", [])).toBe(true)
  })

  test("es approve refuses without a terminal and records nothing", async () => {
    await grilledFrontier()
    const result = await run(["approve", "frontier"])
    expect(result.code).toBe(3)
    expect(await readApproval(root, "frontier")).toBeUndefined()
  })

  test("es approve frontier at a terminal signs it and starts research", async () => {
    const factory = await grilledFrontier()
    const io = human()
    const result = await run(["approve", "frontier"], io)
    expect(result.code).toBe(0)
    expect(io.output.join("")).toContain("Spend ceiling: $3 USD")
    expect((await readApproval(root, "frontier"))?.channel).toBe("cli")
    expect((await factory.read())?.stage).toBe("RESEARCH")
  })

  test("a wrong code cancels the waiver", async () => {
    const result = await run(["waive", "lint/*", "--reason", "legacy code under migration"], human("nope"))
    expect(result.code).toBe(1)
    const granted = await run(
      ["waive", "lint/*", "--reason", "legacy code under migration", "--expires", "2d"],
      human(),
    )
    expect(granted.code).toBe(0)
    expect(granted.out).toContain("granted")
  })
})

describe("research brief and retractions", () => {
  async function researched() {
    const { buildDossier, normalizeClaim, researchSourcesDir, SourceCache, writeDossier } = await import(
      "@heretek-ai/es-core"
    )
    const cache = new SourceCache(researchSourcesDir(root))
    const source = await cache.put({
      url: "https://x.test/cli",
      text: "The CLI exports a signed brief that anyone holding the key can verify.",
      provider: "fetch",
    })
    const claim = normalizeClaim({
      tag: "VERIFIED",
      statement: "Briefs are signed.",
      source: { sha256: source.meta.sha256, quote: "exports a signed brief" },
    })
    await writeFile(path.join(root, ".factory/research/REPORT.md"), "# R\n")
    await writeDossier(
      factoryLayout(root).researchDossier,
      buildDossier({ mode: "research", subject: "cli", claims: [claim] }),
      { cache },
    )
    return source.meta.sha256
  }

  test("export writes a signed brief that verify-brief accepts, and a tampered one fails", async () => {
    await researched()
    expect((await run(["research", "export", "--help"])).code).toBe(0)
    expect(await exists(factoryLayout(root).researchBrief)).toBe(false)
    const exported = await run(["research", "export"])
    expect(exported.code).toBe(0)
    expect(exported.out).toContain("Exported .factory/research/brief.pcrb.json")
    const verified = await run(["research", "verify-brief", ".factory/research/brief.pcrb.json"])
    expect([verified.code, verified.out.split("\n")[0]]).toEqual([
      0,
      "Brief OK: source identity pass, manifest pass, signature valid, quotes pass",
    ])
    const file = factoryLayout(root).researchBrief
    const brief = JSON.parse(await Bun.file(file).text())
    brief.claims[0].statement = "Briefs are unsigned."
    await writeFile(path.join(root, "tampered.json"), JSON.stringify(brief))
    const tampered = await run(["research", "verify-brief", "tampered.json"])
    expect(tampered.code).toBe(1)
    expect(tampered.out).toContain("Brief FAILED")
    expect((await run(["research", "verify-brief"])).code).toBe(2)
  })

  test("retract is human-only and degrades the claims that cite the source", async () => {
    const { ClaimStore } = await import("@heretek-ai/es-core")
    const source = await researched()
    expect((await run(["research", "retract", source, "--event", "retracted"])).code).toBe(3)
    expect(await exists(factoryLayout(root).retractions)).toBe(false)
    expect((await run(["research", "retract", "abc", "--event", "retracted"], human())).code).toBe(2)
    expect((await run(["research", "retract", source, "--event", "maybe"], human())).code).toBe(2)
    const recorded = await run(["research", "retract", source, "--event", "retracted", "--note", "withdrawn"], human())
    expect(recorded.code).toBe(0)
    expect(recorded.out).toContain("1 claim(s) citing")
    expect((await ClaimStore.load(root)).citing(source).map((claim) => claim.status)).toEqual(["STALE"])
  })
})

describe("es config set", () => {
  const projectConfig = () => Bun.file(factoryLayout(root).config).json()

  test("is human-only, schema-validated, previewed, and re-pins the project config", async () => {
    const { verifyAuditChain, verifyControl, rebaseline } = await import("@heretek-ai/es-core")
    await rebaseline(root, "test")
    expect((await run(["config", "set", "research.depth", "3", "--help"])).code).toBe(0)
    expect((await run(["config", "set", "research.depth", "3"])).code).toBe(3)
    expect(await exists(factoryLayout(root).config)).toBe(false)
    const io = human()
    const set = await run(["config", "set", "research.depth", "3"], io)
    expect(set.code).toBe(0)
    expect(io.output.join("")).toContain("research.depth: (unset) → 3")
    expect(await projectConfig()).toEqual({ research: { depth: 3 } })
    expect((await verifyControl(root)).clean).toBe(true)
    const audit = await verifyAuditChain(root)
    expect(audit.entries.map((entry) => entry.action)).toContain("config.set")
    expect((await run(["config", "set", "research.depth", "3"], human())).out).toContain("already 3")
    expect((await run(["config", "show"])).out).toContain('"depth": 3')
  })

  test("rejects unknown keys, invalid values and project-forbidden keys (those go --global)", async () => {
    const typo = await run(["config", "set", "reserch.depth", "3"], human())
    expect([typo.code, typo.out]).toEqual([1, expect.stringContaining("Refused")])
    expect((await run(["config", "set", "research.depth", "9"], human())).code).toBe(1)
    expect((await run(["config", "set", "afterEdit", "sometimes"], human())).code).toBe(1)
    const forbidden = await run(["config", "set", "research.searxngUrl", "https://search.test"], human())
    expect([forbidden.code, forbidden.out]).toEqual([1, expect.stringContaining("--global")])
    expect(await exists(factoryLayout(root).config)).toBe(false)
    const global = await run(["config", "set", "research.searxngUrl", "https://search.test", "--global"], human())
    expect(global.code).toBe(0)
    const file = path.join(state, "xdg-config", "epistemic-swarm", "config.json")
    expect(await Bun.file(file).json()).toEqual({ research: { searxngUrl: "https://search.test" } })
    expect((await run(["config", "set", "research.searxngUrl", "null", "--global"], human())).code).toBe(0)
    expect(await Bun.file(file).json()).toEqual({ research: {} })
    expect((await run(["config", "set", "research.depth"], human())).code).toBe(2)
  })

  test("never launders drift in other control files; accepts a pending hand edit to config.json only openly", async () => {
    const { rebaseline, verifyControl } = await import("@heretek-ai/es-core")
    await mkdir(factoryLayout(root).dir, { recursive: true })
    await writeFile(factoryLayout(root).config, '{"pr":"off"}\n')
    await rebaseline(root, "test")
    await writeFile(factoryLayout(root).gates, '{"version":1}\n')
    const refused = await run(["config", "set", "research.depth", "4"], human())
    expect([refused.code, refused.out]).toEqual([1, expect.stringContaining("es rebaseline")])
    expect(await projectConfig()).toEqual({ pr: "off" })
    await rebaseline(root, "test")
    await writeFile(factoryLayout(root).config, '{"pr":"gh"}\n')
    const io = human()
    expect((await run(["config", "set", "research.depth", "4"], io)).code).toBe(0)
    expect(io.output.join("")).toContain("accepted along with it")
    expect(await projectConfig()).toEqual({ pr: "gh", research: { depth: 4 } })
    expect((await verifyControl(root)).clean).toBe(true)
  })
})

describe("rebaseline", () => {
  test("es rebaseline needs a terminal and accepts hand edits to pinned control files", async () => {
    const { rebaseline, verifyControl } = await import("@heretek-ai/es-core")
    await rebaseline(root, "test")
    await mkdir(path.join(root, ".factory"), { recursive: true })
    await writeFile(path.join(root, ".factory/config.json"), '{"pr":"off"}')
    expect((await verifyControl(root)).clean).toBe(false)
    expect((await run(["rebaseline"])).code).not.toBe(0)
    expect((await verifyControl(root)).clean).toBe(false)
    const accepted = await run(["rebaseline"], human())
    expect(accepted.code).toBe(0)
    expect(accepted.out).toContain("Re-baselined 1")
    expect((await verifyControl(root)).clean).toBe(true)
  })
})

describe("gates and audit", () => {
  test("--help prints usage without minting a run", async () => {
    const helped = await run(["factory", "begin", "--help"])
    expect(helped.code).toBe(0)
    expect(helped.out).toContain("Usage: es")
    expect(await exists(factoryLayout(root).state)).toBe(false)
    expect(await exists(factoryLayout(root).dir)).toBe(false)
  })
  test("gates run exits non-zero on findings; audit verify reports the chain", async () => {
    await writeFile(path.join(root, "leak.ts"), `export const t = "ghp_${"Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"}"\n`)
    const gates = await run(["gates", "run", "leak.ts"])
    expect(gates.code).toBe(1)
    expect(gates.out).toContain("security/secret-github-token")
    await grilledFrontier()
    expect((await run(["audit", "verify"])).out).toContain("Audit log OK")
  })

  test("factory stop writes the kill switch", async () => {
    await run(["factory", "stop", "lunch"])
    expect(await Bun.file(factoryLayout(root).stop).text()).toContain("lunch")
  })
})

describe("mcp", () => {
  test("lists coarse tools without any human-only tool and calls them with an advisory agent", async () => {
    const server = createMcpServer({ root, stateDir: state })
    const init = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    })
    expect(init?.result.protocolVersion).toBe("2025-03-26")
    const list = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const names = list?.result.tools.map((tool: any) => tool.name)
    expect(names).toContain("complete")
    expect(names.some((name: string) => /approve|trust|waive|resume/.test(name) && name !== "request_approval")).toBe(
      false,
    )
    const status = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    })
    expect(status?.result.content[0].text).toContain("factory-state")
    const refused = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "complete", arguments: { agent: "es-qa-functional" } },
    })
    expect(refused?.result.isError).toBe(true)
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined()
  })

  test("serves newline-delimited JSON-RPC over stdio", async () => {
    const proc = Bun.spawn(["bun", path.join(import.meta.dir, "../src/main.ts"), "mcp", "--cwd", root], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ES_STATE_DIR: state },
    })
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`)
    proc.stdin.end()
    const lines = (await new Response(proc.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.map((line) => line.id)).toEqual([1, 2])
    expect(lines[0].result.serverInfo.name).toBe("epistemic-swarm")
  })
})

describe("opencode driver", () => {
  test("runs opencode in the project: PWD is the project root, not the caller's directory", async () => {
    const { chmod, mkdtemp: mk } = await import("node:fs/promises")
    const { opencodeDriver } = await import("../src/headless.ts")
    const bin = await mk(path.join(tmpdir(), "es-fake-opencode-"))
    // A Bun stub reports the PWD it inherited verbatim (sh would recompute it).
    await writeFile(
      path.join(bin, "opencode"),
      `#!/usr/bin/env bun\nconsole.log(JSON.stringify({ type: "text", sessionID: "ses_fake1", part: { text: process.env.PWD } }))\n`,
    )
    await chmod(path.join(bin, "opencode"), 0o755)
    const previous = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previous}`
    try {
      const events: any[] = []
      const turn = opencodeDriver.turn({ root, agent: "factory", prompt: "go" })
      let step = await turn.next()
      while (!step.done) {
        events.push(step.value)
        step = await turn.next()
      }
      expect(events[0]?.part?.text).toBe(root)
      expect(step.value).toBe("ses_fake1")
    } finally {
      process.env.PATH = previous
      await rm(bin, { recursive: true, force: true })
    }
  })
})

describe("headless", () => {
  const collect = async (driver: HarnessDriver, maxTurns = 10) => {
    const events: any[] = []
    for await (const event of runHeadless({ root, driver, maxTurns, stallTurns: 2, stateDir: state }))
      events.push(event)
    return events
  }
  const driver = (onTurn: () => Promise<void>): HarnessDriver => ({
    id: "fake",
    available: async () => true,
    async *turn() {
      yield { text: "working" }
      await onTurn()
      return "ses_fake"
    },
  })

  test("stops for the grill, for pending approvals, and when progress stalls", async () => {
    expect((await collect(driver(async () => {}))).at(-1)).toMatchObject({ type: "error" })
    const factory = await grilledFrontier()
    expect((await collect(driver(async () => {}))).at(-1)).toMatchObject({ type: "waiting" })
    await mkdir(path.dirname(factoryLayout(root).pending), { recursive: true })
    await writeFile(factoryLayout(root).pending, JSON.stringify([{ stage: "spec", requestedBy: "factory", at: "x" }]))
    expect((await collect(driver(async () => {}))).at(-1)).toMatchObject({ type: "waiting", stages: ["spec"] })
    await writeFile(factoryLayout(root).pending, "[]")
    await run(["approve", "frontier"], human())
    expect((await factory.read())?.stage).toBe("RESEARCH")
    const stalled = await collect(driver(async () => {}))
    expect(stalled.filter((event) => event.type === "turn")).toHaveLength(2)
    expect(stalled.at(-1)).toMatchObject({ type: "stalled" })
  })

  test("reports a halt", async () => {
    const factory = await grilledFrontier()
    await run(["approve", "frontier"], human())
    const events = await collect(driver(() => factory.halt("system", "test halt").then(() => undefined)))
    expect(events.at(-1)).toMatchObject({ type: "halted", reason: "test halt" })
  })
})

describe("es audit and es scout (headless jobs)", () => {
  const AUTH = `export function login(db, user) {\n  const sql = "SELECT * FROM users WHERE name = '" + user + "'"\n  return db.query(sql)\n}\n`
  /** A fake harness turn that plays the seats through the core tools. */
  const seatDriver = (onTurn: (prompt: string) => Promise<void>): HarnessDriver => ({
    id: "fake",
    available: async () => true,
    async *turn({ prompt }) {
      yield { text: "working" }
      await onTurn(prompt)
      return "ses_fake"
    },
  })
  const core = () => import("@heretek-ai/es-core")

  test("--help has no side effects; no run and no ceiling is refused; creating a run needs a terminal", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src/auth.js"), AUTH)
    for (const argv of [
      ["audit", "src", "--help"],
      ["scout", "x", "--help"],
    ])
      expect((await run(argv)).code).toBe(0)
    expect(await exists(factoryLayout(root).dir)).toBe(false)
    const bare = await run(["audit", "src", "--open-only"])
    expect([bare.code, bare.out]).toEqual([2, expect.stringContaining("--max-usd <USD>")])
    expect((await run(["audit", "src", "--max-usd", "5", "--open-only"])).code).toBe(3)
    DRIVERS.fake = seatDriver(async () => {})
    try {
      expect((await run(["scout", "a parser", "--max-usd", "5", "--driver", "fake"])).code).toBe(3)
    } finally {
      delete DRIVERS.fake
    }
    expect(await exists(factoryLayout(root).state)).toBe(false)
  })

  test("an unavailable driver starts nothing: no run, no audit round", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src/auth.js"), AUTH)
    await run(["audit", "src", "--max-usd", "5", "--open-only"], human())
    DRIVERS.down = { id: "down", available: async () => false, async *turn() {} }
    try {
      const audit = await run(["audit", "src", "--driver", "down"])
      expect([audit.code, audit.out]).toEqual([2, expect.stringContaining("nothing was started")])
      expect((await run(["scout", "a parser", "--driver", "down"])).code).toBe(2)
    } finally {
      delete DRIVERS.down
    }
    expect((await run(["audit", "show", "audit-01"])).out).toContain("open (round 1)")
  })

  test("es audit opens on a run (provisioning its ceiling at a TTY), drives the pair, and reports the verdict", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    const { codeAuditTools, Factory } = await core()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src/auth.js"), AUTH)
    const opened = await run(["audit", "src", "--max-usd", "5", "--open-only"], human())
    expect([opened.code, opened.out]).toEqual([0, expect.stringContaining("Opened audit-01 (round 1) on path src.")])
    // Now the run has a ceiling: no terminal needed for the next round.
    const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
    const verdict = codeAuditTools({ root, factory, stateDir: state }).find((tool) => tool.name === "es_audit_verdict")!
    const prompts: string[] = []
    DRIVERS.fake = seatDriver(async (prompt) => {
      prompts.push(prompt)
      for (const agent of ["es-auditor-thesis", "es-auditor-antithesis"])
        await verdict.execute({ audit: "audit-01", verdict: "pass", findings: [], notes: "ok" }, { agent })
    })
    try {
      const driven = await run(["audit", "src", "--driver", "fake"])
      expect(driven.code).toBe(0)
      expect(driven.out).toContain("Opened audit-01 (round 2) on path src.")
      expect(driven.out).toContain("Audit audit-01 passed. Report: .factory/audits/audit-01/REPORT.md")
      expect(prompts[0]).toContain("Headless code audit audit-01 on path src")
    } finally {
      delete DRIVERS.fake
    }
    const shown = await run(["audit", "show"])
    expect(shown.out).toContain("audit-01 · path src · passed (round 2)")
  })

  test("es audit dismiss is human-only and unblocks", async () => {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src/auth.js"), AUTH)
    await run(["audit", "src", "--max-usd", "5", "--open-only"], human())
    expect((await run(["audit", "dismiss", "audit-01"], human())).code).toBe(2)
    expect((await run(["audit", "dismiss", "audit-01", "--reason", "vendored"])).code).toBe(3)
    expect((await run(["audit", "dismiss", "audit-01", "--reason", "vendored code we never ship"], human())).code).toBe(
      0,
    )
    expect((await run(["audit", "show", "audit-01"])).out).toContain("dismissed by human:")
  })

  test("es scout drives the scout seat until it completes and prints the ranked verdicts", async () => {
    const { DRIVERS } = await import("../src/headless.ts")
    const { scoutTools } = await core()
    await mkdir(path.join(root, "vendor/tiny"), { recursive: true })
    await writeFile(path.join(root, "vendor/tiny/index.js"), "module.exports = () => 1\n")
    await writeFile(path.join(root, "vendor/tiny/package.json"), '{"name":"tiny","version":"1.0.0"}')
    const tool = (name: string) => scoutTools({ root, stateDir: state }).find((item) => item.name === name)!
    DRIVERS.fake = seatDriver(async () => {
      const scout = { agent: "scout" }
      await tool("es_scout_plan").execute(
        { objective: "a tiny helper", candidates: [{ name: "tiny", source: "local:./vendor/tiny" }] },
        scout,
      )
      await tool("es_scout_scan").execute({ candidate: "tiny" }, scout)
      await tool("es_scout_record").execute(
        { candidate: "tiny", maintenance: "slow", proposal: "adopt", rationale: "small enough to keep", claims: [] },
        scout,
      )
      await tool("es_scout_complete").execute({}, scout)
    })
    try {
      const scouted = await run(["scout", "a tiny helper", "--max-usd", "3", "--driver", "fake"], human())
      expect(scouted.code).toBe(0)
      // No license file: adopt is downgraded by core, whatever the seat proposed.
      expect(scouted.out).toContain("1. tiny: clean-room")
      expect(scouted.out).toContain("Report: .factory/scout/REPORT.md. Adoption is your decision.")
    } finally {
      delete DRIVERS.fake
    }
    expect((await run(["scout", "show"])).out).toContain("1. tiny — unknown (unverified) — clean-room")
  })
})
