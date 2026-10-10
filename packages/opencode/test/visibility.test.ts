// Live-run visibility dashboard on the real host (#199.2, bug #248): the
// factoryState/status RPCs paused at each headline state, headline-first
// ordering (indexOf, not containment), research absence, DONE-without-PR and
// SPEC/RELEASE wording, and es_status over the host.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FactoryState, SeatRecord, Stage } from "@heretek-ai/es-core"
import { Factory, factoryLayout, gateRunner, signEngineFile, updateSeats, writeJson } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { EsRpc } from "../src/rpc-def.ts"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

let h: Harness
let state: string
const factory = () => new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
const rpcOf = () => (h.opencode as any).rpc(EsRpc) as any
const where = () => ({ location: h.location })

async function sealState(patch: Partial<FactoryState>) {
  const current = (await factory().read())!
  const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() }
  await writeJson(factoryLayout(h.directory).state, next)
  await signEngineFile(factoryLayout(h.directory).state, state)
  return next
}

async function setSeats(seats: SeatRecord[]) {
  const id = (await factory().read())!.runId
  await updateSeats(h.directory, id, (list) => {
    list.length = 0
    list.push(...seats)
  })
}

async function setPending(pending: Array<{ stage: string; requestedBy: string; at: string }>) {
  await mkdir(path.dirname(factoryLayout(h.directory).pending), { recursive: true })
  await writeFile(factoryLayout(h.directory).pending, JSON.stringify(pending))
}

const mkSeat = (overrides: Partial<SeatRecord> = {}): SeatRecord => ({
  sessionID: "ses_ee6b70e18ffeFKrOaELTUUcspV",
  agent: "es-research-alpha",
  parentID: "ses_factory",
  startedAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
  state: "running",
  ...overrides,
})

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-vis-op-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# visibility\n" },
  })
  await factory().begin("human:tester")
}, 60_000)

afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

describe("dashboard RPC paused at each headline state (#199.2)", () => {
  test("grill headline, header names the run, footer follows", async () => {
    await sealState({ stage: "GRILL", halt: undefined, release: undefined })
    await setSeats([])
    await setPending([])
    const rpc = rpcOf()
    const dashboard = await rpc.factoryState({}, where())
    expect(dashboard.headline).toBe("The grill is running: answer its questions in the grill session.")
    expect(dashboard.header).toContain(`· GRILL · ${h.directory} · updated`)
    expect(dashboard.stage).toBe("GRILL")
    const status = await rpc.status({}, where())
    expect(status.headline).toBe(dashboard.headline)
    expect(status.footer).toStartWith("ES · GRILL · last activity")
  }, 30_000)

  test("halted headline", async () => {
    await sealState({
      stage: "HALTED",
      halt: { reason: "STOP file: test", at: new Date().toISOString(), from: "BUILD" },
    })
    await setSeats([])
    await setPending([])
    expect((await rpcOf().factoryState({}, where())).headline).toContain("Halted: STOP file: test")
  }, 30_000)

  test("done with and without a PR (#248.5)", async () => {
    await sealState({
      stage: "DONE",
      halt: undefined,
      release: { prUrl: "https://example.test/pr/1", at: new Date().toISOString() },
    })
    await setSeats([])
    await setPending([])
    expect((await rpcOf().factoryState({}, where())).headline).toBe(
      "Done: the pull request is open at https://example.test/pr/1.",
    )
    await sealState({ stage: "DONE", halt: undefined, release: undefined, mode: "research" })
    expect((await rpcOf().factoryState({}, where())).headline).toBe("Done: the run is complete.")
  }, 30_000)

  test("pending headline", async () => {
    await sealState({ stage: "RESEARCH", halt: undefined, release: undefined, mode: "build" })
    await setSeats([])
    await setPending([{ stage: "spec", requestedBy: "agent:factory", at: new Date().toISOString() }])
    const dashboard = await rpcOf().factoryState({}, where())
    expect(dashboard.headline).toContain("Waiting for you: approve the spec")
    expect(dashboard.pending).toEqual(["spec"])
    await setPending([])
  }, 30_000)

  test("running, idle and stuck RESEARCH headlines", async () => {
    const rpc = rpcOf()
    await sealState({ stage: "RESEARCH", halt: undefined, release: undefined, mode: "build" })
    await setPending([])
    await setSeats([mkSeat({ lastActivityAt: new Date().toISOString(), lastTool: "es_research_fetch" })])
    expect((await rpc.factoryState({}, where())).headline).toContain(
      "Research is running: es-research-alpha last ran es_research_fetch",
    )
    await setSeats([])
    expect((await rpc.factoryState({}, where())).headline).toContain(
      "Research in progress: no seat is running; last activity",
    )
    const old = new Date(Date.now() - 20 * 60_000).toISOString()
    await rm(factoryLayout(h.directory).audit, { force: true })
    await sealState({ stage: "RESEARCH", halt: undefined, release: undefined, mode: "build", updatedAt: old })
    await setSeats([mkSeat({ lastActivityAt: old })])
    const stuck = await rpc.factoryState({}, where())
    expect(stuck.headline).toContain("It may be stuck")
    expect(stuck.headline).toContain("No activity for 20m in RESEARCH")
  }, 30_000)

  test("SPEC and RELEASE wording (#248.5)", async () => {
    const rpc = rpcOf()
    await sealState({ stage: "SPEC" as Stage, halt: undefined, release: undefined, mode: "build" })
    await setPending([])
    await setSeats([mkSeat({ agent: "es-manager", lastActivityAt: new Date().toISOString(), lastTool: "edit" })])
    expect((await rpc.factoryState({}, where())).headline).toStartWith("Spec writing is running:")
    await sealState({ stage: "RELEASE" as Stage, halt: undefined, release: undefined, mode: "build" })
    await setSeats([mkSeat({ agent: "factory", lastActivityAt: new Date().toISOString() })])
    expect((await rpc.factoryState({}, where())).headline).toStartWith("Release is running:")
  }, 30_000)

  test("no-run dashboard says how to start one", async () => {
    const layout = factoryLayout(h.directory)
    const backup = await Bun.file(layout.state)
      .text()
      .catch(() => undefined)
    await rm(layout.state, { force: true })
    await rm(`${layout.state}.sig`, { force: true })
    try {
      const dashboard = await rpcOf().factoryState({}, where())
      expect(dashboard.headline).toBe("No factory run in this project. Start one with /grill.")
      expect(dashboard.stage).toBe("NONE")
    } finally {
      if (backup !== undefined) {
        await writeFile(layout.state, backup)
        await signEngineFile(layout.state, state)
      } else {
        await factory()
          .begin("human:tester")
          .catch(() => undefined)
      }
    }
  }, 30_000)
})

describe("dashboard headline-first ordering (indexOf, not containment) (#248.2)", () => {
  test("FactoryPanel renders the headline before the header", async () => {
    const src = await Bun.file(path.resolve(pluginDir, "src/panels.tsx")).text()
    const headlineAt = src.indexOf("data().headline")
    const headerAt = src.indexOf("data().header")
    expect(headlineAt).toBeGreaterThan(-1)
    expect(headerAt).toBeGreaterThan(-1)
    expect(headlineAt).toBeLessThan(headerAt)
  })

  test("the RPC lead composes headline first (indexOf)", async () => {
    await sealState({ stage: "GRILL", halt: undefined, release: undefined })
    await setSeats([])
    await setPending([])
    const dashboard = await rpcOf().factoryState({}, where())
    const lead = `${dashboard.headline}\n${dashboard.header}`
    expect(lead.indexOf(dashboard.headline)).toBe(0)
    expect(lead.indexOf(dashboard.header)).toBeGreaterThan(lead.indexOf(dashboard.headline))
  }, 30_000)
})

describe("research absence on the dashboard (#248.3)", () => {
  test("non-RESEARCH stages carry no research field; RESEARCH does", async () => {
    const rpc = rpcOf()
    await sealState({ stage: "SPEC" as Stage, halt: undefined, release: undefined, mode: "build" })
    await setSeats([])
    await setPending([])
    expect((await rpc.factoryState({}, where())).research).toBeUndefined()
    await sealState({ stage: "BUILD" as Stage, halt: undefined, release: undefined, mode: "build" })
    expect((await rpc.factoryState({}, where())).research).toBeUndefined()
    await sealState({ stage: "RESEARCH", halt: undefined, release: undefined, mode: "build" })
    const research = (await rpc.factoryState({}, where())).research as string | undefined
    expect(typeof research).toBe("string")
    expect(research).toContain("sources")
  }, 30_000)
})

describe("es_status over the real host (#199.2)", () => {
  test("a seat's es_status lists seats, research progress and last activity", async () => {
    await sealState({ stage: "RESEARCH", halt: undefined, release: undefined, mode: "build" })
    await setPending([])
    await setSeats([mkSeat({ lastActivityAt: new Date().toISOString(), lastTool: "es_research_fetch" })])
    const { tools } = await h.run(`status ${call("es_status", {})}`, { agent: "factory" })
    expect(tools[0]?.status).toBe("completed")
    expect(tools[0]?.text).toContain("seats:")
    expect(tools[0]?.text).toMatch(/es-research-alpha {2}running/)
    expect(tools[0]?.text).toContain("research:")
    expect(tools[0]?.text).toContain("last activity")
  }, 60_000)
})
