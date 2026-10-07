// The eval runner against the real opencode CLI and a scripted fake model: the
// isolated workspace loads this plugin, the run is graded from its event
// stream, and the step cap kills a run that keeps going. Skipped when the
// opencode CLI is not installed (the nightly evals job installs it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { accessSync, constants } from "node:fs"
import path from "node:path"
import { evalWorkspace, runEvalCase } from "@heretek-ai/es-core"
import { type FakeLLM, startFakeLLM } from "@heretek-ai/es-testkit"

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

const workspace = () =>
  evalWorkspace({
    pluginDir,
    model: "fake/scripted",
    providers: {
      fake: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: llm.url, apiKey: "test" },
        models: { scripted: { limit: { context: 100000, output: 4000 } } },
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
})
