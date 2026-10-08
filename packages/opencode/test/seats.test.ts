// Seat discipline (1.1.3, #60): factory seats run in the foreground only, a
// running seat is never launched twice, and every seat's state and last
// activity reach .factory/runtime/seats.json and es_status.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, gateRunner, readSeats, type SeatRecord } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { createPolicyHooks } from "../src/policy.ts"
import type { SeatTracker } from "../src/seats.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const child = (name: string, args: Record<string, unknown> = {}) => `@@CHILD ${name} ${JSON.stringify(args)}@@`

describe("seat discipline on the real host (#60)", () => {
  let h: Harness
  let state: string
  const factory = () => new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-seats-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# seats\n" },
    })
    await factory().begin("human:tester")
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("a background seat launch is refused with the foreground instruction", async () => {
    const { tools } = await h.run(
      `go ${call("subagent", { agent: "es-qa-functional", description: "qa", prompt: "check", background: true })}`,
      { agent: "factory" },
    )
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:error"])
    expect(tools[0]?.text).toContain("Factory seats run in the foreground")
  })

  test("a foreground seat is recorded running, then completed with its last tool; es_status lists it", async () => {
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
    let seats: SeatRecord[] = []
    for (let i = 0; i < 100; i++) {
      seats = await readSeats(h.directory, runId)
      if (seats.some((seat) => seat.state === "completed")) break
      await Bun.sleep(20)
    }
    const qa = seats.find((seat) => seat.agent === "es-qa-functional")
    expect(qa).toMatchObject({ state: "completed", lastTool: "es_status" })
    expect(qa?.parentID).toBe(delegated.sessionID)
    expect(qa?.endedAt).toBeDefined()

    const status = await h.run(`status ${call("es_status", {})}`, { agent: "factory" })
    expect(status.tools[0]?.text).toContain("seats:")
    expect(status.tools[0]?.text).toMatch(/es-qa-functional {2}completed/)
  })
})

describe("the launch guard", () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "es-guard-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  const running: SeatRecord = {
    sessionID: "ses_alpha",
    agent: "es-research-alpha",
    parentID: "ses_factory",
    startedAt: "2026-10-08T02:00:00.000Z",
    lastActivityAt: "2026-10-08T02:00:30.000Z",
    lastTool: "es_research_fetch",
    state: "running",
  }
  const tracker: SeatTracker = {
    onEvent: async () => {},
    onTool: async () => {},
    running: (agent) => (agent === undefined || agent === running.agent ? [running] : []),
    hasRunningChildren: () => true,
  }
  const runtime = () => ({
    root,
    stateDir: root,
    factory: { read: async () => undefined },
    policy: async () => ({ root, stateDir: root }),
  })
  const before = (input: Record<string, unknown>, agent = "factory") =>
    createPolicyHooks(runtime() as any, tracker).before({
      tool: "subagent",
      agent,
      id: "t1",
      sessionID: "ses_factory",
      input,
    })

  test("refuses a second launch of a running seat, naming its session", async () => {
    await expect(before({ agent: "es-research-alpha", description: "again", prompt: "write it" })).rejects.toThrow(
      "es-research-alpha is still running (session ses_alpha",
    )
  })

  test("allows a different seat, and only guards factory seats", async () => {
    await expect(before({ agent: "es-research-beta", description: "beta", prompt: "attack" })).resolves.toBeUndefined()
    await expect(
      before({ agent: "es-research-alpha", description: "x", prompt: "y", background: true }, "build"),
    ).resolves.toBeUndefined()
  })
})
