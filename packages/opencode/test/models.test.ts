// Fail-closed seat model mapping (#96): malformed refs and ghost agent ids
// fail config parsing; a configured model missing on the host refuses that
// seat's launch with remediation (per-seat, never the whole plugin); valid
// mappings apply; es_status surfaces problems.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENTS, loadEsConfig } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { compileAgents, modelFor, modelProblems } from "../src/agents.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const factory = { id: "factory", seat: "factory", tier: "deep" } as const
const programmer = { id: "es-programmer", seat: "programmer", tier: "balanced" } as const

describe("model mapping units", () => {
  test("modelFor resolves agent overrides, then tiers, and parses the ref", () => {
    expect(modelFor(factory as any, {} as any)).toBeUndefined()
    expect(modelFor(factory as any, { models: { deep: "acme/strong" } } as any)).toEqual({
      providerID: "acme",
      id: "strong",
    })
    expect(
      modelFor(programmer as any, { models: { balanced: "acme/ok", agents: { "es-programmer": "acme/fast" } } } as any),
    ).toEqual({ providerID: "acme", id: "fast" })
    expect(modelFor(factory as any, { models: { deep: "noslash" } } as any)).toBeUndefined()
  })

  test("modelProblems reports configured refs missing on the host, keyed by seat", () => {
    const exists = (providerID: string, id: string) => providerID === "fake" && id === "scripted"
    expect(modelProblems({} as any, AGENTS, exists)).toEqual([])
    const problems = modelProblems(
      { models: { deep: "fake/ghost", agents: { "es-programmer": "fake/scripted", factory: "bad" } } } as any,
      AGENTS,
      exists,
    )
    const byAgent = new Map(problems.map((problem) => [problem.agent, problem]))
    expect(byAgent.get("factory")).toMatchObject({ key: "models.agents.factory", ref: "bad" })
    expect(byAgent.get("es-manager")?.key).toBe("models.deep")
    expect(byAgent.has("es-programmer")).toBe(false)
    expect(problems.every((problem) => /es config set|unset/.test(problem.message))).toBe(true)
  })

  test("malformed refs fail the config load, naming the key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-models-"))
    try {
      await expect(loadEsConfig(root, { overrides: { models: { deep: "noslash" } } })).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a valid mapping leaves no seat on the host default", async () => {
    const agents = await compileAgents({ models: { deep: "fake/scripted" } } as any, [])
    const deep = agents.filter((agent) => agent.spec.tier === "deep")
    expect(deep.length).toBeGreaterThan(0)
    for (const agent of deep) expect(agent.model).toEqual({ providerID: "fake", id: "scripted" })
  })

  test("a seat with a model problem is refused on any tool call, not just at launch", async () => {
    const { createPolicyHooks } = await import("../src/policy.ts")
    const { modelProblemMessage } = await import("../src/agents.ts")
    const message = modelProblemMessage("deep-researcher", "models.deep", "fake/ghost", true)
    const hooks = createPolicyHooks({
      modelProblems: new Map([
        ["deep-researcher", { agent: "deep-researcher", key: "models.deep", ref: "fake/ghost", message }],
      ]),
    } as any)
    for (const tool of ["es_status", "es_research_search", "read"])
      await expect(
        hooks.before({ tool, agent: "deep-researcher", id: "t1", input: tool === "read" ? { path: "x" } : {} }),
      ).rejects.toThrow("fake/ghost")
  })
})

describe("model mapping on the real host (fake provider: fake/scripted)", () => {
  let h: Harness
  let state: string
  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-models-state-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [
        {
          path: pluginDir,
          options: {
            stateDir: state,
            pr: "off",
            models: { deep: "fake/scripted", agents: { "es-programmer": "fake/ghost-model" } },
          },
        },
      ],
      files: { "README.md": "# models\n" },
    })
  }, 120_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("a seat whose model is missing is refused at launch with remediation", async () => {
    for (const launcher of ["factory", "build"]) {
      const { tools } = await h.run(
        `go ${call("subagent", { agent: "es-programmer", description: "x", prompt: "build it" })}`,
        { agent: launcher },
      )
      expect([launcher, ...tools.map((tool) => `${tool.name}:${tool.status}`)]).toEqual([launcher, "subagent:error"])
      expect(tools[0]?.text).toContain("fake/ghost-model")
      expect(tools[0]?.text).toContain("models.agents.es-programmer")
      expect(tools[0]?.text).toContain("es config set")
    }
  })

  test("es_status surfaces the model problem", async () => {
    const { tools } = await h.run(`status ${call("es_status", {})}`, { agent: "factory" })
    expect(tools[0]?.text).toContain("fake/ghost-model")
  })

  test("a seat with a valid mapping still launches", async () => {
    const { tools } = await h.run(
      `go ${call("subagent", { agent: "es-manager", description: "x", prompt: "say done" })}`,
      { agent: "factory" },
    )
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:completed"])
  })
})

describe("a primary seat with a missing model is refused on any tool call (#96)", () => {
  let primary: Harness
  let primaryState: string
  beforeAll(async () => {
    primaryState = await mkdtemp(path.join(tmpdir(), "es-models-primary-state-"))
    primary = await boot({
      git: true,
      script: directiveScript,
      plugins: [
        {
          path: pluginDir,
          options: { stateDir: primaryState, pr: "off", models: { deep: "fake/ghost-deep" } },
        },
      ],
      files: { "README.md": "# models primary\n" },
    })
  }, 120_000)
  afterAll(async () => {
    await primary?.close()
    await rm(primaryState, { recursive: true, force: true })
  })

  test("its first tool call is refused with remediation, never run on the default model", async () => {
    const { tools } = await primary.run(`status ${call("es_status", {})}`, { agent: "factory" })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["es_status:error"])
    expect(tools[0]?.text).toContain("fake/ghost-deep")
    expect(tools[0]?.text).toContain("models.deep")
    expect(tools[0]?.text).toContain("es config set")
  })
})
