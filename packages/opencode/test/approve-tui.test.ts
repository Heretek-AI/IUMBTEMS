// In-TUI approval signing (#119): orchestration with a scripted masked input
// (the Solid component itself is proven by the #118 spike in the headless
// test renderer; here every step around it runs for real: throttle, unlock,
// approveStage, lockout audit).
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  approvalSubject,
  checkApprovalAttempts,
  Factory,
  factoryLayout,
  gateRunner,
  hashJson,
  readApproval,
  recentAuditEntries,
  sealHumanKey,
} from "@heretek-ai/es-core"
import { approveInTui } from "../src/approve-tui.ts"

const PASSPHRASE = "test-passphrase-1234"

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "es-tui-approve-"))
  const state = await mkdtemp(path.join(tmpdir(), "es-tui-approve-state-"))
  await sealHumanKey(PASSPHRASE, state)
  const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
  await factory.writeFrontier("grill", {
    version: "1.1",
    idea: "tui test",
    spendCeiling: { currency: "USD", maxAmount: 3 },
    settled: true,
    nodes: [{ id: "a", question: "q?", answer: "yes", status: "settled" }],
  })
  return {
    root,
    state,
    hash: async () => hashJson((await approvalSubject(root, "frontier")).subject),
    cleanup: () =>
      Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]),
  }
}

describe("approveInTui", () => {
  test("a scripted masked input completes the approval with channel tui", async () => {
    const fx = await setup()
    try {
      const outcome = await approveInTui({
        root: fx.root,
        stage: "frontier",
        expectedSubjectHash: await fx.hash(),
        stateDir: fx.state,
        readPassphrase: async () => [...PASSPHRASE],
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.record).toMatchObject({ stage: "frontier", channel: "tui" })
      expect((await readApproval(fx.root, "frontier"))?.channel).toBe("tui")
      const factory = new Factory(fx.root, { gates: gateRunner({ stateDir: fx.state }), stateDir: fx.state })
      expect((await factory.read())?.stage).toBe("RESEARCH")
      // The passphrase reaches no persisted surface: the attempt file holds
      // timestamps only, and the record holds no secret.
      const attempts = await readFile(path.join(fx.state, "approval-attempts.json"), "utf8")
      expect(attempts).not.toContain(PASSPHRASE.slice(4))
      expect(JSON.stringify(outcome.record)).not.toContain(PASSPHRASE.slice(4))
    } finally {
      await fx.cleanup()
    }
  })

  test("an artifact changed between preview and sign is refused", async () => {
    const fx = await setup()
    try {
      const hash = await fx.hash()
      const frontierFile = factoryLayout(fx.root).frontier
      const frontier = JSON.parse(await readFile(frontierFile, "utf8")) as Record<string, unknown>
      await writeFile(frontierFile, JSON.stringify({ ...frontier, idea: "changed after preview" }))
      await expect(
        approveInTui({
          root: fx.root,
          stage: "frontier",
          expectedSubjectHash: hash,
          stateDir: fx.state,
          readPassphrase: async () => [...PASSPHRASE],
        }),
      ).rejects.toThrow(/changed since the preview/)
      expect(await readApproval(fx.root, "frontier")).toBeUndefined()
    } finally {
      await fx.cleanup()
    }
  })

  test("5 wrong passphrases lock out, and the lockout is audited", async () => {
    const fx = await setup()
    try {
      let reads = 0
      const outcome = await approveInTui({
        root: fx.root,
        stage: "frontier",
        expectedSubjectHash: await fx.hash(),
        stateDir: fx.state,
        readPassphrase: async () => {
          reads++
          return [..."wrong-passphrase-000"]
        },
      })
      expect(reads).toBe(5)
      expect(outcome).toMatchObject({ ok: false, locked: true })
      if (outcome.ok || !("locked" in outcome)) return
      expect(outcome.retryAfterSec).toBeGreaterThan(0)
      expect((await checkApprovalAttempts(fx.state)).allowed).toBe(false)
      const entries = await recentAuditEntries(fx.root, 10)
      const lockout = entries.find((entry) => entry.action === "approval.lockout")
      expect(lockout?.payload).toMatchObject({ stage: "frontier", channel: "tui" })
    } finally {
      await fx.cleanup()
    }
  })

  test("a TUI without the root or the sealed key falls back to the terminal alert", async () => {
    const fx = await setup()
    try {
      const missing = await approveInTui({
        root: path.join(fx.root, "no-such-project"),
        stage: "frontier",
        expectedSubjectHash: "0".repeat(64),
        stateDir: fx.state,
        readPassphrase: async () => {
          throw new Error("must not ask")
        },
      })
      expect(missing).toMatchObject({ ok: false, fallback: true })
      if (missing.ok || !("fallback" in missing)) return
      expect(missing.reason).toContain("es approve frontier")

      const bare = await mkdtemp(path.join(tmpdir(), "es-tui-bare-"))
      const keyless = await approveInTui({
        root: bare,
        stage: "spec",
        expectedSubjectHash: "0".repeat(64),
        stateDir: await mkdtemp(path.join(tmpdir(), "es-tui-keyless-")),
        readPassphrase: async () => {
          throw new Error("must not ask")
        },
      })
      expect(keyless).toMatchObject({ ok: false, fallback: true })
      await rm(bare, { recursive: true, force: true })
    } finally {
      await fx.cleanup()
    }
  })

  test("cancelling the dialog approves nothing", async () => {
    const fx = await setup()
    try {
      const outcome = await approveInTui({
        root: fx.root,
        stage: "frontier",
        expectedSubjectHash: await fx.hash(),
        stateDir: fx.state,
        readPassphrase: async () => undefined,
      })
      expect(outcome).toEqual({ ok: false, cancelled: true })
      expect(await readApproval(fx.root, "frontier")).toBeUndefined()
    } finally {
      await fx.cleanup()
    }
  })
})
