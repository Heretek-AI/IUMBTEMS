// Factory continuation (1.1.3, #60): re-prompts the factory after an idle
// turn, never while one of its seats is still running, and announces a pause
// after three turns without progress instead of going silent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FactoryState } from "@heretek-ai/es-core"
import { createFactoryContinuation, STALL_LIMIT } from "../src/continue.ts"

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-continue-"))
})
afterAll(() => rm(root, { recursive: true, force: true }))

const research = (overrides: Partial<FactoryState> = {}): FactoryState => ({
  version: 2,
  runId: "run-20261008-020000-ab12",
  stage: "RESEARCH",
  createdAt: new Date().toISOString(),
  // Fresh, so the headline reads "in progress" rather than "may be stuck".
  updatedAt: new Date().toISOString(),
  spend: { usd: 1, estimated: true, events: 1 },
  phases: [],
  audits: [],
  ...overrides,
})

function setup(options: { running?: boolean } = {}) {
  let state = research()
  const prompts: string[] = []
  const pauses: string[] = []
  const runtime = {
    root,
    factory: {
      read: async () => state,
      summary: async () => "<factory-state>\nrun x · stage RESEARCH\n</factory-state>",
    },
  }
  const continuation = createFactoryContinuation(
    { session: { prompt: async (input: { text: string }) => prompts.push(input.text) } },
    runtime as any,
    { seats: { hasRunningChildren: () => options.running === true }, onPause: (notice) => pauses.push(notice) },
  )
  const agentOf = async (sessionID: string) => (sessionID === "ses_factory" ? "factory" : "es-research-alpha")
  const fire = (type: string, sessionID = "ses_factory") => continuation({ type, data: { sessionID } }, agentOf)
  return {
    continuation,
    prompts,
    pauses,
    fire,
    set: (next: FactoryState) => {
      state = next
    },
  }
}

describe("factory continuation", () => {
  test("re-prompts with the headline, then pauses after three idle turns and says so once", async () => {
    const run = setup()
    for (let i = 0; i < STALL_LIMIT; i++) await run.fire("session.execution.succeeded")
    expect(run.prompts).toHaveLength(STALL_LIMIT)
    expect(run.prompts[0]).toContain("Research in progress: no seat is running")
    expect(run.prompts[0]).toContain("The factory run is not finished")
    await run.fire("session.execution.succeeded")
    await run.fire("session.execution.succeeded")
    expect(run.prompts).toHaveLength(STALL_LIMIT)
    expect(run.pauses).toEqual([
      "Factory paused: 3 turns in RESEARCH without progress. Check es status, then run /factory to continue.",
    ])
    expect(run.continuation.paused()).toBe(run.pauses[0])
  })

  test("a restarted factory clears the pause and gets a fresh budget; progress resets the count", async () => {
    const run = setup()
    for (let i = 0; i <= STALL_LIMIT; i++) await run.fire("session.execution.succeeded")
    expect(run.continuation.paused()).toBeDefined()
    await run.fire("session.execution.started")
    expect(run.continuation.paused()).toBeUndefined()
    await run.fire("session.execution.succeeded")
    expect(run.prompts).toHaveLength(STALL_LIMIT + 1)

    run.set(research({ stage: "SPEC" }))
    await run.fire("session.execution.succeeded")
    expect(run.prompts).toHaveLength(STALL_LIMIT + 2)
  })

  test("never re-prompts while a seat of that session is running, and ignores other sessions", async () => {
    const running = setup({ running: true })
    await running.fire("session.execution.succeeded")
    expect(running.prompts).toEqual([])
    const idle = setup()
    await idle.fire("session.execution.succeeded", "ses_seat")
    expect(idle.prompts).toEqual([])
  })
})
