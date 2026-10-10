// Live-run visibility proof-gap closers (#199, bug #248): literal pins,
// SPEC/RELEASE + DONE-without-PR wording, research absence, headline-first
// ordering, explicit runs/watch allows, and one real-host check.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { formatHuman, headline, readLiveness, researchLine, STALE_AFTER_MS } from "../src/factory/liveness.ts"
import { type SeatRecord, updateSeats } from "../src/factory/seats.ts"
import type { FactoryState } from "../src/factory/state.ts"
import { evaluateShell } from "../src/trust/policy.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

let fx: Fixture
beforeAll(async () => {
  fx = await gitRepo("es-visibility-")
})
afterAll(() => fx.cleanup())

const T0 = new Date("2026-10-08T02:00:00.000Z")
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

const state = (overrides: Partial<FactoryState> = {}): FactoryState => ({
  version: 2,
  runId: "run-20261008-020000-ab12",
  stage: "RESEARCH",
  mode: "build",
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

describe("literal threshold pin (#248.1)", () => {
  test("STALE_AFTER_MS is ten minutes", () => {
    expect(STALE_AFTER_MS).toBe(10 * 60_000)
    expect(STALE_AFTER_MS).toBe(600_000)
  })

  test("stuck boundary: just under is running, at the threshold is stuck", async () => {
    const current = state()
    await updateSeats(fx.root, current.runId, (seats) => {
      seats.push(seat({ lastActivityAt: T0.toISOString() }))
    })
    const justUnder = await readLiveness(fx.root, current, {
      now: new Date(T0.getTime() + STALE_AFTER_MS - 1_000),
    })
    expect(headline(current, justUnder)).toContain("is running")
    expect(headline(current, justUnder)).not.toContain("may be stuck")

    const atThreshold = await readLiveness(fx.root, current, {
      now: new Date(T0.getTime() + STALE_AFTER_MS),
    })
    expect(headline(current, atThreshold)).toContain("may be stuck")
    expect(headline(current, atThreshold)).toContain("No activity for 10m")

    const over = await readLiveness(fx.root, current, {
      now: new Date(T0.getTime() + STALE_AFTER_MS + 1_000),
    })
    expect(headline(current, over)).toContain("may be stuck")
  })
})

describe("uncovered branches: SPEC/RELEASE wording and DONE-without-PR (#248.5)", () => {
  test("SPEC running vs idle wording", async () => {
    const running = state({ stage: "SPEC", updatedAt: at(50).toISOString() })
    await updateSeats(fx.root, running.runId, (seats) => {
      seats.push(
        seat({
          agent: "es-manager",
          lastActivityAt: at(55).toISOString(),
          lastTool: "edit",
        }),
      )
    })
    const live = await readLiveness(fx.root, running, { now: at(60) })
    expect(headline(running, live)).toStartWith("Spec writing is running:")
    expect(headline(running, live)).toContain("es-manager last ran edit 5s ago")

    const idle = state({ stage: "SPEC", updatedAt: at(20).toISOString() })
    // A different runId reads as empty seats (scoped), so idle.
    const idleLive = await readLiveness(fx.root, { ...idle, runId: "run-20261008-020000-zz99" }, { now: at(60) })
    expect(headline({ ...idle, runId: "run-20261008-020000-zz99" }, idleLive)).toBe(
      "Spec writing in progress: no seat is running; last activity 40s ago.",
    )
  })

  test("RELEASE running vs idle wording", async () => {
    const running = state({ stage: "RELEASE", updatedAt: at(50).toISOString() })
    await updateSeats(fx.root, running.runId, (seats) => {
      seats.push(seat({ agent: "factory", lastActivityAt: at(58).toISOString() }))
    })
    const live = await readLiveness(fx.root, running, { now: at(60) })
    expect(headline(running, live)).toStartWith("Release is running:")

    const idle = state({ stage: "RELEASE", updatedAt: at(20).toISOString(), runId: "run-20261008-020000-rr11" })
    const idleLive = await readLiveness(fx.root, idle, { now: at(60) })
    expect(headline(idle, idleLive)).toBe("Release in progress: no seat is running; last activity 40s ago.")
  })

  test("DONE without a PR says the run is complete (research runs end without one)", async () => {
    const doneBare = state({ stage: "DONE" })
    expect(headline(doneBare, await readLiveness(fx.root, doneBare, { now: T0 }))).toBe("Done: the run is complete.")
    const donePr = state({
      stage: "DONE",
      release: { prUrl: "https://example.test/pr/1", at: T0.toISOString() },
    })
    expect(headline(donePr, await readLiveness(fx.root, donePr, { now: T0 }))).toBe(
      "Done: the pull request is open at https://example.test/pr/1.",
    )
  })
})

describe("research absence: non-RESEARCH stages expose no research line (#248.3)", () => {
  for (const stage of ["GRILL", "SPEC", "BUILD", "QA", "RELEASE", "DONE", "HALTED"] as const) {
    test(`${stage} has no research line in liveness or human text`, async () => {
      const current = state({
        stage,
        ...(stage === "HALTED" ? { halt: { reason: "x", at: T0.toISOString(), from: "BUILD" as const } } : {}),
        ...(stage === "DONE" ? { release: { prUrl: "https://example.test/pr/1", at: T0.toISOString() } } : {}),
      })
      const live = await readLiveness(fx.root, current, { now: T0 })
      expect(researchLine(live)).toBeUndefined()
      expect(live.research).toBeUndefined()
      const text = formatHuman(current, live, "<factory-state>\nrun x · stage X\n</factory-state>")
      expect(text).not.toContain("research:")
    })
  }

  test("RESEARCH keeps its research line (0 sources, coverage not checked)", async () => {
    const current = state({ stage: "RESEARCH" })
    const live = await readLiveness(fx.root, current, { now: T0 })
    expect(researchLine(live)).toContain("0 sources")
    expect(formatHuman(current, live, "<factory-state>\nrun x\n</factory-state>")).toContain("research:")
  })
})

describe("dashboard headline-first ordering (indexOf, not containment) (#248.2)", () => {
  test("formatHuman leads with the headline, then the run header", async () => {
    const current = state({ updatedAt: at(20).toISOString() })
    await updateSeats(fx.root, current.runId, (seats) => {
      seats.push(seat({ lastActivityAt: at(50).toISOString(), lastTool: "es_research_fetch" }))
    })
    const live = await readLiveness(fx.root, current, { now: at(60) })
    const summary = "<factory-state>\nrun run-20261008-020000-ab12 · stage RESEARCH\n</factory-state>"
    const text = formatHuman(current, live, summary)
    const head = headline(current, live)
    const header = `run ${current.runId} · RESEARCH · ${fx.root} · updated 40s ago`
    expect(text.indexOf(head)).toBe(0)
    expect(text.indexOf(header)).toBeGreaterThan(text.indexOf(head))
    expect(text.indexOf("seats:")).toBeGreaterThan(text.indexOf(header))
    // The research line trails the seats, never leads.
    expect(text.indexOf("research:")).toBeGreaterThan(text.indexOf("seats:"))
  })
})

describe("explicit runs/watch allows (#248.6)", () => {
  const ctx = () => ({ root: fx.root, stateDir: fx.state })
  test("es status, es runs and es watch are reads for every agent", () => {
    for (const command of [
      "es status",
      "es status --json",
      "es --cwd . status",
      "es --run r1 status",
      "es runs",
      "es runs --all",
      "es runs --json",
      "es --cwd . runs --all",
      "es watch",
      "es watch --interval 2",
      "es factory status",
      "es --cwd . factory status",
    ])
      for (const agent of [undefined, "build", "factory", "es-programmer", "es-research-alpha"]) {
        const decision = evaluateShell(ctx(), agent, command, { sandboxAvailable: true })
        expect([command, agent, decision.effect]).toEqual([command, agent, "allow"])
      }
  })

  test("neighbouring human-only verbs stay denied (the allows are specific)", () => {
    for (const command of [
      "es factory run --headless",
      "es factory resume",
      "es approve frontier",
      "es research deep 'q' --output /tmp/r --max-usd 5",
    ])
      expect([command, evaluateShell(ctx(), "build", command, { sandboxAvailable: true }).effect]).toEqual([
        command,
        "deny",
      ])
  })
})

describe("real-host liveness (#199.2)", () => {
  let h: import("../../testkit/src/host.ts").Harness
  let hostState: string
  beforeAll(async () => {
    const testkit = await import("../../testkit/src/host.ts")
    const script = await import("../../testkit/src/script.ts")
    hostState = await mkdtemp(path.join(tmpdir(), "es-vis-core-"))
    h = await testkit.boot({
      git: true,
      script: script.directiveScript,
      plugins: [{ path: path.resolve(import.meta.dir, "../../opencode"), options: { stateDir: hostState, pr: "off" } }],
      files: { "README.md": "# visibility\n" },
    })
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(hostState, { recursive: true, force: true })
  })

  test("a testkit run's GRILL headline reads through core liveness", async () => {
    const { Factory } = await import("../src/factory/machine.ts")
    const { gateRunner } = await import("../src/gates/engine.ts")
    const factory = new Factory(h.directory, { gates: gateRunner({ stateDir: hostState }), stateDir: hostState })
    const begun = await factory.begin("human:tester")
    expect(begun.stage).toBe("GRILL")
    const { readLiveness: read, headline: head, formatHuman: human } = await import("../src/factory/liveness.ts")
    const current = await factory.read()
    const live = await read(h.directory, current)
    expect(head(current, live)).toBe("The grill is running: answer its questions in the grill session.")
    const text = human(current, live, await factory.summary(current))
    expect(text.indexOf(head(current, live))).toBe(0)
  }, 60_000)
})
