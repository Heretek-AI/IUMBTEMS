// Control-file integrity for squad S2: improve proposals are agent
// deny-write, and the factory control list has no duplicated globs.
import { describe, expect, test } from "bun:test"
import { FACTORY_CONTROL, isControlPath } from "../src/trust/control.ts"
import { evaluateWrite } from "../src/trust/policy.ts"

describe("improve proposals are control files (S2.3)", () => {
  test("improve paths classify as factory control", () => {
    expect(isControlPath(".factory/improve/proposals/x/proposal.json")).toBe(true)
    expect(isControlPath(".factory/improve/proposals/x/notes.md")).toBe(true)
    expect(isControlPath(".factory/improve/telemetry.json")).toBe(true)
  })

  test("a seat write to an improve proposal is denied", () => {
    const ctx = () => ({ root: "/tmp/es-control-test", stateDir: "/tmp/es-control-state" })
    for (const agent of [undefined, "build", "factory", "es-programmer", "es-manager", "harvester"]) {
      const decision = evaluateWrite(ctx(), agent, ".factory/improve/proposals/x/proposal.json")
      expect([agent, decision.effect]).toEqual([agent, "deny"])
    }
  })

  test("the factory control list has no duplicated globs", () => {
    expect(new Set(FACTORY_CONTROL).size).toBe(FACTORY_CONTROL.length)
  })
})
