import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { recordApproval } from "../src/approval/index.ts"
import { FactoryStateMachine } from "../src/factory/index.ts"

describe("factory state machine and approvals", () => {
  test("initializes factory with spend ceiling", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-factory-init-"))
    try {
      const machine = await FactoryStateMachine.init(tempDir, 25.0)
      const state = machine.getState()
      expect(state.stage).toBe("GRILL")
      expect(state.spendCeilingUSD).toBe(25.0)
      expect(state.totalSpendUSD).toBe(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("enforces human approval and frontier before advancing from GRILL", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-factory-grill-"))
    try {
      const machine = await FactoryStateMachine.init(tempDir, 30.0)

      // Advancing without approval throws
      expect(machine.advance()).rejects.toThrow("requires settled frontier and human approval")

      // Write frontier.json
      const frontierPath = path.join(tempDir, "frontier.json")
      const frontier = {
        version: "1.0",
        spendCeiling: { currency: "USD", maxAmount: 30.0 },
        settled: true,
        nodes: [{ id: "q1", question: "Architecture?", status: "settled" }],
      }
      await Bun.write(frontierPath, JSON.stringify(frontier, null, 2))

      // Record approval
      await recordApproval(tempDir, {
        stage: "grill",
        artifactPath: frontierPath,
        approvedBy: "john",
        spendCeilingConfirmed: 30.0,
      })

      // Now advancing succeeds to SPEC
      const nextState = await machine.advance()
      expect(nextState.stage).toBe("SPEC")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("halts when spend ceiling or STOP file is engaged", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-factory-caps-"))
    try {
      const machine = await FactoryStateMachine.init(tempDir, 10.0)
      machine.recordSpend(15.0)

      await machine.advance()
      expect(machine.getState().stage).toBe("HALTED")
      expect(machine.getState().haltReason).toContain("Spend ceiling exceeded")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
