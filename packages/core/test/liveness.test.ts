import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  footerLine,
  formatAge,
  formatHuman,
  headline,
  livenessLines,
  progressPrint,
  readLiveness,
  STALE_AFTER_MS,
} from "../src/factory/liveness.ts"
import { Factory } from "../src/factory/machine.ts"
import { indexRun, listRuns, runsIndexDir } from "../src/factory/runs.ts"
import { MAX_SEAT_RECORDS, readSeats, type SeatRecord, updateSeats } from "../src/factory/seats.ts"
import type { FactoryState } from "../src/factory/state.ts"
import { factoryLayout } from "../src/layout.ts"
import { researchSourcesDir, SourceCache } from "../src/research/cache.ts"
import { exists } from "../src/util/fs.ts"
import { type Fixture, frontier, gitRepo } from "./helpers.ts"

let fx: Fixture
beforeEach(async () => {
  fx = await gitRepo("es-live-")
})
afterEach(() => fx.cleanup())

const T0 = new Date("2026-10-08T02:00:00.000Z")
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

const factoryAt = (clock: { now: Date }) =>
  new Factory(fx.root, {
    gates: async () => ({ passed: true, findings: [], summary: "green" }),
    stateDir: fx.state,
    now: () => clock.now,
  })

const state = (overrides: Partial<FactoryState> = {}): FactoryState => ({
  version: 2,
  runId: "run-20261008-020000-ab12",
  stage: "RESEARCH",
  createdAt: T0.toISOString(),
  updatedAt: T0.toISOString(),
  spend: { usd: 1, estimated: true, events: 3 },
  phases: [],
  audits: [],
  ...overrides,
})

const seat = (overrides: Partial<SeatRecord> = {}): SeatRecord => ({
  sessionID: "ses_ee6b70e18ffeFKrOaELTUUcspV",
  agent: "es-research-alpha",
  parentID: "ses_factory",
  startedAt: T0.toISOString(),
  lastActivityAt: T0.toISOString(),
  state: "running",
  ...overrides,
})

const writeResearchFile = async (name: string, text: string, mtime: Date) => {
  const file = path.join(factoryLayout(fx.root).research, name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
  await utimes(file, mtime, mtime)
}

describe("seat records", () => {
  test("are scoped to the run: another run's file reads as empty and is replaced on update", async () => {
    await updateSeats(fx.root, "run-a", (seats) => {
      seats.push(seat())
    })
    expect(await readSeats(fx.root, "run-a")).toHaveLength(1)
    expect(await readSeats(fx.root, "run-b")).toEqual([])
    expect(await readSeats(fx.root, undefined)).toEqual([])
    await updateSeats(fx.root, "run-b", (seats) => {
      seats.push(seat({ sessionID: "ses_b" }))
    })
    expect((await readSeats(fx.root, "run-b")).map((item) => item.sessionID)).toEqual(["ses_b"])
    expect(await readSeats(fx.root, "run-a")).toEqual([])
  })

  test("keep only the newest records", async () => {
    await updateSeats(fx.root, "run-a", (seats) => {
      for (let i = 0; i < MAX_SEAT_RECORDS + 5; i++) seats.push(seat({ sessionID: `ses_${i}` }))
    })
    const seats = await readSeats(fx.root, "run-a")
    expect(seats).toHaveLength(MAX_SEAT_RECORDS)
    expect(seats.at(-1)!.sessionID).toBe(`ses_${MAX_SEAT_RECORDS + 4}`)
  })

  test("a malformed file reads as empty", async () => {
    await mkdir(factoryLayout(fx.root).runtime, { recursive: true })
    await writeFile(factoryLayout(fx.root).seats, "{not json")
    expect(await readSeats(fx.root, "run-a")).toEqual([])
  })
})

describe("readLiveness", () => {
  test("no run: stage NONE and the start hint", async () => {
    const live = await readLiveness(fx.root, undefined, { now: T0 })
    expect(live.stage).toBe("NONE")
    expect(headline(undefined, live)).toContain("/grill")
    expect(livenessLines(undefined, live)).toEqual([])
  })

  test("RESEARCH: counts cached sources, stamps the notes and report, and takes the newest activity", async () => {
    const current = state()
    const cache = new SourceCache(researchSourcesDir(fx.root), fx.state)
    await cache.put({ url: "https://example.test/a", text: "Alpha source text for the cache.", provider: "fetch" })
    await cache.put({ url: "https://example.test/b", text: "Beta source text for the cache.", provider: "fetch" })
    await writeResearchFile("alpha.md", "# alpha\n", at(30))
    await updateSeats(fx.root, current.runId, (seats) => {
      seats.push(seat({ lastActivityAt: at(45).toISOString(), lastTool: "es_research_fetch" }))
    })
    const live = await readLiveness(fx.root, current, { now: at(57) })
    expect(live.research?.sources).toBe(2)
    expect(live.research?.alpha?.bytes).toBe(8)
    expect(live.research?.report).toBeUndefined()
    expect(live.seats).toHaveLength(1)
    // Sources were written "now" (real clock), so the newest activity is at least the seat's.
    expect(live.lastActivityAt! >= at(45).toISOString()).toBe(true)
  })

  test("reads the recent audit events and pending approvals", async () => {
    const clock = { now: T0 }
    const factory = factoryAt(clock)
    await factory.begin("human:tester")
    await mkdir(factoryLayout(fx.root).runtime, { recursive: true })
    await writeFile(
      factoryLayout(fx.root).pending,
      JSON.stringify([{ stage: "frontier", requestedBy: "agent:grill", at: T0.toISOString() }]),
    )
    const current = await factory.read()
    const live = await readLiveness(fx.root, current, { now: at(5) })
    expect(live.events.at(-1)?.action).toBe("factory.begin")
    expect(live.pending.map((item) => item.stage)).toEqual(["frontier"])
    expect(headline(current, live)).toContain("es approve frontier")
  })
})

describe("headline", () => {
  const live = async (current: FactoryState, now: Date) => readLiveness(fx.root, current, { now })

  test("names each running seat, its last tool and its age", async () => {
    const current = state()
    await updateSeats(fx.root, current.runId, (seats) => {
      seats.push(seat({ lastActivityAt: at(48).toISOString(), lastTool: "es_research_fetch" }))
    })
    expect(headline(current, await live(current, at(60)))).toBe(
      "Research is running: es-research-alpha last ran es_research_fetch 12s ago.",
    )
  })

  test("without a running seat, says so with the last activity", async () => {
    const current = state({ updatedAt: at(20).toISOString() })
    expect(headline(current, await live(current, at(60)))).toBe(
      "Research in progress: no seat is running; last activity 40s ago.",
    )
  })

  test("flags a quiet active run as possibly stuck, naming the seat's session", async () => {
    const current = state()
    await updateSeats(fx.root, current.runId, (seats) => {
      seats.push(seat({ agent: "es-research-beta" }))
    })
    const text = headline(current, await live(current, new Date(T0.getTime() + STALE_AFTER_MS + 4 * 60_000)))
    expect(text).toContain("No activity for 14m in RESEARCH while es-research-beta is marked running")
    expect(text).toContain("ses_ee6b70e18ffe")
    expect(text).toContain(".factory/STOP")
  })

  test("halted, done, build and QA wording", async () => {
    const halted = state({ stage: "HALTED", halt: { reason: "STOP file: test", at: T0.toISOString(), from: "BUILD" } })
    expect(headline(halted, await live(halted, T0))).toContain("Halted: STOP file: test. A human must resume")
    const done = state({ stage: "DONE", release: { prUrl: "https://example.test/pr/1", at: T0.toISOString() } })
    expect(headline(done, await live(done, T0))).toBe("Done: the pull request is open at https://example.test/pr/1.")
    const build = state({ stage: "BUILD", activePhase: "p1" })
    expect(headline(build, await live(build, T0))).toStartWith("Building p1 in progress")
    const qa = state({ stage: "QA", activePhase: "p1" })
    expect(headline(qa, await live(qa, T0))).toStartWith("QA on p1 in progress")
  })
})

describe("formatHuman", () => {
  test("leads with the headline and the run header, then the summary, seats and research", async () => {
    const current = state({ updatedAt: at(20).toISOString() })
    await updateSeats(fx.root, current.runId, (seats) => {
      seats.push(seat({ lastActivityAt: at(50).toISOString(), lastTool: "es_research_fetch" }))
      seats.push(
        seat({
          sessionID: "ses_beta",
          agent: "es-research-beta",
          state: "completed",
          endedAt: at(10).toISOString(),
        }),
      )
    })
    const live = await readLiveness(fx.root, current, { now: at(60) })
    const text = formatHuman(
      current,
      live,
      "<factory-state>\nrun run-20261008-020000-ab12 · stage RESEARCH\nresearch depth 2: thesis + antithesis\n</factory-state>",
    )
    const lines = text.split("\n")
    expect(lines[0]).toStartWith("Research is running: es-research-alpha")
    expect(lines[1]).toBe(`run run-20261008-020000-ab12 · RESEARCH · ${fx.root} · updated 40s ago`)
    expect(text).toContain("research depth 2: thesis + antithesis")
    expect(text).not.toContain("<factory-state>")
    expect(text).toContain("es-research-alpha  running  es_research_fetch 10s ago  ses_ee6b70e18ffe")
    expect(text).toContain("es-research-beta  completed  50s ago  ses_beta")
    expect(text).toContain("research: 0 sources · alpha.md — · beta.md — · REPORT.md — · coverage not checked")
  })
})

describe("progressPrint", () => {
  test("moves on research artifacts and seat outcomes, not on spend", async () => {
    const current = state()
    const print = async (value: FactoryState) => progressPrint(value, await readLiveness(fx.root, value, { now: T0 }))
    const first = await print(current)
    expect(await print({ ...current, spend: { usd: 9, estimated: true, events: 99 } })).toBe(first)

    await new SourceCache(researchSourcesDir(fx.root), fx.state).put({
      url: "https://example.test/new",
      text: "A newly cached source counts as progress.",
      provider: "fetch",
    })
    const second = await print(current)
    expect(second).not.toBe(first)

    await writeResearchFile("REPORT.md", "# report\n", at(10))
    const third = await print(current)
    expect(third).not.toBe(second)

    await updateSeats(fx.root, current.runId, (seats) => {
      seats.push(seat())
    })
    const fourth = await print(current)
    expect(fourth).not.toBe(third)
    await updateSeats(fx.root, current.runId, (seats) => {
      seats[0] = { ...seats[0]!, lastActivityAt: at(30).toISOString(), lastTool: "es_research_search" }
    })
    expect(await print(current)).toBe(fourth)
    await updateSeats(fx.root, current.runId, (seats) => {
      seats[0] = { ...seats[0]!, state: "completed", endedAt: at(40).toISOString() }
    })
    expect(await print(current)).not.toBe(fourth)
  })
})

describe("footerLine", () => {
  test("hidden without a run; names the running seat, a pause, a pending approval, a halt", async () => {
    expect(footerLine(undefined, await readLiveness(fx.root, undefined, { now: T0 }))).toBeUndefined()
    const current = state({ updatedAt: at(20).toISOString() })
    expect(footerLine(current, await readLiveness(fx.root, current, { now: at(60) }))).toBe(
      "ES · RESEARCH · last activity 40s ago",
    )
    await updateSeats(fx.root, current.runId, (seats) => {
      seats.push(seat({ lastActivityAt: at(48).toISOString() }))
    })
    const live = await readLiveness(fx.root, current, { now: at(60) })
    expect(footerLine(current, live)).toBe("ES · RESEARCH · es-research-alpha running · 12s")
    expect(footerLine(current, live, "paused")).toBe("ES · RESEARCH · paused (no progress) · /factory continues")
    await updateSeats(fx.root, current.runId, (seats) => {
      seats.push(seat({ sessionID: "ses_beta", agent: "es-research-beta", lastActivityAt: at(55).toISOString() }))
    })
    expect(footerLine(current, await readLiveness(fx.root, current, { now: at(60) }))).toBe(
      "ES · RESEARCH · 2 seats running · 5s",
    )
    const halted = state({ stage: "HALTED", halt: { reason: "x", at: T0.toISOString(), from: "BUILD" } })
    expect(footerLine(halted, await readLiveness(fx.root, halted, { now: T0 }))).toBe(
      "ES · HALTED · a human must resume",
    )
    await mkdir(factoryLayout(fx.root).runtime, { recursive: true })
    await writeFile(
      factoryLayout(fx.root).pending,
      JSON.stringify([{ stage: "spec", requestedBy: "agent:factory", at: T0.toISOString() }]),
    )
    expect(footerLine(current, await readLiveness(fx.root, current, { now: at(60) }))).toBe(
      "ES · waiting on you: approve spec",
    )
  })
})

describe("formatAge", () => {
  test("seconds, minutes, hours, days", () => {
    expect(formatAge(12_000)).toBe("12s")
    expect(formatAge(4 * 60_000 + 5_000)).toBe("4m")
    expect(formatAge(3 * 3_600_000)).toBe("3h")
    expect(formatAge(50 * 3_600_000)).toBe("2d")
  })
})

describe("run index", () => {
  test("saves index the run; a stage change refreshes it at once, same-stage saves at most once a minute", async () => {
    const clock = { now: T0 }
    const factory = factoryAt(clock)
    const begun = await factory.begin("human:tester")
    const file = path.join(runsIndexDir(fx.state), `${begun.runId}.json`)
    const indexed = async () => JSON.parse(await readFile(file, "utf8"))
    expect(await indexed()).toMatchObject({ runId: begun.runId, root: fx.root, stage: "GRILL" })

    clock.now = at(10)
    await factory.writeFrontier("grill", frontier({ settled: false }))
    expect((await indexed()).updatedAt).toBe(T0.toISOString())
    clock.now = at(70)
    await factory.writeFrontier("grill", frontier({ settled: false }))
    expect((await indexed()).updatedAt).toBe(at(70).toISOString())
  })

  test("lists the newest first with the state's own stage, and skips runs their project no longer holds", async () => {
    const clock = { now: T0 }
    const begun = await factoryAt(clock).begin("human:tester")
    await indexRun(fx.state, {
      runId: "run-20261001-000000-dead",
      root: path.join(fx.root, "gone"),
      stage: "RESEARCH",
      createdAt: T0.toISOString(),
      updatedAt: at(500).toISOString(),
    })
    await indexRun(fx.state, { ...(await listRuns(fx.state))[0]!, stage: "SPEC" })
    const runs = await listRuns(fx.state)
    expect(runs.map((run) => run.runId)).toEqual([begun.runId])
    expect(runs[0]!.stage).toBe("GRILL")
  })

  test("ignores entries with an unsafe run id", async () => {
    await indexRun(fx.state, {
      runId: "../escape",
      root: fx.root,
      stage: "GRILL",
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    })
    expect(await exists(path.join(fx.state, "escape.json"))).toBe(false)
    expect(await listRuns(fx.state)).toEqual([])
  })
})
