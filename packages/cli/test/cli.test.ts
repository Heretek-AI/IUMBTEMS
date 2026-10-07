import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, factoryLayout, gateRunner, readApproval } from "@heretek-ai/es-core"
import { parseArgs, parseExpiry } from "../src/args.ts"
import { type HarnessDriver, runHeadless } from "../src/headless.ts"
import { main } from "../src/main.ts"
import { createMcpServer } from "../src/mcp.ts"
import { type ConfirmIO, confirmWithCode, NotInteractive } from "../src/tty.ts"

let root: string
let state: string
const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-cli-"))
  state = await mkdtemp(path.join(tmpdir(), "es-cli-state-"))
  await git("init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# x\n")
  await git("add", "-A")
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
})
afterEach(async () => {
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
    version: "1.0",
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
