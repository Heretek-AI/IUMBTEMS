// The eval runner against the testkit host as a fake `opencode` (issue
// #209): a real in-process OpenCode v2 host proves the plugin's es_status
// tool runs, then the eval runner (runEvalCase) runs against a fake `opencode`
// binary whose event stream replays that real tool outcome in a loop. The
// harness — not the model — enforces both caps: the step cap kills a run that
// keeps calling tools (even at $0 spend), and the spend cap kills once
// `step_finish` cost passes the budget.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { evalWorkspace, runEvalCase } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

let h: Harness
let state: string
let statusText: string

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-evals-host-state-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# evals caps\n" },
  })
  // A real tool call on the real host: the fake `opencode` below replays this
  // outcome, so its event stream is what this plugin really returns.
  const probed = await h.run(`probe ${call("es_status", {})}`)
  expect(probed.tools[0]?.status).toBe("completed")
  statusText = probed.tools[0]?.text ?? "no status"
  expect(statusText.length).toBeGreaterThan(0)
}, 120_000)

afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

/** A fake `opencode` binary: emits `steps` JSON events replaying the host's real tool outcome. */
async function fakeOpencode(options: { steps: number; costPerStep: number }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "es-fake-opencode-"))
  const file = path.join(dir, "opencode")
  // The script keeps going for `steps` turns (like a model that never stops);
  // the harness must kill it at its cap. Cost rides on step_finish, exactly
  // as a priced model reports it (0 for an unpriced model).
  const body = `#!/usr/bin/env bun
const output = ${JSON.stringify(statusText)};
const steps = ${options.steps};
const cost = ${options.costPerStep};
for (let i = 0; i < steps; i++) {
  console.log(JSON.stringify({ type: "step_start", part: {} }));
  console.log(JSON.stringify({ type: "tool_use", part: { tool: "es_status", state: { status: "completed", output } } }));
  console.log(JSON.stringify({ type: "step_finish", part: { cost, tokens: { input: 10, output: 5 } } }));
}
`
  await writeFile(file, body, { mode: 0o755 })
  await chmod(file, 0o755)
  return file
}

const workspace = () =>
  evalWorkspace({
    pluginDir,
    model: "fake/scripted",
    providers: {
      fake: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: h.llm.url, apiKey: "test" },
        models: { scripted: { limit: { context: 100000, output: 4000 } } },
      },
    },
  })

describe("the eval runner against the testkit host as a fake opencode (#209)", () => {
  test("the step cap kills a run that keeps calling tools", async () => {
    const binary = await fakeOpencode({ steps: 6, costPerStep: 0 })
    const ws = await workspace()
    try {
      const result = await runEvalCase(
        { id: "loop", description: "never stops", agent: "factory", prompt: "Status?" },
        ws,
        { binary, maxSteps: 2, timeoutMs: 15_000 },
      )
      expect(result.capped).toBe(true)
      expect(result.overBudget).toBe(false)
      expect(result.pass).toBe(false)
      expect(result.failures[0]).toBe("step cap reached (2)")
      // The harness saw the whole loop the model wanted: steps and the real
      // host tool outcome are in the transcript as evidence.
      expect(result.transcript.steps).toBe(6)
      expect(result.transcript.tools).toEqual([
        "es_status",
        "es_status",
        "es_status",
        "es_status",
        "es_status",
        "es_status",
      ])
      expect(result.transcript.completed).toEqual(result.transcript.tools)
      expect(result.transcript.costUSD).toBe(0)
    } finally {
      await ws.cleanup()
      await rm(path.dirname(binary), { recursive: true, force: true })
    }
  }, 30_000)

  test("the spend cap kills once step_finish cost passes the budget", async () => {
    const binary = await fakeOpencode({ steps: 3, costPerStep: 1 })
    const ws = await workspace()
    try {
      const result = await runEvalCase(
        { id: "spend", description: "keeps spending", agent: "factory", prompt: "Status?" },
        ws,
        { binary, maxSteps: 10, timeoutMs: 15_000, budgetUSD: 1.5 },
      )
      expect(result.overBudget).toBe(true)
      expect(result.capped).toBe(false)
      expect(result.pass).toBe(false)
      expect(result.failures[0]).toStartWith("spend budget reached")
      expect(result.transcript.costUSD).toBeGreaterThan(1.5)
      expect(result.transcript.costUSD).toBe(3)
      expect(result.transcript.steps).toBe(3)
    } finally {
      await ws.cleanup()
      await rm(path.dirname(binary), { recursive: true, force: true })
    }
  }, 30_000)

  test("a $0-priced model is still step-bounded (caps are the harness, not the model)", async () => {
    const binary = await fakeOpencode({ steps: 6, costPerStep: 0 })
    const ws = await workspace()
    try {
      const result = await runEvalCase(
        { id: "free-loop", description: "free but never stops", agent: "factory", prompt: "Status?" },
        ws,
        { binary, maxSteps: 2, timeoutMs: 15_000, budgetUSD: 1.5 },
      )
      expect(result.capped).toBe(true)
      expect(result.overBudget).toBe(false)
      expect(result.pass).toBe(false)
      expect(result.failures[0]).toBe("step cap reached (2)")
      expect(result.transcript.costUSD).toBe(0)
    } finally {
      await ws.cleanup()
      await rm(path.dirname(binary), { recursive: true, force: true })
    }
  }, 30_000)
})
