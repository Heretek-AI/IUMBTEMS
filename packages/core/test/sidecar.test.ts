import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { factoryLayout } from "../src/layout.ts"
import { engineKeyPath, ensureEngineKey } from "../src/research/seal.ts"
import { signEngineFile, verifyEngineFile } from "../src/trust/sidecar.ts"
import { exists } from "../src/util/fs.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

let fx: Fixture
beforeEach(async () => {
  fx = await gitRepo()
})
afterEach(() => fx.cleanup())

describe("engine sidecars", () => {
  test("sign then verify holds; tampering and stripping the seal refuse", async () => {
    const file = `${fx.root}/note.json`
    await writeFile(file, '{"a":1}\n')
    expect(await verifyEngineFile(file, fx.state)).toBe("missing sidecar")
    await signEngineFile(file, fx.state)
    expect(await verifyEngineFile(file, fx.state)).toBeUndefined()
    await appendFile(file, " ")
    expect(await verifyEngineFile(file, fx.state)).toBe("signature mismatch")
    await signEngineFile(file, fx.state)
    expect(await verifyEngineFile(file, fx.state)).toBeUndefined()
    await rm(`${file}.sig`)
    expect(await verifyEngineFile(file, fx.state)).toBe("missing sidecar")
  })

  test("a seal from another state dir does not verify", async () => {
    const other = await gitRepo("es-fx-other-")
    try {
      const file = `${fx.root}/note.json`
      await writeFile(file, '{"a":1}\n')
      await signEngineFile(file, other.state)
      await ensureEngineKey(fx.state)
      expect(await verifyEngineFile(file, fx.state)).toBe("signature mismatch")
    } finally {
      await other.cleanup()
    }
  })

  test("the run state is sealed on save and refused when pre-seeded or tampered", async () => {
    const { Factory } = await import("../src/factory/index.ts")
    const factory = new Factory(fx.root, {
      gates: async () => ({ passed: true, findings: [], summary: "green" }),
      stateDir: fx.state,
    })
    await factory.begin("human:tester")
    expect(await verifyEngineFile(factoryLayout(fx.root).state, fx.state)).toBeUndefined()

    // A pre-seeded run (no sidecar, e.g. written before .factory existed) is refused.
    await rm(`${factoryLayout(fx.root).state}.sig`)
    await expect(factory.read()).rejects.toThrow("es reseal --sign")

    // So is a tampered one (valid sidecar shape, wrong bytes).
    await signEngineFile(factoryLayout(fx.root).state, fx.state)
    await appendFile(factoryLayout(fx.root).state, " ")
    await expect(factory.read()).rejects.toThrow("signature mismatch")

    // Re-signing the reviewed file (what `es reseal --sign` does) restores reads.
    await signEngineFile(factoryLayout(fx.root).state, fx.state)
    expect((await factory.read())!.stage).toBe("GRILL")
  })

  test("a verifier that cannot see the engine key says so and never mints one (#59)", async () => {
    const { Factory } = await import("../src/factory/index.ts")
    const gates = async () => ({ passed: true, findings: [], summary: "green" })
    await new Factory(fx.root, { gates, stateDir: fx.state }).begin("human:tester")
    // An agent sandbox masks the state dir with an empty tmpfs: the same shape as a fresh dir.
    const masked = await mkdtemp(path.join(tmpdir(), "es-masked-"))
    const saved = process.env.ES_SANDBOX
    try {
      expect(await verifyEngineFile(factoryLayout(fx.root).state, masked)).toBe("missing engine key")
      expect(await exists(engineKeyPath(masked))).toBe(false)
      const blind = new Factory(fx.root, { gates, stateDir: masked })
      delete process.env.ES_SANDBOX
      await expect(blind.read()).rejects.toThrow(`there is no engine key at ${engineKeyPath(masked)}`)
      await expect(blind.read()).rejects.toThrow("ES_STATE_DIR")
      process.env.ES_SANDBOX = "readonly"
      await expect(blind.read()).rejects.toThrow('agent shell (sandbox "readonly")')
      await expect(blind.read()).rejects.toThrow("call the es_status tool")
      expect(await exists(engineKeyPath(masked))).toBe(false)
      // The engine's own reader is untouched.
      expect((await new Factory(fx.root, { gates, stateDir: fx.state }).read())!.stage).toBe("GRILL")
    } finally {
      if (saved === undefined) delete process.env.ES_SANDBOX
      else process.env.ES_SANDBOX = saved
      await rm(masked, { recursive: true, force: true })
    }
  })

  test("a mismatch names the key it checked against and the reseal caveat", async () => {
    const { Factory } = await import("../src/factory/index.ts")
    const factory = new Factory(fx.root, {
      gates: async () => ({ passed: true, findings: [], summary: "green" }),
      stateDir: fx.state,
    })
    await factory.begin("human:tester")
    await appendFile(factoryLayout(fx.root).state, " ")
    await expect(factory.read()).rejects.toThrow(
      `signature mismatch against the engine key at ${engineKeyPath(fx.state)}`,
    )
    await expect(factory.read()).rejects.toThrow("If `es reseal` reports that every sidecar verifies")
  })

  test("concurrent spend writes and reads never observe a half-signed pair", async () => {
    const { Factory } = await import("../src/factory/index.ts")
    const factory = new Factory(fx.root, {
      gates: async () => ({ passed: true, findings: [], summary: "green" }),
      stateDir: fx.state,
    })
    await factory.begin("human:tester")
    // Background spend events (step_finish) save while seats read: every
    // interleave must see a matching (state, sidecar) pair — a refusal
    // rejects the Promise.all and fails the test. Reads may win the lock
    // first and see the pre-charge snapshot; only forward progress matters.
    for (let i = 0; i < 25; i++) {
      const [charged, seen] = await Promise.all([factory.recordSpend(0.01, true), factory.read()])
      expect(charged?.spend.events).toBeGreaterThan(0)
      expect(seen?.stage).toBe("GRILL")
    }
    expect((await factory.read())!.spend.events).toBe(25)
  })
})
