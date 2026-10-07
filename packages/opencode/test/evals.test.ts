// The eval runner against the real opencode CLI and a scripted fake model: the
// isolated workspace loads this plugin, the run is graded from its event
// stream, and the step cap kills a run that keeps going. Skipped when the
// opencode CLI is not installed (the nightly evals job installs it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { accessSync, constants } from "node:fs"
import path from "node:path"
import { evalWorkspace, runEvalCase } from "@heretek-ai/es-core"
import { directiveScript, type FakeLLM, startFakeLLM } from "@heretek-ai/es-testkit"

const binary = (process.env.PATH ?? "")
  .split(path.delimiter)
  .map((dir) => path.join(dir, "opencode"))
  .find((file) => {
    try {
      accessSync(file, constants.X_OK)
      return true
    } catch {
      return false
    }
  })

const pluginDir = path.resolve(import.meta.dir, "..")
let llm: FakeLLM
beforeAll(() => {
  llm = startFakeLLM()
})
afterAll(() => llm?.stop())

// `cost` prices the fake model in USD per million tokens, so its turns report spend.
const workspace = (cost?: { input: number; output: number }) =>
  evalWorkspace({
    pluginDir,
    model: "fake/scripted",
    providers: {
      fake: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: llm.url, apiKey: "test" },
        models: { scripted: { limit: { context: 100000, output: 4000 }, ...(cost ? { cost } : {}) } },
      },
    },
  })

describe.skipIf(!binary)("the eval runner on the real opencode CLI", () => {
  test("a case runs in an isolated workspace with this plugin and is graded from its events", async () => {
    llm.setScript(() => ({ text: "First question: which weather API do you want to use?" }))
    const before = llm.requests.length
    const ws = await workspace()
    try {
      const result = await runEvalCase(
        {
          id: "grill",
          description: "asks first",
          agent: "grill",
          prompt: "Grill me on a weather CLI.",
          checks: { contains: ["?"], toolsNotUsed: ["es_frontier_write"] },
        },
        ws,
        { binary: binary!, maxSteps: 4, timeoutMs: 60_000 },
      )
      expect(result.failures).toEqual([])
      expect(result.pass).toBe(true)
      // The fake model answered, so the workspace (not this repo's config) was used.
      expect(llm.requests.length).toBeGreaterThan(before)
    } finally {
      await ws.cleanup()
    }
  }, 90_000)

  test("the step cap kills a run that keeps calling tools", async () => {
    llm.setScript(() => ({ toolCalls: [{ name: "es_status", args: {} }] }))
    const ws = await workspace()
    try {
      const result = await runEvalCase(
        { id: "loop", description: "never stops", agent: "factory", prompt: "Status?" },
        ws,
        { binary: binary!, maxSteps: 2, timeoutMs: 60_000 },
      )
      expect(result.capped).toBe(true)
      expect(result.pass).toBe(false)
      expect(result.failures[0]).toBe("step cap reached (2)")
    } finally {
      await ws.cleanup()
    }
  }, 90_000)

  test("parallel calls in one model turn are one step", async () => {
    llm.setScript(directiveScript)
    const ws = await workspace()
    try {
      const result = await runEvalCase(
        {
          id: "parallel",
          description: "two calls, one turn",
          agent: "factory",
          // Empty args: quotes in a CLI prompt reach the model escaped.
          prompt: "@@PARALLEL@@ @@CALL es_status {}@@ @@CALL es_status {}@@",
          checks: { toolsUsed: ["es_status"] },
        },
        ws,
        { binary: binary!, maxSteps: 2, timeoutMs: 60_000 },
      )
      expect(result.failures).toEqual([])
      expect(result.transcript.tools).toEqual(["es_status", "es_status"])
      expect(result.transcript.steps).toBe(2)
    } finally {
      await ws.cleanup()
    }
  }, 90_000)

  test("a refused tool call does not satisfy toolsUsed", async () => {
    llm.setScript(directiveScript)
    const ws = await workspace()
    try {
      // No run exists, so the factory's build start is refused.
      const result = await runEvalCase(
        {
          id: "refused",
          description: "the call errors",
          agent: "factory",
          prompt: "@@CALL es_build_start {}@@",
          checks: { toolsUsed: ["es_build_start"] },
        },
        ws,
        { binary: binary!, maxSteps: 4, timeoutMs: 60_000 },
      )
      expect(result.transcript.tools).toEqual(["es_build_start"])
      expect(result.transcript.completed).toEqual([])
      expect(result.failures).toContain("called but did not complete: es_build_start")
    } finally {
      await ws.cleanup()
    }
  }, 90_000)

  test("a priced model's spend is read from step_finish and the budget kills the run", async () => {
    llm.setScript(() => ({ toolCalls: [{ name: "es_status", args: {} }], usage: { input: 10, output: 0 } }))
    // $100k per million input tokens: 10 input tokens cost $1 per step.
    const ws = await workspace({ input: 100_000, output: 0 })
    try {
      const result = await runEvalCase(
        { id: "spend", description: "keeps spending", agent: "factory", prompt: "Status?" },
        ws,
        { binary: binary!, maxSteps: 10, timeoutMs: 60_000, budgetUSD: 1.5 },
      )
      expect(result.overBudget).toBe(true)
      expect(result.capped).toBe(false)
      expect(result.transcript.costUSD).toBeGreaterThan(1.5)
      expect(result.failures[0]).toStartWith("spend budget reached")
    } finally {
      await ws.cleanup()
    }
  }, 90_000)
})
