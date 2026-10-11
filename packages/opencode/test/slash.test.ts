// Slash commands (#274 duplicate `/research`, #276 routing gaps, #277 `/lsp`
// coverage): one name per command, and per-command routing (seat/verb) proven
// by invoking each body against a stub session — no host needed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { formatReport } from "@heretek-ai/es-core"
import { createRuntime, parseOptions, type Runtime } from "../src/runtime.ts"
import { type CommandSession, esCommandSpecs } from "../src/server.ts"

let root: string
let state: string
let runtime: Runtime

const stubSession = () => {
  const switched: Array<{ sessionID: string; agent: string }> = []
  const prompted: Array<{ sessionID: string; prompt: Record<string, unknown>; text: string; delivery: unknown }> = []
  const said: Array<{ sessionID: string; text: string }> = []
  const io: CommandSession = {
    switchAgent: async (sessionID, agent) => {
      switched.push({ sessionID, agent })
    },
    sendPrompt: async (sessionID, prompt, text, delivery) => {
      prompted.push({ sessionID, prompt, text, delivery })
    },
    synthetic: async (sessionID, text) => {
      said.push({ sessionID, text })
    },
  }
  return { io, switched, prompted, said }
}

const stubBridge = () => ({
  engine: {
    refresh: async () => {},
    status: () => ({
      handlers: 2,
      projectHandlers: 1,
      trusted: false,
      projectLines: ["project hook line"],
      diagnostics: ["bridge diagnostic"],
    }),
    recent: ["recent failure"],
  },
})

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-slash-"))
  state = await mkdtemp(path.join(tmpdir(), "es-slash-state-"))
  runtime = await createRuntime(root, parseOptions({ stateDir: state }))
})

afterEach(async () => {
  await runtime.lsp.stopAll().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const specs = () => esCommandSpecs(stubSession().io, runtime, stubBridge())
const byName = () => new Map(specs().map((spec) => [spec.name, spec]))

describe("slash command registration (#274)", () => {
  test("13 unique names, with a single research", () => {
    const names = specs().map((spec) => spec.name)
    expect(names.filter((name) => name === "research")).toHaveLength(1)
    expect([...new Set(names)].sort()).toEqual(
      [
        "audit",
        "brainstorm",
        "config",
        "design",
        "factory",
        "gates",
        "grill",
        "harvest",
        "hooks",
        "lsp",
        "research",
        "scout",
        "status",
      ].sort(),
    )
  })
})

describe("per-command routing: seat and verb (#276.2)", () => {
  test("grill / brainstorm / harvest / design / scout switch to their seat with a verb", async () => {
    const routes: Array<[string, string, string]> = [
      ["grill", "grill", "Grill me on: q"],
      ["brainstorm", "brainstormer", "Brainstorm: q"],
      ["harvest", "harvester", "Darkharvest: q"],
      ["design", "designer", "Run the design interview. Product: q"],
      ["scout", "scout", "Scout: q"],
    ]
    for (const [name, seat, verb] of routes) {
      const stub = stubSession()
      const spec = new Map(esCommandSpecs(stub.io, runtime, stubBridge()).map((item) => [item.name, item])).get(name)!
      await spec.execute({ sessionID: "ses_1", prompt: { text: "q" }, delivery: undefined })
      expect([name, stub.switched]).toEqual([name, [{ sessionID: "ses_1", agent: seat }]])
      expect([name, stub.prompted[0]?.text]).toEqual([name, verb])
    }
  })

  test("research deep starts a research run and routes to the deep-researcher", async () => {
    const stub = stubSession()
    const spec = new Map(esCommandSpecs(stub.io, runtime, stubBridge()).map((item) => [item.name, item])).get(
      "research",
    )!
    await spec.execute({ sessionID: "ses_1", prompt: { text: "deep what queue --max-usd 5" }, delivery: undefined })
    const begun = await runtime.factory.read()
    expect(begun).toMatchObject({ mode: "research", stage: "RESEARCH" })
    expect(stub.switched).toEqual([{ sessionID: "ses_1", agent: "deep-researcher" }])
    expect(stub.prompted[0]?.text).toContain("es_research_complete")
  })

  test("research without deep shows the report reader, not usage", async () => {
    const stub = stubSession()
    const spec = new Map(esCommandSpecs(stub.io, runtime, stubBridge()).map((item) => [item.name, item])).get(
      "research",
    )!
    await spec.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: undefined })
    expect(stub.switched).toEqual([])
    expect(stub.said[0]?.text).toContain("No research report yet")
    // A bare `deep` still gets the deep flow's usage, not the report.
    const usage = stubSession()
    const usageSpec = new Map(esCommandSpecs(usage.io, runtime, stubBridge()).map((item) => [item.name, item])).get(
      "research",
    )!
    await usageSpec.execute({ sessionID: "ses_1", prompt: { text: "deep" }, delivery: undefined })
    expect(usage.said[0]?.text).toContain("Usage: /research deep")
  })

  test("audit usage and ceiling refusals stay synthetic", async () => {
    const stub = stubSession()
    const spec = byName().get("audit")!
    // Rebind the spec to this stub's session: rebuild with the same stub.
    const bound = new Map(esCommandSpecs(stub.io, runtime, stubBridge()).map((item) => [item.name, item])).get("audit")!
    expect(spec.name).toBe(bound.name)
    await bound.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: undefined })
    expect(stub.said[0]?.text).toContain("Usage: /audit")
    await bound.execute({ sessionID: "ses_1", prompt: { text: "src/x.ts" }, delivery: undefined })
    expect(stub.said[1]?.text).toContain("spend ceiling")
    expect(stub.switched).toEqual([])
  })

  test("factory with no run is synthetic; gates renders the gate report", async () => {
    const stub = stubSession()
    const commands = new Map(esCommandSpecs(stub.io, runtime, stubBridge()).map((item) => [item.name, item]))
    await commands.get("factory")!.execute({ sessionID: "ses_1", prompt: {}, delivery: undefined })
    expect(stub.said[0]?.text).toContain("No factory run here yet")
    const canned = { summary: "Gates passed (stubbed).", findings: [], totalFindings: 0, logDir: "stub" }
    const gated = stubSession()
    const gatedCommands = new Map(
      esCommandSpecs(gated.io, runtime, stubBridge(), {
        git: (async () => ({ stdout: "" })) as never,
        runGates: (async () => canned) as never,
      }).map((item) => [item.name, item]),
    )
    await gatedCommands.get("gates")!.execute({ sessionID: "ses_1", prompt: {}, delivery: undefined })
    expect(gated.said[0]?.text).toBe(formatReport(canned as never))
  })

  test("lsp reports status and availability lines (#277.1)", async () => {
    const stub = stubSession()
    const commands = new Map(esCommandSpecs(stub.io, runtime, stubBridge()).map((item) => [item.name, item]))
    await commands.get("lsp")!.execute({ sessionID: "ses_1", prompt: {}, delivery: undefined })
    const text = stub.said[0]?.text ?? ""
    expect(text).toMatch(/LSP is (on|disabled)/)
    expect(text).toContain("typescript")
  })

  test("hooks / status / config render server content synthetically", async () => {
    const stub = stubSession()
    const commands = new Map(esCommandSpecs(stub.io, runtime, stubBridge()).map((item) => [item.name, item]))
    await commands.get("hooks")!.execute({ sessionID: "ses_1", prompt: {}, delivery: undefined })
    expect(stub.said[0]?.text).toContain("Hook bridge: 2 handler(s)")
    expect(stub.said[0]?.text).toContain("NOT trusted")
    await commands.get("status")!.execute({ sessionID: "ses_1", prompt: {}, delivery: undefined })
    expect(stub.said[1]?.text).toContain("<factory-state>")
    await commands.get("config")!.execute({ sessionID: "ses_1", prompt: {}, delivery: undefined })
    expect(stub.said[2]?.text).toContain("Layers:")
  })
})
