// MCP caller-identity pinning (#230, #232): the adapter pins one agent id per
// server in the server environment — `ES_MCP_AGENT`, else the legacy
// `ES_AGENT`, else the `defaultAgent` option — and the per-call `agent`
// argument is ignored. Without an adapter identity the caller is "mcp", which
// maps to no seat, so every seat-checked tool refuses. A pinned string that is
// not a registry agent id (e.g. `programmer`) pins to a seat-less identity:
// the caller string is still pinned, it just holds no seat.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, gateRunner, HUMAN_VERBS, readApproval } from "@heretek-ai/es-core"
import { createMcpServer } from "../src/mcp.ts"

let root: string
let state: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-mcp-id-"))
  state = await mkdtemp(path.join(tmpdir(), "es-mcp-id-state-"))
  const proc = Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
  await writeFile(path.join(root, "README.md"), "# x\n")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const call = (server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}, id = 1) =>
  server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })

describe("mcp identity pin order (mcp.ts:29)", () => {
  test("the legacy ES_AGENT pins the caller when ES_MCP_AGENT is absent", async () => {
    const server = createMcpServer({ root, stateDir: state, env: { ES_AGENT: "factory" } })
    const refused = await call(server, "complete", {})
    expect(refused?.result.isError).toBe(true)
    expect(refused?.result.content[0].text).toContain("called by factory")
  })

  test("ES_MCP_AGENT beats ES_AGENT beats defaultAgent", async () => {
    const top = createMcpServer({
      root,
      stateDir: state,
      env: { ES_MCP_AGENT: "es-qa-functional", ES_AGENT: "factory" },
      defaultAgent: "factory",
    })
    const pinned = await call(top, "complete", { agent: "factory" })
    expect(pinned?.result.isError).toBe(true)
    expect(pinned?.result.content[0].text).toContain("called by es-qa-functional")

    const legacy = createMcpServer({
      root,
      stateDir: state,
      env: { ES_AGENT: "factory" },
      defaultAgent: "es-qa-functional",
    })
    const viaLegacy = await call(legacy, "complete", {})
    expect(viaLegacy?.result.isError).toBe(true)
    expect(viaLegacy?.result.content[0].text).toContain("called by factory")

    const fallback = createMcpServer({ root, stateDir: state, env: {}, defaultAgent: "factory" })
    const viaDefault = await call(fallback, "complete", {})
    expect(viaDefault?.result.isError).toBe(true)
    expect(viaDefault?.result.content[0].text).toContain("called by factory")
  })

  test("a pinned string without a registry seat stays seat-less but pinned", async () => {
    const server = createMcpServer({ root, stateDir: state, env: { ES_MCP_AGENT: "programmer" } })
    const refused = await call(server, "complete", {})
    expect(refused?.result.isError).toBe(true)
    // Registry ids are `es-programmer`/`es-manager`/`factory`: the literal
    // `programmer` holds no seat, yet the caller string is still the pin.
    expect(refused?.result.content[0].text).toContain("called by programmer")
  })
})

describe("as-mcp refusal across every seat-gated tool", () => {
  // Every tool whose execute path opens with requireSeat, called with an
  // empty adapter environment (caller "mcp", no seat).
  const seatGated: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: "frontier_write", args: { frontier: {} } },
    { tool: "research_complete", args: {} },
    { tool: "build_start", args: {} },
    { tool: "qa_verdict", args: { verdict: "pass", notes: "n" } },
    { tool: "tiebreak", args: { verdict: "pass", notes: "n" } },
    { tool: "replan", args: { notes: "n" } },
    { tool: "release", args: {} },
    { tool: "complete", args: {} },
  ]
  for (const { tool, args } of seatGated) {
    test(`${tool} refuses the unpinned caller as mcp`, async () => {
      const server = createMcpServer({ root, stateDir: state, env: {} })
      const refused = await call(server, tool, args)
      expect(refused?.result.isError).toBe(true)
      expect(refused?.result.content[0].text).toContain("called by mcp")
    })
  }
})

describe("no MCP tool grants a human-only verb (derived from HUMAN_VERBS)", () => {
  test("the coarse tool list is exactly the 12 read/request/seat tools", async () => {
    const server = createMcpServer({ root, stateDir: state })
    const list = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    const names = list?.result.tools.map((tool: { name: string }) => tool.name).sort()
    // A future human-only verb gaining an MCP tool changes this list and fails loudly here.
    expect(names).toEqual(
      [
        "build_start",
        "complete",
        "frontier_write",
        "gates_run",
        "qa_verdict",
        "release",
        "replan",
        "request_approval",
        "research_complete",
        "spec_validate",
        "status",
        "tiebreak",
      ].sort(),
    )
  })

  test("no listed tool (except the request-only approval) matches a HUMAN_VERBS rule", async () => {
    const server = createMcpServer({ root, stateDir: state })
    const list = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    const names = list?.result.tools.map((tool: { name: string }) => tool.name) as string[]
    const humanOnly = (verb: string, sub: string | undefined): boolean => {
      const rule = HUMAN_VERBS.find(([name]) => name === verb)
      if (!rule) return false
      const [, predicate] = rule
      return predicate === undefined ? true : predicate(sub)
    }
    for (const name of names) {
      if (name === "request_approval") continue // request-only: proven below, never grants.
      const tokens = name.split(/[_-]/)
      const matched = HUMAN_VERBS.some(([verb, predicate]) => {
        if (!tokens.includes(verb)) return false
        if (predicate === undefined) return true
        return tokens.some((token) => token !== verb && predicate(token))
      })
      expect([name, matched, humanOnly("never-a-verb", undefined)]).toEqual([name, false, false])
    }
  })

  test("request_approval records a request without granting anything", async () => {
    const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
    await factory.writeFrontier("grill", {
      version: "1.1",
      idea: "mcp test",
      spendCeiling: { currency: "USD", maxAmount: 3 },
      settled: true,
      nodes: [{ id: "a", question: "q?", answer: "yes", status: "settled" }],
    })
    const server = createMcpServer({ root, stateDir: state, env: { ES_MCP_AGENT: "factory" } })
    const requested = await call(server, "request_approval", { stage: "frontier" })
    expect(requested?.result.isError).toBeUndefined()
    expect(requested?.result.content[0].text).toContain("Requested human approval")
    // Request-only: the approval file is still absent (a human grants it elsewhere).
    expect(await readApproval(root, "frontier")).toBeUndefined()
  })
})

describe("mcp identity over real stdio", () => {
  test("serveStdio pins ES_MCP_AGENT: a piped agent claim is refused as the pin", async () => {
    const proc = Bun.spawn(["bun", path.join(import.meta.dir, "../src/main.ts"), "mcp", "--cwd", root], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // The literal `programmer` holds no registry seat (#232.1), so the
      // seat check itself names the pin — the strongest stdio proof.
      env: { ...process.env, ES_MCP_AGENT: "programmer" },
    })
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "complete", arguments: { agent: "factory" } } })}\n`,
    )
    proc.stdin.end()
    const lines = (await new Response(proc.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    await proc.exited
    expect(lines.map((line) => line.id)).toEqual([1])
    expect(lines[0].result.isError).toBe(true)
    // The per-call `agent: "factory"` is ignored: the refusal names the pin.
    expect(lines[0].result.content[0].text).toContain("called by programmer")
    expect(await readFile(path.join(root, "README.md"), "utf8")).toContain("# x")
  })
})
