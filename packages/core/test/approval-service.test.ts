// Core approval service (#117): one code path every surface calls.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { approvalSubject, readApproval } from "../src/approval/index.ts"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { approveStage } from "../src/approval/service.ts"
import { recentAuditEntries } from "../src/audit/index.ts"
import { Factory, type PendingApproval, pendingApprovals } from "../src/factory/index.ts"
import { factoryLayout } from "../src/layout.ts"
import { writeJson } from "../src/util/fs.ts"
import { hashJson } from "../src/util/hash.ts"
import { type Fixture, frontier, gitRepo, writeSpecs } from "./helpers.ts"

const PASSPHRASE = "test-passphrase-1234"
let fx: Fixture
let signer: HumanSigner

beforeEach(async () => {
  fx = await gitRepo()
  await sealHumanKey(PASSPHRASE, fx.state)
  signer = await unlockHumanKey(PASSPHRASE, fx.state)
  const factory = new Factory(fx.root, {
    gates: async () => ({ passed: true, findings: [], summary: "green" }),
    stateDir: fx.state,
  })
  await factory.writeFrontier("grill", frontier())
})
afterEach(() => fx.cleanup())

const seedPending = (stages: Array<PendingApproval["stage"]>) =>
  writeJson(
    factoryLayout(fx.root).pending,
    stages.map((stage) => ({ stage, requestedBy: "factory", at: new Date().toISOString() })),
  )

const approve = (stage: "frontier" | "spec", extra: Record<string, unknown> = {}) =>
  approveStage(fx.root, { stage, channel: "cli", approvedBy: "tester", signer, stateDir: fx.state, ...extra })

describe("approveStage", () => {
  test("frontier: record, pending cleared, research begins, in that audit order", async () => {
    // No run yet (frontier written, state removed): begin runs too.
    const layout = factoryLayout(fx.root)
    await rm(layout.state, { force: true })
    await rm(`${layout.state}.sig`, { force: true })
    await seedPending(["frontier"])
    const result = await approve("frontier")
    expect(result.alreadyApproved).toBe(false)
    expect(result.record).toMatchObject({ stage: "frontier", channel: "cli", approvedBy: "tester" })
    expect(result.factoryStage).toBe("RESEARCH")
    expect(await pendingApprovals(fx.root)).toEqual([])
    expect((await readApproval(fx.root, "frontier"))?.signature.sig).toBe(result.record.signature.sig)
    const actions = (await recentAuditEntries(fx.root, 10)).map((entry) => entry.action)
    const order = ["approval.frontier", "factory.begin", "stage.research"].map((action) => actions.indexOf(action))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test("an expected-subject-hash mismatch refuses and records nothing", async () => {
    await seedPending(["frontier"])
    await expect(approve("frontier", { expectedSubjectHash: "0".repeat(64) })).rejects.toThrow(
      /changed since the preview/,
    )
    expect(await readApproval(fx.root, "frontier")).toBeUndefined()
    expect(await pendingApprovals(fx.root)).toHaveLength(1)
    // The previewed hash is accepted.
    const subject = await approvalSubject(fx.root, "frontier")
    const result = await approve("frontier", { expectedSubjectHash: hashJson(subject.subject) })
    expect(result.alreadyApproved).toBe(false)
  })

  test("re-approving an unchanged subject is a no-op that still ensures side effects", async () => {
    await seedPending(["frontier"])
    const first = await approve("frontier")
    const second = await approve("frontier")
    expect(second.alreadyApproved).toBe(true)
    expect(second.record.approvedAt).toBe(first.record.approvedAt)
    expect(second.record.signature.sig).toBe(first.record.signature.sig)
    expect(second.factoryStage).toBe("RESEARCH")
    // A changed artifact is not idempotent: it re-signs the new subject.
    await writeSpecs(fx.root, ["alpha"])
    await seedPending(["spec"])
    const specFirst = await approve("spec")
    expect(specFirst.alreadyApproved).toBe(false)
    const goal = factoryLayout(fx.root).spec("alpha")
    await writeFile(goal, `${await readFile(goal, "utf8")}\n<!-- touched -->\n`)
    const specSecond = await approve("spec")
    expect(specSecond.alreadyApproved).toBe(false)
    expect(specSecond.record.signature.sig).not.toBe(specFirst.record.signature.sig)
  })

  test("spec approval clears pending without beginning research, recording its channel", async () => {
    await seedPending(["frontier"])
    await approve("frontier")
    await writeSpecs(fx.root, ["alpha"])
    await seedPending(["spec"])
    const factory = new Factory(fx.root, {
      gates: async () => ({ passed: true, findings: [], summary: "green" }),
      stateDir: fx.state,
    })
    const before = (await factory.read())?.stage
    const result = await approveStage(fx.root, {
      stage: "spec",
      channel: "tui",
      approvedBy: "tester",
      signer,
      stateDir: fx.state,
    })
    expect(result.alreadyApproved).toBe(false)
    expect(result.record.channel).toBe("tui")
    expect(await pendingApprovals(fx.root)).toEqual([])
    expect((await factory.read())?.stage).toBe(before)
  })

  test("pending is cleared only for the approved stage", async () => {
    await seedPending(["frontier", "spec"])
    await approve("frontier")
    expect(await pendingApprovals(fx.root)).toMatchObject([{ stage: "spec" }])
  })

  test("a midway failure keeps the signed record and stays retryable without re-signing", async () => {
    await seedPending(["frontier"])
    // Block the pending file: the record is signed, then the clear fails.
    await rm(factoryLayout(fx.root).pending, { force: true })
    await mkdir(factoryLayout(fx.root).pending, { recursive: true })
    await expect(approve("frontier")).rejects.toThrow()
    const signed = await readApproval(fx.root, "frontier")
    expect(signed?.stage).toBe("frontier")
    // Unblock and retry: no re-sign, side effects complete.
    await rm(factoryLayout(fx.root).pending, { recursive: true, force: true })
    await seedPending(["frontier"])
    const retry = await approve("frontier")
    expect(retry.alreadyApproved).toBe(true)
    expect(retry.record.approvedAt).toBe(signed?.approvedAt)
    expect(await pendingApprovals(fx.root)).toEqual([])
    expect(retry.factoryStage).toBe("RESEARCH")
  })

  test("web is a valid channel", async () => {
    await seedPending(["frontier"])
    const result = await approveStage(fx.root, {
      stage: "frontier",
      channel: "web",
      approvedBy: "tester",
      signer,
      stateDir: fx.state,
    })
    expect(result.record.channel).toBe("web")
  })
})
