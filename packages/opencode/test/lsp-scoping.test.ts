// After-edit diagnostics scoping (#277.2): the `<diagnostics>` injection is a
// language-server channel, so seats with `lsp: "none"` (harvester, designer,
// scout, brainstormer, …) must not receive it; seats that may navigate (and
// the user's own agents) keep it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPolicyHooks } from "../src/policy.ts"
import type { Runtime } from "../src/runtime.ts"

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-lsp-scope-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const diagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 1,
  message: "boom",
}

const runtime = (root: string) =>
  ({
    root,
    options: { lspAfterEdit: true, afterEdit: "off" },
    lsp: { diagnostics: async () => [diagnostic] },
    policy: async () => ({ root }),
  }) as unknown as Runtime

const edited = (agent: string) => ({
  tool: "write",
  agent,
  id: "1",
  input: { path: "src/a.ts" },
  status: "completed",
  result: {},
})

describe("after-edit diagnostics respect lsp scoping", () => {
  test("an lsp:none seat (harvester) gets no diagnostics channel", async () => {
    const { after } = createPolicyHooks(runtime(root))
    const event = edited("harvester")
    await after(event as never)
    expect(event.result).toEqual({})
  })

  test("a navigating seat (QA) and the user's own agent keep the injection", async () => {
    const { after } = createPolicyHooks(runtime(root))
    const qa = edited("es-qa-functional")
    await after(qa as never)
    expect(JSON.stringify((qa.result as { content: unknown }).content)).toContain("<diagnostics>")
    const user = edited("build")
    await after(user as never)
    expect(JSON.stringify((user.result as { content: unknown }).content)).toContain("<diagnostics>")
  })
})
