// Issue #180 integration tests (core surface): approvals are hash-bound to
// the approved artifacts and every channel is recorded and verifies. Uses
// only existing seams (test keystores, temp dirs); no host, no human seal.
import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { type HumanSigner, sealHumanKey, unlockHumanKey, verifyRecordSignature } from "../src/approval/keystore.ts"
import { readApproval, verifyApproval } from "../src/approval/record.ts"
import { approveStage } from "../src/approval/service.ts"
import { Factory, pendingApprovals } from "../src/factory/index.ts"
import { factoryLayout } from "../src/layout.ts"
import { writeJson } from "../src/util/fs.ts"
import { type Fixture, frontier, gitRepo, writeSpecs } from "./helpers.ts"

const PASSPHRASE = "test-passphrase-1234"

async function setup(): Promise<{ fx: Fixture; signer: HumanSigner; factory: Factory }> {
  const fx = await gitRepo()
  await sealHumanKey(PASSPHRASE, fx.state)
  const signer = await unlockHumanKey(PASSPHRASE, fx.state)
  const factory = new Factory(fx.root, {
    gates: async () => ({ passed: true, findings: [], summary: "green" }),
    stateDir: fx.state,
  })
  await factory.writeFrontier("grill", frontier())
  return { fx, signer, factory }
}

const seedPending = (fx: Fixture, stages: Array<"frontier" | "spec">) =>
  writeJson(
    factoryLayout(fx.root).pending,
    stages.map((stage) => ({ stage, requestedBy: "factory", at: new Date().toISOString() })),
  )

describe("issue #180: approvals are hash-bound", () => {
  test("editing frontier.json after approval invalidates the record", async () => {
    const { fx, signer } = await setup()
    try {
      await seedPending(fx, ["frontier"])
      const { record } = await approveStage(fx.root, {
        stage: "frontier",
        channel: "tui",
        approvedBy: "tester",
        signer,
        stateDir: fx.state,
      })
      expect(record.channel).toBe("tui")
      expect((await verifyApproval(fx.root, "frontier", { stateDir: fx.state })).ok).toBe(true)
      const file = factoryLayout(fx.root).frontier
      await writeFile(file, `${await readFile(file, "utf8")}\n<!-- tampered -->\n`)
      const check = await verifyApproval(fx.root, "frontier", { stateDir: fx.state })
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.reason).toMatch(/changed after it was approved/)
      expect(await readApproval(fx.root, "frontier")).toBeDefined()
      expect(await pendingApprovals(fx.root)).toEqual([])
    } finally {
      signer.destroy()
      await fx.cleanup()
    }
  })

  test("editing a GOAL.md after spec approval invalidates it", async () => {
    const { fx, signer } = await setup()
    try {
      await writeSpecs(fx.root, ["alpha"])
      await seedPending(fx, ["spec"])
      await approveStage(fx.root, {
        stage: "spec",
        channel: "web",
        approvedBy: "tester",
        signer,
        stateDir: fx.state,
      })
      expect((await verifyApproval(fx.root, "spec", { stateDir: fx.state })).ok).toBe(true)
      const goal = factoryLayout(fx.root).spec("alpha")
      await writeFile(goal, `${await readFile(goal, "utf8")}\n<!-- tampered -->\n`)
      expect((await verifyApproval(fx.root, "spec", { stateDir: fx.state })).ok).toBe(false)
    } finally {
      signer.destroy()
      await fx.cleanup()
    }
  })
})

describe("issue #180: every channel is recorded and verifies", () => {
  test("cli, tui and web records carry their channel and a valid signature", async () => {
    for (const channel of ["cli", "tui", "web"] as const) {
      const { fx, signer } = await setup()
      try {
        await seedPending(fx, ["frontier"])
        const { record } = await approveStage(fx.root, {
          stage: "frontier",
          channel,
          approvedBy: "tester",
          signer,
          stateDir: fx.state,
        })
        expect(record.channel).toBe(channel)
        expect(record.signature.alg).toBe("ed25519")
        expect(await verifyRecordSignature(record, fx.state)).toBe(true)
        expect(await verifyApproval(fx.root, "frontier", { stateDir: fx.state })).toMatchObject({ ok: true })
      } finally {
        signer.destroy()
        await fx.cleanup()
      }
    }
  })

  test("a record with a forged signature is refused", async () => {
    const { fx, signer } = await setup()
    try {
      await seedPending(fx, ["frontier"])
      const { record } = await approveStage(fx.root, {
        stage: "frontier",
        channel: "cli",
        approvedBy: "tester",
        signer,
        stateDir: fx.state,
      })
      expect((await verifyApproval(fx.root, "frontier", { stateDir: fx.state })).ok).toBe(true)
      const file = factoryLayout(fx.root).approval("frontier")
      await writeJson(file, {
        ...record,
        signature: { ...record.signature, sig: `${record.signature.sig.slice(0, -2)}AA` },
      })
      const check = await verifyApproval(fx.root, "frontier", { stateDir: fx.state })
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.reason).toMatch(/not signed by this machine's human key/)
    } finally {
      signer.destroy()
      await fx.cleanup()
    }
  })
})
