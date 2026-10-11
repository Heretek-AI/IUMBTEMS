// Registry proof gaps on the real host (#228): a vanilla-baseline diff that
// locks "never touching built-ins or defaults", hidden-seat flags read back
// from the live host, and the duplicate-seat guard driven with the real
// tracker, real hooks and a real seat record (the old guard test stubbed the
// whole tracker).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENTS, Factory, gateRunner, readSeats, type SeatRecord } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness, lastAgentRequest, systemText } from "@heretek-ai/es-testkit"
import { createPolicyHooks } from "../src/policy.ts"
import { createSeatTracker } from "../src/seats.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const probeDir = path.join(import.meta.dir, "probe-agents")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const child = (name: string, args: Record<string, unknown> = {}) => `@@CHILD ${name} ${JSON.stringify(args)}@@`

interface ProbeAgent {
  readonly id: string
  readonly hidden: boolean
  readonly model?: unknown
  readonly description?: unknown
}

const readProbe = async (out: string) => {
  for (let i = 0; i < 200 && !(await Bun.file(out).exists()); i++) await Bun.sleep(50)
  return JSON.parse(await readFile(out, "utf8")) as { list: ProbeAgent[] }
}

async function snapshot(plugins: Array<{ path: string; options?: Record<string, unknown> }>, out: string) {
  const h = await boot({
    git: false,
    script: directiveScript,
    plugins,
    files: { "README.md": "# registry-host\n" },
  })
  await h.run("hello")
  const request = lastAgentRequest(h.llm.requests)
  const tools = (request?.tools ?? []).map((tool) => tool.function.name).sort()
  const skills = [...systemText(request).matchAll(/<id>([^<]+)<\/id>/g)].map((match) => match[1]).sort()
  const agents = (await readProbe(out)).list
  await h.close()
  return { tools, skills, agents }
}

describe("vanilla-baseline diff: the plugin never touches built-ins or defaults (#228.1)", () => {
  let tmp: string
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "es-registry-host-"))
  })
  afterAll(() => rm(tmp, { recursive: true, force: true }))

  test("built-in agents, models and defaults are identical; tools and skills only grow", async () => {
    const vanillaOut = path.join(tmp, "vanilla.json")
    const pluginOut = path.join(tmp, "plugin.json")
    const state = await mkdtemp(path.join(tmpdir(), "es-registry-host-state-"))
    try {
      const vanilla = await snapshot([{ path: probeDir, options: { out: vanillaOut } }], vanillaOut)
      const plugin = await snapshot(
        [
          { path: pluginDir, options: { stateDir: state, pr: "off" } },
          { path: probeDir, options: { out: pluginOut } },
        ],
        pluginOut,
      )
      // Agents: every vanilla agent is byte-identical under the plugin
      // (id, hidden flag, model and description); the plugin only adds the
      // registry's own agents, one per AGENTS entry.
      const byId = (agents: ProbeAgent[]) => new Map(agents.map((agent) => [agent.id, agent]))
      const vanillaAgents = byId(vanilla.agents)
      const pluginAgents = byId(plugin.agents)
      for (const [id, agent] of vanillaAgents) expect([id, pluginAgents.get(id)]).toEqual([id, agent])
      expect([...pluginAgents.keys()].filter((id) => !vanillaAgents.has(id)).sort()).toEqual(
        AGENTS.map((agent) => agent.id).sort(),
      )
      // Defaults: the default session keeps every vanilla tool (nothing
      // removed or renamed); the additions are the documented ambient
      // surface (session.ts:14 deletes every other es_* for non-factory
      // agents, so exactly es_status/es_gates_run remain) plus our lsp tools.
      for (const tool of vanilla.tools) expect(plugin.tools).toContain(tool)
      for (const added of plugin.tools.filter((tool) => !vanilla.tools.includes(tool))) {
        expect(added.startsWith("es_") || added.startsWith("lsp_")).toBe(true)
        if (added.startsWith("es_")) expect(["es_status", "es_gates_run"]).toContain(added)
      }
      expect(plugin.tools).toContain("es_status")
      expect(plugin.tools).toContain("es_gates_run")
      // Skills: one shared tree, vanilla skills intact, ours added.
      for (const skill of vanilla.skills) expect(plugin.skills).toContain(skill)
      for (const skill of ["brainstorm", "code-audit", "factory", "grill", "harvest", "queereye", "scout"])
        expect(plugin.skills).toContain(skill)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  }, 120_000)
})

describe("hidden seats on the real host (#228.2)", () => {
  let h: Harness
  let state: string
  let out: string
  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-registry-hidden-"))
    out = path.join(state, "agents.json")
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [
        { path: pluginDir, options: { stateDir: state, pr: "off" } },
        { path: probeDir, options: { out } },
      ],
      files: { "README.md": "# registry-hidden\n" },
    })
    await h.run("hello")
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("registry subagents are hidden, primaries are not, and a hidden seat runs by ID", async () => {
    const agents = new Map((await readProbe(out)).list.map((agent) => [agent.id, agent]))
    for (const spec of AGENTS)
      expect([spec.id, agents.get(spec.id)?.hidden]).toEqual([spec.id, spec.mode === "subagent"])
    // Unlisted but invocable by ID: a hidden seat runs when named directly.
    const run = await h.run("ping", { agent: "es-qa-functional" })
    expect(run.tools).toEqual([])
  })
})

describe("the duplicate-seat guard with the real tracker on the real host (#228.3)", () => {
  let h: Harness
  let state: string
  const factory = () => new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-registry-guard-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# registry-guard\n" },
    })
    await factory().begin("human:tester")
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("a second launch of a running seat is refused with its live session id", async () => {
    // A real foreground launch on the live host, with a real seat record.
    const delegated = await h.run(
      `go ${call("subagent", {
        agent: "es-qa-functional",
        description: "status check",
        prompt: `check ${child("es_status", {})} and report`,
      })}`,
      { agent: "factory" },
    )
    expect(delegated.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:completed"])
    const runId = (await factory().read())!.runId
    const live = (await readSeats(h.directory, runId)).find((seat) => seat.agent === "es-qa-functional")!
    expect(live.state).toBe("completed")

    // The real tracker and the real policy guard, fed the seat's real
    // session.created (a resumed host re-picks running seats the same way).
    const runtime = {
      root: h.directory,
      stateDir: state,
      factory: factory(),
      policy: async () => ({ root: h.directory, stateDir: state }),
    }
    const tracker = createSeatTracker(runtime as any)
    const hooks = createPolicyHooks(runtime as any, tracker)
    const agentOf = async (sessionID: string) =>
      (await readSeats(h.directory, runId)).find((seat) => seat.sessionID === sessionID)?.agent
    await tracker.onEvent(
      { type: "session.created", data: { sessionID: live.sessionID, parentID: live.parentID, agent: live.agent } },
      agentOf,
    )
    expect(tracker.running("es-qa-functional").map((seat) => seat.sessionID)).toEqual([live.sessionID])
    await expect(
      hooks.before({
        tool: "subagent",
        agent: "factory",
        id: "t-live",
        sessionID: "ses_factory_live",
        input: { agent: "es-qa-functional", description: "again", prompt: "recheck" },
      }),
    ).rejects.toThrow(`${live.agent} is still running (session ${live.sessionID}`)
    // Once the seat's execution ends, the same launch is allowed again.
    await tracker.onEvent({ type: "session.execution.succeeded", data: { sessionID: live.sessionID } }, agentOf)
    expect(tracker.running("es-qa-functional")).toEqual([])
    await expect(
      hooks.before({
        tool: "subagent",
        agent: "factory",
        id: "t-live-2",
        sessionID: "ses_factory_live",
        input: { agent: "es-qa-functional", description: "again", prompt: "recheck" },
      }),
    ).resolves.toBeUndefined()
    const records: SeatRecord[] = await readSeats(h.directory, runId)
    expect(records.some((seat) => seat.sessionID === live.sessionID)).toBe(true)
  })
})
