import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFile, rm, writeFile } from "node:fs/promises"
import { factoryLayout } from "../src/layout.ts"
import { signEngineFile, verifyEngineFile } from "../src/trust/sidecar.ts"
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
})
