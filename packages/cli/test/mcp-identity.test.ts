// MCP caller-identity pinning (#201, #230, #232): the adapter pins one agent
// id per server in the server environment — `ES_MCP_AGENT`, else the legacy
// `ES_AGENT`, else the `defaultAgent` option — and the per-call `agent`
// argument is ignored. Without an adapter identity the caller is "mcp", which
// maps to no seat, so every seat-checked tool refuses. A pinned string that is
// not a registry agent id (e.g. `programmer`) pins to a seat-less identity:
// the caller string is still pinned, it just holds no seat.
// Union of the audit (#201) and remediation pin suites at the #290 merge:
// the audit side proves the tool list, the HUMAN_VERBS screen, request-only
// approval, the fallback order and stdio wiring; the remediation side proves
// the pin order, seat-less pins, grant-recording and STOP/HALTED enforcement.
// Dropped in the union (not kept): the audit side's "server ignores legacy
// ES_AGENT" test (asserted pre-remediation behavior; the remediation pin
// order reads ES_AGENT, proven by the pin-order test kept above) and the two
// exact-duplicate list/stdio tests subsumed by stronger twins.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exists, Factory, factoryLayout, gateRunner, HUMAN_VERBS, readApproval } from "@heretek-ai/es-core"
import { createMcpServer, PROTOCOL_VERSION } from "../src/mcp.ts"

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

const toolNames = async (server: ReturnType<typeof createMcpServer>): Promise<string[]> => {
  const list = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  return list?.result.tools.map((tool: any) => tool.name)
}

/** Every seat-checked MCP tool with minimal arguments, and a piped agent id
 *  that would be admitted if the per-call `agent` argument were honored. */
const SEAT_GATED: Readonly<Record<string, { readonly args: Record<string, unknown>; readonly spoof: string }>> = {
  frontier_write: { args: { frontier: {} }, spoof: "factory" },
  research_complete: { args: {}, spoof: "factory" },
  build_start: { args: {}, spoof: "factory" },
  complete: { args: {}, spoof: "es-programmer" },
  qa_verdict: { args: { verdict: "pass", notes: "identity-pin probe" }, spoof: "es-qa-functional" },
  tiebreak: { args: { verdict: "pass", notes: "identity-pin probe" }, spoof: "es-manager" },
  replan: { args: { notes: "identity-pin probe" }, spoof: "es-manager" },
  release: { args: {}, spoof: "factory" },
}

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

describe("mcp identity pinning (#201, proof gaps #230)", () => {
  test("no MCP tool grants a human-only action (derived from HUMAN_VERBS, not a fixed regex)", async () => {
    const server = createMcpServer({ root, stateDir: state, env: {} })
    const names = await toolNames(server)
    expect(names.length).toBeGreaterThan(0)
    for (const [verb, predicate] of HUMAN_VERBS) {
      const stem = verb.endsWith("e") ? verb.slice(0, -1) : verb
      const hits = names.filter((name) => name.includes(verb) || name.includes(stem))
      if (predicate === undefined) {
        // Bare verbs are human-only outright: only request_approval may name
        // one, and it is request-only (proven by the test below).
        expect({ verb, hits }).toEqual({ verb, hits: verb === "approve" ? ["request_approval"] : [] })
      } else {
        // Sub-gated verbs: a hit violates only when its sub-token is
        // human-only under the same predicate the shell policy uses.
        const violations = hits.filter((tool) => {
          const rest = (tool.includes(verb) ? tool.replace(verb, "") : tool.replace(stem, ""))
            .split("_")
            .filter(Boolean)
          return rest.length === 0 || rest.some((token) => predicate(token))
        })
        expect({ verb, violations }).toEqual({ verb, violations: [] })
      }
    }
  })

  test("request_approval is request-only: it cannot grant an approval", async () => {
    const server = createMcpServer({ root, stateDir: state, env: {} })
    const list = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    const request = list?.result.tools.find((tool: any) => tool.name === "request_approval")
    expect(request.description).toMatch(/cannot approve/i)
    // No approval-granting parameter (signature, passphrase): stage and note only.
    expect(Object.keys(request.inputSchema.properties).sort()).toEqual(["agent", "note", "stage"])
    const refused = await call(server, "request_approval", { stage: "frontier" })
    expect(refused?.result.isError).toBe(true)
    expect(refused?.result.content[0].text).toContain("Only the factory or grill seat may request approvals.")
    // The refusal records nothing: no pending request, no approval.
    expect(await exists(factoryLayout(root).pending)).toBe(false)
    expect(await exists(factoryLayout(root).approvals)).toBe(false)
  })

  test("ES_AGENT/defaultAgent fallback pins the caller (the CLI maps legacy ES_AGENT to defaultAgent)", async () => {
    const server = createMcpServer({ root, stateDir: state, env: {}, defaultAgent: "factory" })
    const refused = await call(server, "complete", {})
    expect(refused?.result.isError).toBe(true)
    expect(refused?.result.content[0].text).toContain("called by factory")
  })

  test("ES_MCP_AGENT beats defaultAgent (mcp.ts:29 order)", async () => {
    const server = createMcpServer({
      root,
      stateDir: state,
      env: { ES_MCP_AGENT: "es-programmer" },
      defaultAgent: "factory",
    })
    const scoped = await call(server, "complete", { agent: "es-manager" })
    expect(scoped?.result.isError).toBe(true)
    // Past the programmer-only seat check (no "called by"): the empty fixture
    // has no run, so the tool fails at the run check as programmer.
    expect(scoped?.result.content[0].text).toContain("No factory run here yet")
    expect(scoped?.result.content[0].text).not.toContain("called by")
  })

  for (const [name, { args, spoof }] of Object.entries(SEAT_GATED)) {
    test(`as mcp refuses ${name}: isError + called by mcp`, async () => {
      const server = createMcpServer({ root, stateDir: state, env: {} })
      const refused = await call(server, name, args)
      expect(refused?.result.isError).toBe(true)
      expect(refused?.result.content[0].text).toContain("called by mcp")
    })

    test(`a piped agent argument is ignored by ${name} (spoof ${spoof} still refused as mcp)`, async () => {
      const server = createMcpServer({ root, stateDir: state, env: {} })
      const refused = await call(server, name, { ...args, agent: spoof })
      expect(refused?.result.isError).toBe(true)
      expect(refused?.result.content[0].text).toContain("called by mcp")
    })
  }

  describe("over stdio (serveStdio through the real `es mcp` CLI: the #201 §2 bar)", () => {
    const mcpOverStdio = async (
      extraEnv: Record<string, string>,
      calls: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>,
    ) => {
      const env = { ...process.env }
      delete env.ES_MCP_AGENT
      delete env.ES_AGENT
      Object.assign(env, { ES_STATE_DIR: state }, extraEnv)
      const proc = Bun.spawn(["bun", path.join(import.meta.dir, "../src/main.ts"), "mcp", "--cwd", root], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      })
      let id = 0
      const send = (message: unknown) => proc.stdin.write(`${JSON.stringify(message)}\n`)
      send({
        jsonrpc: "2.0",
        id: ++id,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mcp-identity-test" } },
      })
      const initId = id
      const callIds = calls.map((item) => {
        send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: item.name, arguments: item.args } })
        return id
      })
      proc.stdin.end()
      const [out, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      const byId = new Map(
        out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { id: number })
          .map((message) => [message.id, message] as const),
      )
      return { init: byId.get(initId) as any, calls: callIds.map((callId) => byId.get(callId) as any), stderr }
    }

    test('no identity env + agent:"manager" over the wire → refused as mcp', async () => {
      const { init, calls, stderr } = await mcpOverStdio({}, [{ name: "complete", args: { agent: "manager" } }])
      expect(stderr).not.toContain("error")
      expect(init?.result.serverInfo.name).toBe("epistemic-swarm")
      expect(calls[0]?.result.isError).toBe(true)
      expect(calls[0]?.result.content[0].text).toContain("called by mcp")
    }, 60_000)

    test("ES_MCP_AGENT=es-programmer beats ES_AGENT=factory over the wire: scoped as programmer", async () => {
      const { calls } = await mcpOverStdio({ ES_MCP_AGENT: "es-programmer", ES_AGENT: "factory" }, [
        { name: "complete", args: { agent: "manager" } },
      ])
      expect(calls[0]?.result.isError).toBe(true)
      const text = calls[0]?.result.content[0].text as string
      expect(text).toContain("No factory run here yet")
      expect(text).not.toContain("called by")
    }, 60_000)

    test("literal ES_MCP_AGENT=programmer holds no seat (registry ids are es-*): refused, naming the pin", async () => {
      const { calls } = await mcpOverStdio({ ES_MCP_AGENT: "programmer" }, [
        { name: "complete", args: { agent: "manager" } },
      ])
      expect(calls[0]?.result.isError).toBe(true)
      expect(calls[0]?.result.content[0].text).toContain("called by programmer")
    }, 60_000)

    test("legacy ES_AGENT=es-qa-functional pins the caller through the real CLI", async () => {
      const { calls } = await mcpOverStdio({ ES_AGENT: "es-qa-functional" }, [
        { name: "complete", args: { agent: "factory" } },
      ])
      expect(calls[0]?.result.isError).toBe(true)
      // es-qa-functional holds a QA seat, not the programmer seat: the refusal
      // names the pinned legacy identity, not the piped factory claim.
      expect(calls[0]?.result.content[0].text).toContain("called by es-qa-functional")
    }, 60_000)
  })
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

describe("mcp STOP/HALTED enforcement (#227)", () => {
  test("a STOP file refuses tool calls on the MCP surface", async () => {
    await Bun.write(path.join(root, ".factory/STOP"), "halt\n")
    try {
      const server = createMcpServer({ root, stateDir: state, env: { ES_AGENT: "factory" } })
      const refused = await call(server, "status", {})
      expect(refused?.result.isError).toBe(true)
      expect(refused?.result.content[0].text).toContain("stopped")
    } finally {
      await rm(path.join(root, ".factory/STOP"), { force: true })
    }
  })

  test("a HALTED run refuses non-status tool calls on the MCP surface", async () => {
    const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
    await factory.begin("human:tester")
    await factory.halt("human:tester", "spend ceiling")
    const server = createMcpServer({ root, stateDir: state, env: { ES_AGENT: "factory" } })
    const refused = await call(server, "complete", {})
    expect(refused?.result.isError).toBe(true)
    expect(refused?.result.content[0].text).toContain("halted")
    const status = await call(server, "status", {})
    expect(status?.result.isError).not.toBe(true)
  })
})
