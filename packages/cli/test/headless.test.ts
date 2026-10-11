// Headless fleet probes (#120): per-turn tool metrics carry duration and seat,
// and stay out of the default human output.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, type FactoryState, factoryLayout, gateRunner } from "@heretek-ai/es-core"
import {
  driveHeadless,
  type HarnessDriver,
  type HeadlessEvent,
  HeadlessJsonlSchema,
  headlessFinished,
  opencodeDriver,
  presentEvent,
  runHeadless,
  toJsonl,
} from "../src/headless.ts"

let root: string
let state: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-headless-"))
  state = await mkdtemp(path.join(tmpdir(), "es-headless-state-"))
  const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
  await factory.provisionRun("tester", 5)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

/** A scripted driver turn that reports tool timing and the acting seat. */
const toolDriver: HarnessDriver = {
  id: "fake",
  available: async () => true,
  async *turn() {
    yield {
      type: "tool_use",
      agent: "es-programmer",
      part: {
        tool: "read",
        state: { status: "completed", input: { path: "src/a.ts" }, time: { start: 1000, end: 1250 } },
      },
    }
    yield {
      type: "tool_use",
      agent: "es-programmer",
      part: {
        tool: "edit",
        state: { status: "error", input: {}, error: "nope", time: { start: 2000, end: 2750 } },
      },
    }
    yield {
      type: "tool_use",
      part: { tool: "shell", state: { status: "completed", input: { command: "echo hi" } } },
    }
    return "ses_fake"
  },
}

async function oneTurnMetrics(): Promise<HeadlessEvent[]> {
  const events: HeadlessEvent[] = []
  for await (const event of driveHeadless(
    { root, driver: toolDriver, maxTurns: 1, stallTurns: 99, stateDir: state },
    {
      agent: "factory",
      prompt: async () => "go",
      finished: async () => undefined,
      progress: async () => "p",
    },
  ))
    events.push(event)
  return events
}

describe("turn-metrics tool activity (#120)", () => {
  test("a scripted driver event stream produces tools with name, ok, ms and seat", async () => {
    const events = await oneTurnMetrics()
    const metrics = events.filter((event) => event.type === "turn-metrics")
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toEqual({
      type: "turn-metrics",
      turn: 1,
      costUSD: 0,
      tools: [
        { name: "read", ok: true, ms: 250, seat: "programmer" },
        { name: "edit", ok: false, ms: 750, seat: "programmer" },
        { name: "shell", ok: true },
      ],
    })
  })

  test("every turn-metrics payload validates, not just the envelope", async () => {
    const events = await oneTurnMetrics()
    const metrics = events.find((event) => event.type === "turn-metrics")!
    expect(HeadlessJsonlSchema.safeParse(toJsonl("run-1", metrics)).success).toBe(true)
    const missingOk = toJsonl("run-1", {
      type: "turn-metrics",
      turn: 1,
      costUSD: 0,
      tools: [{ name: "read" }],
    } as unknown as HeadlessEvent)
    expect(HeadlessJsonlSchema.safeParse(missingOk).success).toBe(false)
  })
})

describe("turn-metrics human output (#120)", () => {
  const metrics: HeadlessEvent = {
    type: "turn-metrics",
    turn: 1,
    costUSD: 0.04,
    tools: [{ name: "read", ok: true, ms: 250, seat: "programmer" }],
  }

  test("turn-metrics prints at debug only; info and quiet stay unchanged", () => {
    expect(presentEvent(metrics, "info")).toBeUndefined()
    expect(presentEvent(metrics, "quiet")).toBeUndefined()
    expect(presentEvent(metrics, "debug")).toEqual(metrics)
  })
})

describe("runHeadless end conditions (#247)", () => {
  test("a research run drives to done, and done carries no prUrl without a release", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-headless-done-"))
    const dirState = await mkdtemp(path.join(tmpdir(), "es-headless-done-state-"))
    try {
      const factory = new Factory(dir, { gates: gateRunner({ stateDir: dirState }), stateDir: dirState })
      await factory.beginResearchRun({ objective: "what queue", ceilingUSD: 5 })
      const seen: Array<{ agent: string; prompt: string }> = []
      const driver: HarnessDriver = {
        id: "fake",
        available: async () => true,
        async *turn(input) {
          seen.push({ agent: input.agent, prompt: input.prompt })
          yield { text: "working" }
          // The coordinator flow, played against the real tools and gate.
          const { researchTools } = await import("@heretek-ai/es-core")
          const stubFetch = (async () =>
            new Response("<p>Queues decouple workers from producers durably.</p>", {
              headers: { "content-type": "text/html" },
            })) as unknown as typeof fetch
          const tools = researchTools({
            root: dir,
            fetch: stubFetch,
            stateDir: dirState,
            policy: async () => ({ root: dir }),
          })
          const fetched = await tools
            .find((tool) => tool.name === "es_research_fetch")!
            .execute({ url: "https://192.0.2.1/queues" }, { agent: "es-research-alpha" })
          const sha = /sha256:([0-9a-f]{64})/.exec(fetched)?.[1]
          await writeFile(
            path.join(dir, ".factory/research/REPORT.md"),
            `# Report\n\n- Queues decouple workers [VERIFIED: sha256:${sha} "decouple workers from producers"]\n`,
          )
          await new Factory(dir, { gates: gateRunner({ stateDir: dirState }), stateDir: dirState }).completeResearch(
            "deep-researcher",
          )
          return "ses_fake"
        },
      }
      const events: HeadlessEvent[] = []
      for await (const event of runHeadless({ root: dir, driver, maxTurns: 5, stallTurns: 99, stateDir: dirState }))
        events.push(event)
      // The driver saw the factory seat identity and the headless prompt (#247.2).
      expect(seen).toHaveLength(1)
      expect(seen[0]?.agent).toBe("factory")
      expect(seen[0]?.prompt).toContain("headless run")
      expect(events[0]).toMatchObject({ type: "start", driver: "fake" })
      expect(events.filter((event) => event.type === "turn")).toHaveLength(1)
      const done = events.at(-1)!
      expect(done).toEqual({ type: "done" })
      expect("prUrl" in done).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(dirState, { recursive: true, force: true })
    }
  })

  test("headlessFinished maps DONE (with prUrl spread), pending approvals and the grill", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-headless-finished-"))
    try {
      const done = (release?: FactoryState["release"]) =>
        ({ stage: "DONE", ...(release ? { release } : {}) }) as unknown as FactoryState
      // No release: no prUrl key. With one: the url spreads onto done (#247.1).
      expect(await headlessFinished(dir, done())).toEqual({ type: "done" })
      expect(await headlessFinished(dir, done({ prUrl: "https://example.test/pr/9" }))).toEqual({
        type: "done",
        prUrl: "https://example.test/pr/9",
      })
      // A pending approval waits on a human, with its stages.
      await mkdir(path.dirname(factoryLayout(dir).pending), { recursive: true })
      await writeFile(factoryLayout(dir).pending, JSON.stringify([{ stage: "spec", requestedBy: "factory", at: "x" }]))
      expect(await headlessFinished(dir, { stage: "RESEARCH" } as unknown as FactoryState)).toEqual({
        type: "waiting",
        reason: "a human must approve (es approve <stage>)",
        stages: ["spec"],
      })
      await writeFile(factoryLayout(dir).pending, "[]")
      // The grill (no pending) waits on a human; a mid-build stage keeps driving.
      expect(await headlessFinished(dir, { stage: "GRILL" } as unknown as FactoryState)).toMatchObject({
        type: "waiting",
        reason: expect.stringContaining("grill"),
      })
      expect(await headlessFinished(dir, { stage: "RESEARCH" } as unknown as FactoryState)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a STOP file halts at headless level without granting anything", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-headless-stop-"))
    const dirState = await mkdtemp(path.join(tmpdir(), "es-headless-stop-state-"))
    try {
      await writeFile(path.join(dir, "README.md"), "# x\n")
      await new Factory(dir, { gates: gateRunner({ stateDir: dirState }), stateDir: dirState }).provisionRun(
        "tester",
        5,
      )
      await mkdir(path.dirname(factoryLayout(dir).stop), { recursive: true })
      await writeFile(factoryLayout(dir).stop, "lunch\n")
      const driver: HarnessDriver = {
        id: "fake",
        available: async () => true,
        async *turn() {
          yield { text: "unused" }
          return "ses_fake"
        },
      }
      const halted: HeadlessEvent[] = []
      for await (const event of runHeadless({ root: dir, driver, maxTurns: 3, stateDir: dirState })) halted.push(event)
      expect(halted[0]).toMatchObject({ type: "start" })
      expect(halted.at(-1)).toMatchObject({ type: "halted", reason: expect.stringContaining("STOP file") })
      expect(halted.some((event) => event.type === "turn")).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(dirState, { recursive: true, force: true })
    }
  })

  test("an unknown --driver is refused before anything launches", async () => {
    const { main } = await import("../src/main.ts")
    const printed: string[] = []
    const code = await main(["factory", "run", "--headless", "--driver", "nope"], {
      print: (text) => printed.push(text),
      confirm: { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" },
      cwd: root,
      stateDir: state,
    })
    expect(code).toBe(2)
    expect(printed.join("\n")).toContain("Unknown driver")
  })
})

describe("opencode driver argv shape (#247.2)", () => {
  test("run --standalone --format json --agent, with model/session/prompt passthrough", async () => {
    const { chmod } = await import("node:fs/promises")
    const bin = await mkdtemp(path.join(tmpdir(), "es-driver-argv-"))
    const previous = process.env.PATH
    try {
      await writeFile(
        path.join(bin, "opencode"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > "$ES_ARGV_LOG"\necho '{"type":"text","sessionID":"ses_argv","part":{"text":"hi"}}'\n`,
      )
      await chmod(path.join(bin, "opencode"), 0o755)
      process.env.PATH = `${bin}${path.delimiter}${previous}`
      const argvOf = async (input: Parameters<typeof opencodeDriver.turn>[0]): Promise<string[]> => {
        const log = path.join(bin, `argv-${Math.random().toString(36).slice(2)}.txt`)
        process.env.ES_ARGV_LOG = log
        try {
          const turn = opencodeDriver.turn(input)
          let step = await turn.next()
          while (!step.done) step = await turn.next()
          expect(step.value).toBe("ses_argv")
          return (await Bun.file(log).text()).split("\n").filter(Boolean)
        } finally {
          delete process.env.ES_ARGV_LOG
        }
      }
      expect(await argvOf({ root, agent: "factory", prompt: "go" })).toEqual([
        "run",
        "--standalone",
        "--format",
        "json",
        "--agent",
        "factory",
        "go",
      ])
      expect(await argvOf({ root, agent: "factory", prompt: "again", model: "prov/model", session: "ses_1" })).toEqual([
        "run",
        "--standalone",
        "--format",
        "json",
        "--agent",
        "factory",
        "--model",
        "prov/model",
        "--session",
        "ses_1",
        "again",
      ])
    } finally {
      process.env.PATH = previous
      await rm(bin, { recursive: true, force: true })
    }
  })
})
