// Headless fleet probes (#120): per-turn tool metrics carry duration and seat,
// and stay out of the default human output.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, gateRunner } from "@heretek-ai/es-core"
import {
  driveHeadless,
  type HarnessDriver,
  type HeadlessEvent,
  HeadlessJsonlSchema,
  presentEvent,
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
