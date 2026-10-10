// runtime.policy() carries the sealed run mode (S1.7 follow-through): the
// plugin path must populate PolicyContext.runMode from the sealed run state,
// or the mode-aware REPORT.md grant denies both writers (fail closed) and the
// deep-research coordinator can never write its report on the real host.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, gateRunner } from "@heretek-ai/es-core"
import { createRuntime, parseOptions } from "../src/runtime.ts"

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "es-runtime-runmode-"))
  const state = await mkdtemp(path.join(tmpdir(), "es-runtime-runmode-state-"))
  return { root, state }
}

describe("runtime policy runMode (S1.7)", () => {
  test("no run: runMode is absent (fail closed)", async () => {
    const { root, state } = await setup()
    try {
      const runtime = await createRuntime(root, parseOptions({ stateDir: state }))
      try {
        expect("runMode" in (await runtime.policy())).toBe(false)
      } finally {
        await runtime.lsp.stopAll().catch(() => undefined)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("research run: runMode is research", async () => {
    const { root, state } = await setup()
    try {
      const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
      await factory.beginResearchRun({ objective: "Does the mode carry?", ceilingUSD: 5 })
      const runtime = await createRuntime(root, parseOptions({ stateDir: state }))
      try {
        expect((await runtime.policy()).runMode).toBe("research")
      } finally {
        await runtime.lsp.stopAll().catch(() => undefined)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})
