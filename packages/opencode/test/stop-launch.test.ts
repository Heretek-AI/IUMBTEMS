// A user-agent seat launch must not bypass STOP/HALTED (#227).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, gateRunner } from "@heretek-ai/es-core"
import { createPolicyHooks } from "../src/policy.ts"
import type { Runtime } from "../src/runtime.ts"

let root: string
let state: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-stop-launch-"))
  state = await mkdtemp(path.join(tmpdir(), "es-stop-launch-state-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const runtime = (kind: "stop" | "halted" | "clean") =>
  ({
    root,
    factory:
      kind === "halted"
        ? { read: async () => ({ stage: "HALTED", halt: { reason: "spend ceiling" } }) }
        : new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state }),
    policy: async () => ({ root }),
  }) as unknown as Runtime

const launch = (agent: string) => ({
  tool: "subagent",
  agent,
  id: "1",
  input: { agent: "es-qa-functional", description: "qa", prompt: "check" },
})

describe("STOP/HALTED covers user-agent seat launches (#227)", () => {
  test("a user agent cannot launch a seat while STOP is present", async () => {
    await mkdir(path.join(root, ".factory"), { recursive: true })
    await writeFile(path.join(root, ".factory/STOP"), "halt\n")
    const { before } = createPolicyHooks(runtime("stop"))
    await expect(before(launch("build") as never)).rejects.toThrow("stopped")
  })

  test("a user agent cannot launch a seat while the run is HALTED", async () => {
    const { before } = createPolicyHooks(runtime("halted"))
    await expect(before(launch("build") as never)).rejects.toThrow("halted")
  })

  test("a user-agent launch is allowed when neither STOP nor HALTED applies", async () => {
    const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
    void factory
    const { before } = createPolicyHooks(runtime("clean"))
    await before(launch("build") as never)
  })
})
