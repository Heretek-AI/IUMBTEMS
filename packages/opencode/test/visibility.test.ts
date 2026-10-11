// Visibility proofs (#276): the plugin registers additively (built-in tools
// keep working; only invisible es_* tools are pruned), the status footer is
// server-computed content, and setup writes no project-tree files.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENTS, ensureEngineKey, footerLine, loadSkills, readLiveness } from "@heretek-ai/es-core"
import { compileAgents } from "../src/agents.ts"
import { createRpcHandlers } from "../src/rpc.ts"
import { createRuntime, parseOptions, type Runtime } from "../src/runtime.ts"
import { createSessionHooks } from "../src/session.ts"

let root: string
let state: string
let runtime: Runtime

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-visibility-"))
  state = await mkdtemp(path.join(tmpdir(), "es-visibility-state-"))
  runtime = await createRuntime(root, parseOptions({ stateDir: state }))
})

afterEach(async () => {
  await runtime.lsp.stopAll().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

describe("additive registration", () => {
  test("we only add registry agents (never built-ins or defaults)", async () => {
    const ids = new Set(AGENTS.map((agent) => agent.id))
    for (const compiled of await compileAgents(runtime.options, [])) expect(ids.has(compiled.spec.id)).toBe(true)
  })

  test("context prunes only invisible es_* tools; built-ins and state blocks are additive", async () => {
    const hooks = createSessionHooks(runtime)
    const tools = () => ({
      read: {},
      write: {},
      shell: {},
      question: {},
      es_status: {},
      es_gates_run: {},
      es_complete: {},
      es_build_start: {},
    })
    const user = { agent: "build", system: [] as unknown[], tools: tools() }
    await hooks.context(user as never)
    // Built-ins are untouched; only the read-only es tools stay visible.
    expect(Object.keys(user.tools).sort()).toEqual(["es_gates_run", "es_status", "question", "read", "shell", "write"])
    expect(user.system).toEqual([])

    const factory = { agent: "factory", system: [] as unknown[], tools: tools() }
    await hooks.context(factory as never)
    expect(Object.keys(factory.tools)).toContain("es_build_start")
    expect(factory.system).toHaveLength(1)
    expect((factory.system[0] as { text: string }).text).toContain("<factory-state>")
  })
})

describe("footer server-content wiring", () => {
  test("status().footer is footerLine(state, liveness, paused)", async () => {
    const handlers = createRpcHandlers(runtime, async () => {})
    const seen = await handlers.status()
    const state = await runtime.factory.read()
    const liveness = await readLiveness(root, state)
    expect(seen.footer ?? null).toBe(footerLine(state, liveness, undefined) ?? null)
    expect(seen.headline).toContain("No factory run")
  })
})

describe("setup writes no project-tree files (#276.1)", () => {
  test("runtime creation, engine key, agents and skills leave the project tree alone", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "es-setup-diff-"))
    const freshState = await mkdtemp(path.join(tmpdir(), "es-setup-diff-state-"))
    try {
      const before = await readdir(fresh)
      const staged = await createRuntime(fresh, parseOptions({ stateDir: freshState }))
      try {
        // The engine key seals cached sources: created at setup in the masked
        // state dir, never in the project tree.
        await ensureEngineKey(staged.stateDir)
        await compileAgents(staged.options, [])
        await loadSkills()
      } finally {
        await staged.lsp.stopAll().catch(() => undefined)
      }
      expect(await readdir(fresh)).toEqual(before)
    } finally {
      await rm(fresh, { recursive: true, force: true })
      await rm(freshState, { recursive: true, force: true })
    }
  })
})
