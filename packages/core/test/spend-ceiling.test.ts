// Spend-ceiling backstop (#229): a frontier approval without a spend ceiling
// (hand-written, legacy-shaped) must never start a run with no ceiling.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { recordApproval, verifyApproval } from "../src/approval/index.ts"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { Factory } from "../src/factory/index.ts"
import { factoryLayout } from "../src/layout.ts"
import { ApprovalSchema } from "../src/schema/approval.ts"
import { rebaseline } from "../src/trust/control.ts"
import { writeJson } from "../src/util/fs.ts"
import { type Fixture, frontier, gitRepo } from "./helpers.ts"

const PASSPHRASE = "test-passphrase-1234"
let fx: Fixture
let signer: HumanSigner
let factory: Factory

beforeEach(async () => {
  fx = await gitRepo("es-ceil-")
  await sealHumanKey(PASSPHRASE, fx.state)
  signer = await unlockHumanKey(PASSPHRASE, fx.state)
  factory = new Factory(fx.root, {
    gates: async () => ({ passed: true, findings: [], summary: "green" }),
    stateDir: fx.state,
  })
})
afterEach(() => fx.cleanup())

describe("spend ceiling backstop", () => {
  test("beginResearch refuses a ceiling-less frontier approval", async () => {
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier())
    const genuine = await recordApproval(fx.root, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
    expect(genuine.spendCeilingUSD).toBe(25)
    // A human-signed but ceiling-less record: valid signature, valid schema,
    // no ceiling — the shape a hand-written legacy record would have.
    const { spendCeilingUSD: _dropped, signature: _old, ...rest } = genuine
    const ceilingLess = ApprovalSchema.parse({ ...rest, signature: signer.sign(rest) })
    expect(ceilingLess.spendCeilingUSD).toBeUndefined()
    await writeJson(factoryLayout(fx.root).approval("frontier"), ceilingLess)
    await rebaseline(fx.root, "human:tester")
    expect((await verifyApproval(fx.root, "frontier", { stateDir: fx.state })).ok).toBe(true)
    await expect(factory.beginResearch("human:tester")).rejects.toThrow(/spend ceiling/)
    expect((await factory.read())?.stage).toBe("GRILL")
  })
})
