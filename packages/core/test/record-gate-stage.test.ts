// Gate runs outside BUILD must refuse, never silently record nothing (#223.2).
import { describe, expect, test } from "bun:test"
import { Factory, FactoryError } from "../src/factory/index.ts"
import { type Fixture, frontier, gitRepo } from "./helpers.ts"

describe("recordGateRun stage gate (#223)", () => {
  test("recording outside BUILD refuses instead of silently dropping the run", async () => {
    const fx: Fixture = await gitRepo("es-gaterun-")
    try {
      const factory = new Factory(fx.root, {
        gates: async () => ({ passed: true, findings: [], summary: "green" }),
        stateDir: fx.state,
      })
      await factory.begin("human:tester")
      await factory.writeFrontier("grill", frontier())
      await expect(
        factory.recordGateRun("es-programmer", { passed: true, findings: [], summary: "green" }),
      ).rejects.toThrow("BUILD")
    } finally {
      await fx.cleanup()
    }
  })
})
