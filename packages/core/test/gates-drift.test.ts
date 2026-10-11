// Control-drift visibility (#242): when a tampered control file halts the
// run, the halt names the gate rule (integrity/control-drift) and points at
// the gate summary holding the structured finding — a seat debugging the halt
// gets more than an opaque "control files changed".
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { recordApproval } from "../src/approval/index.ts"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { Factory, FactoryHalted } from "../src/factory/index.ts"
import { type Fixture, frontier, gitRepo } from "./helpers.ts"

const PASSPHRASE = "test-passphrase-1234"
let fx: Fixture
let signer: HumanSigner
let factory: Factory

beforeEach(async () => {
  fx = await gitRepo("es-gdrift-")
  await sealHumanKey(PASSPHRASE, fx.state)
  signer = await unlockHumanKey(PASSPHRASE, fx.state)
  factory = new Factory(fx.root, {
    gates: async () => ({ passed: true, findings: [], summary: "green" }),
    stateDir: fx.state,
  })
})
afterEach(() => fx.cleanup())

describe("drift halt visibility", () => {
  test("a drift halt names integrity/control-drift and the gate summary holding the finding", async () => {
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier())
    await recordApproval(fx.root, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
    await writeFile(path.join(fx.root, ".factory/gates.json"), '{"commands":[]}\n')
    const error = await factory.recordGateRun("es-programmer", { passed: false, findings: [], summary: "red" }).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(FactoryHalted)
    expect(String(error)).toContain("integrity/control-drift")
    expect(String(error)).toContain("summary.json")
    expect((await factory.read())?.stage).toBe("HALTED")
  })
})
