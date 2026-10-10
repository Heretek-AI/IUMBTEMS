import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exists, factoryLayout, HUMAN_VERBS } from "@heretek-ai/es-core"
import { createMcpServer, PROTOCOL_VERSION } from "../src/mcp.ts"

let root: string
let state: string
const realXdgConfig = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-mcp-identity-"))
  state = await mkdtemp(path.join(tmpdir(), "es-mcp-identity-state-"))
  process.env.XDG_CONFIG_HOME = path.join(state, "xdg-config")
})
afterEach(async () => {
  if (realXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = realXdgConfig
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const call = (server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown>, id = 1) =>
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

describe("mcp identity pinning (#201, proof gaps #230)", () => {
  test("lists exactly the 12 coarse tools (a new tool must face the HUMAN_VERBS screen below)", async () => {
    const server = createMcpServer({ root, stateDir: state, env: {} })
    expect((await toolNames(server)).sort()).toEqual(
      [
        "status",
        "frontier_write",
        "request_approval",
        "research_complete",
        "spec_validate",
        "build_start",
        "gates_run",
        "complete",
        "qa_verdict",
        "tiebreak",
        "replan",
        "release",
      ].sort(),
    )
  })

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

  test("createMcpServer itself does not read legacy ES_AGENT (only main.ts maps it to defaultAgent)", async () => {
    const server = createMcpServer({ root, stateDir: state, env: { ES_AGENT: "factory" } })
    const refused = await call(server, "complete", {})
    expect(refused?.result.isError).toBe(true)
    expect(refused?.result.content[0].text).toContain("called by mcp")
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
