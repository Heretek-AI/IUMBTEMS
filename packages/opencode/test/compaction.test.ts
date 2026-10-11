// Compaction (#276.2): only factory seats get the factory-state block
// injected; any other agent compacts without it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRuntime, parseOptions, type Runtime } from "../src/runtime.ts"
import { createSessionHooks } from "../src/session.ts"

let root: string
let state: string
let runtime: Runtime

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-compaction-"))
  state = await mkdtemp(path.join(tmpdir(), "es-compaction-state-"))
  runtime = await createRuntime(root, parseOptions({ stateDir: state }))
})

afterEach(async () => {
  await runtime.lsp.stopAll().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

describe("compaction is factory-only", () => {
  test("a factory seat compacts with the verbatim state block", async () => {
    const hooks = createSessionHooks(runtime)
    const event = { agent: "factory", system: [] as unknown[] }
    await hooks.compaction(event as never)
    expect(event.system).toHaveLength(1)
    const text = (event.system[0] as { text: string }).text
    expect(text).toContain("Preserve this factory state verbatim")
    expect(text).toContain("<factory-state>")
  })

  test("a non-registry agent compacts without the state block", async () => {
    const hooks = createSessionHooks(runtime)
    for (const agent of ["build", "es-programmer", "grill"]) {
      const event = { agent, system: [] as unknown[] }
      await hooks.compaction(event as never)
      if (agent === "build") expect(event.system).toEqual([])
      else expect(event.system).toHaveLength(1)
    }
  })
})
