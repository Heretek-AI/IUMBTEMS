// Seat launch discipline (#195.2, #60, #228.3): background launches are refused
// and a running seat is never relaunched. Live-host where the harness allows
// (background refusal, clean relaunch after completion); the running-seat
// refusal runs the real tracker and the real guard against synthetic host
// events, because a fake-LLM seat completes in milliseconds and a live
// still-running window cannot be held deterministically.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENTS } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { createPolicyHooks } from "../src/policy.ts"
import { createSeatTracker, type SeatTracker } from "../src/seats.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

const hiddenSeats = AGENTS.filter((agent) => agent.hidden)

describe("seat launch discipline on the real host (#195)", () => {
  let h: Harness
  let state: string

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-discipline-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# discipline\n" },
    })
  }, 120_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("a background launch is refused from deep-researcher", async () => {
    const { tools } = await h.run(
      `go ${call("subagent", { agent: "es-research-alpha", description: "alpha", prompt: "scan", background: true })}`,
      { agent: "deep-researcher" },
    )
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:error"])
    expect(tools[0]?.text).toContain("Factory seats run in the foreground")
  }, 30_000)

  test("a background launch is refused from grill", async () => {
    const { tools } = await h.run(
      `go ${call("subagent", { agent: "es-brainstorm-critic", description: "critic", prompt: "score", background: true })}`,
      { agent: "grill" },
    )
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:error"])
    expect(tools[0]?.text).toContain("Factory seats run in the foreground")
  }, 30_000)

  test("a completed seat relaunches cleanly (no stale refusal)", async () => {
    for (const round of ["first", "second"]) {
      const { tools } = await h.run(
        `${round} ${call("subagent", { agent: "es-qa-functional", description: round, prompt: "reply ok" })}`,
        { agent: "factory" },
      )
      expect([round, ...tools.map((tool) => `${tool.name}:${tool.status}`)]).toEqual([round, "subagent:completed"])
    }
  }, 60_000)
})

describe("the running-seat guard (real tracker, synthetic host events)", () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "es-relaunch-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  const runtime = () => ({
    root,
    stateDir: root,
    factory: { read: async () => undefined },
    policy: async () => ({ root, stateDir: root }),
  })
  const setup = () => {
    const tracker: SeatTracker = createSeatTracker(runtime() as any)
    const hooks = createPolicyHooks(runtime() as any, tracker)
    const agentOf = async () => undefined
    return { tracker, hooks, agentOf }
  }
  const launch = (
    hooks: ReturnType<typeof createPolicyHooks>,
    agent: string,
    target: string,
    extra: Record<string, unknown> = {},
  ) =>
    hooks.before({
      tool: "subagent",
      agent,
      id: "t1",
      sessionID: "ses_factory",
      input: { agent: target, description: "check", prompt: "go", ...extra },
    })

  for (const seat of hiddenSeats) {
    test(`${seat.id} cannot be relaunched while running, and launches after it completes`, async () => {
      const { tracker, hooks, agentOf } = setup()
      const sessionID = `ses_${seat.id.replace(/[^a-z]/g, "")}`
      await tracker.onEvent(
        { type: "session.created", data: { sessionID, parentID: "ses_factory", agent: seat.id } },
        agentOf,
      )
      await expect(launch(hooks, "factory", seat.id)).rejects.toThrow(
        `${seat.id} is still running (session ${sessionID}`,
      )
      await tracker.onEvent({ type: "session.execution.succeeded", data: { sessionID } }, agentOf)
      await expect(launch(hooks, "factory", seat.id)).resolves.toBeUndefined()
    })
  }

  test("a different seat may launch while one runs", async () => {
    const { tracker, hooks, agentOf } = setup()
    await tracker.onEvent(
      {
        type: "session.created",
        data: { sessionID: "ses_alpha", parentID: "ses_factory", agent: "es-research-alpha" },
      },
      agentOf,
    )
    await expect(launch(hooks, "factory", "es-research-beta")).resolves.toBeUndefined()
  })

  for (const spec of AGENTS) {
    test(`background:true is refused from seat ${spec.id}`, async () => {
      const { hooks } = setup()
      await expect(launch(hooks, spec.id, "es-qa-functional", { background: true })).rejects.toThrow(
        "Factory seats run in the foreground",
      )
    })
  }
})
