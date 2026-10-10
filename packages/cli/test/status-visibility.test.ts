// Live-run visibility on the real host (#199.2, bug #248): a testkit run
// paused at each headline state, `es status --json` matching the headline
// (incl. DONE-without-PR and SPEC/RELEASE), the OTHER_RUN window boundary,
// and a status/runs read-only pin. Headless progress emission stays covered
// by cli.test.ts and is not duplicated here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  Factory,
  type FactoryState,
  factoryLayout,
  gateRunner,
  type SeatRecord,
  signEngineFile,
  updateSeats,
  writeJson,
} from "@heretek-ai/es-core"
import { main } from "../src/main.ts"
import { otherRunHint } from "../src/status.ts"

const pipe = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" } as const

let h: import("../../testkit/src/host.ts").Harness
let hostState: string
let runId = ""

const factory = () => new Factory(h.directory, { gates: gateRunner({ stateDir: hostState }), stateDir: hostState })

async function runStatus(argv: string[] = ["status", "--json"]) {
  const printed: string[] = []
  const code = await main(argv, {
    print: (text) => printed.push(text),
    confirm: pipe as any,
    cwd: h.directory,
    stateDir: hostState,
  })
  return { code, out: printed.join("\n") }
}

async function sealState(patch: Partial<FactoryState>) {
  const current = (await factory().read())!
  const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() }
  await writeJson(factoryLayout(h.directory).state, next)
  await signEngineFile(factoryLayout(h.directory).state, hostState)
  return next
}

async function setSeats(seats: SeatRecord[]) {
  const id = (await factory().read())?.runId ?? runId
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
  const testkit = await import("../../testkit/src/host.ts")
  const script = await import("../../testkit/src/script.ts")
  hostState = await mkdtemp(path.join(tmpdir(), "es-vis-cli-"))
  h = await testkit.boot({
    git: true,
    script: script.directiveScript,
    plugins: [{ path: path.resolve(import.meta.dir, "../../opencode"), options: { stateDir: hostState, pr: "off" } }],
    files: { "README.md": "# visibility\n" },
  })
  const begun = await factory().begin("human:tester")
  runId = begun.runId
}, 60_000)

afterAll(async () => {
  await h?.close()
  await rm(hostState, { recursive: true, force: true })
})

describe("testkit run paused at each headline state: es status --json (#199.2)", () => {
  test("no-run says how to start one", async () => {
    const layout = factoryLayout(h.directory)
    const backup = await readFile(layout.state, "utf8").catch(() => undefined)
    await rm(layout.state).catch(() => undefined)
    await rm(`${layout.state}.sig`).catch(() => undefined)
    try {
      const result = await runStatus()
      expect(result.code).toBe(0)
      expect(JSON.parse(result.out).headline).toBe("No factory run in this project. Start one with /grill.")
    } finally {
      if (backup !== undefined) {
        await writeFile(layout.state, backup)
        await signEngineFile(layout.state, hostState)
      } else {
        const begun = await factory()
          .begin("human:tester")
          .catch(() => undefined)
        if (begun) runId = begun.runId
      }
    }
  }, 30_000)

  test("grill headline", async () => {
    await sealState({ stage: "GRILL", halt: undefined, release: undefined })
    await setSeats([])
    await setPending([])
    const parsed = JSON.parse((await runStatus()).out)
    expect(parsed.liveness.stage).toBe("GRILL")
    expect(parsed.headline).toBe("The grill is running: answer its questions in the grill session.")
  }, 30_000)

  test("halted headline", async () => {
    const now = new Date().toISOString()
    await sealState({ stage: "HALTED", halt: { reason: "STOP file: test", at: now, from: "BUILD" } })
    await setSeats([])
    await setPending([])
    expect(JSON.parse((await runStatus()).out).headline).toContain("Halted: STOP file: test. A human must resume")
  }, 30_000)

  test("done with a PR", async () => {
    const now = new Date().toISOString()
    await sealState({ stage: "DONE", halt: undefined, release: { prUrl: "https://example.test/pr/1", at: now } })
    await setSeats([])
    await setPending([])
    expect(JSON.parse((await runStatus()).out).headline).toBe(
      "Done: the pull request is open at https://example.test/pr/1.",
    )
  }, 30_000)

  test("done without a PR (research runs end without one, #248.5)", async () => {
    await sealState({ stage: "DONE", halt: undefined, release: undefined, mode: "research" })
    await setSeats([])
    await setPending([])
    expect(JSON.parse((await runStatus()).out).headline).toBe("Done: the run is complete.")
  }, 30_000)

  test("pending headline beats the stage", async () => {
    await sealState({ stage: "RESEARCH", halt: undefined, release: undefined, mode: "build" })
    await setSeats([])
    await setPending([{ stage: "spec", requestedBy: "agent:factory", at: new Date().toISOString() }])
    const parsed = JSON.parse((await runStatus()).out)
    expect(parsed.headline).toContain("Waiting for you: approve the spec")
    expect(parsed.headline).toContain("es approve spec")
    await setPending([])
  }, 30_000)

  test("running headline names the seat, tool and age", async () => {
    await sealState({ stage: "RESEARCH", halt: undefined, release: undefined, mode: "build" })
    await setPending([])
    await setSeats([mkSeat({ lastActivityAt: new Date().toISOString(), lastTool: "es_research_fetch" })])
    const parsed = JSON.parse((await runStatus()).out)
    expect(parsed.headline).toContain("Research is running: es-research-alpha last ran es_research_fetch")
    expect(parsed.headline).toMatch(/\d+s ago/)
  }, 30_000)

  test("idle headline when no seat runs", async () => {
    await sealState({ stage: "RESEARCH", halt: undefined, release: undefined, mode: "build" })
    await setPending([])
    await setSeats([])
    expect(JSON.parse((await runStatus()).out).headline).toContain(
      "Research in progress: no seat is running; last activity",
    )
  }, 30_000)

  test("stuck headline after ten quiet minutes", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString()
    // The audit log's begin entry is fresh (real clock): drop it so the
    // quiet window is really quiet (liveness takes the newest timestamp).
    await rm(factoryLayout(h.directory).audit, { force: true })
    await sealState({ stage: "RESEARCH", halt: undefined, release: undefined, mode: "build", updatedAt: old })
    await setPending([])
    await setSeats([mkSeat({ lastActivityAt: old })])
    const parsed = JSON.parse((await runStatus()).out)
    expect(parsed.headline).toContain("It may be stuck")
    expect(parsed.headline).toContain("No activity for 20m in RESEARCH")
    expect(parsed.headline).toContain(".factory/STOP")
  }, 30_000)

  test("SPEC wording (#248.5)", async () => {
    await sealState({ stage: "SPEC", halt: undefined, release: undefined, mode: "build" })
    await setPending([])
    await setSeats([mkSeat({ agent: "es-manager", lastActivityAt: new Date().toISOString(), lastTool: "edit" })])
    expect(JSON.parse((await runStatus()).out).headline).toStartWith("Spec writing is running:")
  }, 30_000)

  test("RELEASE wording (#248.5)", async () => {
    await sealState({ stage: "RELEASE", halt: undefined, release: undefined, mode: "build" })
    await setPending([])
    await setSeats([mkSeat({ agent: "factory", lastActivityAt: new Date().toISOString() })])
    expect(JSON.parse((await runStatus()).out).headline).toStartWith("Release is running:")
  }, 30_000)

  test("human text leads with the headline, then the run header (indexOf)", async () => {
    await sealState({ stage: "GRILL", halt: undefined, release: undefined })
    await setSeats([])
    await setPending([])
    const printed: string[] = []
    await main(["status"], {
      print: (text) => printed.push(text),
      confirm: pipe as any,
      cwd: h.directory,
      stateDir: hostState,
    })
    const text = printed.join("\n")
    const head = "The grill is running: answer its questions in the grill session."
    const header = `run ${runId} · GRILL · ${h.directory}`
    expect(text.indexOf(head)).toBe(0)
    expect(text.indexOf(header)).toBeGreaterThan(text.indexOf(head))
  }, 30_000)
})

describe("OTHER_RUN window boundary, DONE and equal-timestamp edges (#248.1)", () => {
  const now = new Date("2026-10-08T02:00:00.000Z")
  const agoMs = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const here = { root: "/work/here", state: undefined as FactoryState | undefined }

  test("a fresh non-DONE run elsewhere counts; DONE never does", () => {
    expect(
      otherRunHint(
        [{ runId: "run-1", root: "/work/else", stage: "GRILL", createdAt: agoMs(60_000), updatedAt: agoMs(60_000) }],
        here,
        now,
      ),
    ).toContain("A run is active elsewhere")
    expect(
      otherRunHint(
        [{ runId: "run-1", root: "/work/else", stage: "DONE", createdAt: agoMs(1_000), updatedAt: agoMs(1_000) }],
        here,
        now,
      ),
    ).toBeUndefined()
  })

  test("the ten-minute window is strict: just inside counts, at/over it does not", () => {
    const inside = agoMs(10 * 60_000 - 1_000)
    const at = agoMs(10 * 60_000)
    const over = agoMs(10 * 60_000 + 1_000)
    const entry = (updatedAt: string) => ({
      runId: "run-1",
      root: "/work/else",
      stage: "GRILL" as const,
      createdAt: updatedAt,
      updatedAt,
    })
    expect(otherRunHint([entry(inside)], here, now)).toBeDefined()
    expect(otherRunHint([entry(at)], here, now)).toBeUndefined()
    expect(otherRunHint([entry(over)], here, now)).toBeUndefined()
  })

  test("an equal timestamp is not more recent: no hint", () => {
    const stamp = agoMs(60_000)
    const hereState = {
      version: 2 as const,
      runId: "run-here",
      stage: "GRILL" as const,
      mode: "build" as const,
      createdAt: stamp,
      updatedAt: stamp,
      spend: { usd: 0, estimated: false, events: 0 },
      phases: [],
      audits: [],
    }
    expect(
      otherRunHint(
        [{ runId: "run-1", root: "/work/else", stage: "GRILL", createdAt: stamp, updatedAt: stamp }],
        { root: "/work/here", state: hereState },
        now,
      ),
    ).toBeUndefined()
  })
})

describe("status/runs write nothing (snapshot-diff read-only pin, #248.4)", () => {
  async function snapshot(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const walk = async (dir: string) => {
      const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
      for (const entry of entries) {
        const file = path.join(dir, entry as string)
        const info = await stat(file).catch(() => undefined)
        if (!info?.isFile()) continue
        out.set(file, `${info.size}:${info.mtimeMs}:${await readFile(file, "utf8").catch(() => "")}`)
      }
    }
    await walk(factoryLayout(h.directory).dir)
    await walk(hostState)
    return out
  }

  test("status, status --json, runs, runs --all and runs --json leave the tree untouched", async () => {
    await sealState({ stage: "GRILL", halt: undefined, release: undefined })
    await setSeats([])
    await setPending([])
    const before = await snapshot()
    for (const argv of [["status"], ["status", "--json"], ["runs"], ["runs", "--all"], ["runs", "--json"]]) {
      const result = await runStatus(argv)
      expect(result.code).toBe(0)
    }
    const after = await snapshot()
    expect([...after.entries()]).toEqual([...before.entries()])
  }, 30_000)
})
