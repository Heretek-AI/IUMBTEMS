import { describe, expect, test } from "bun:test"
import {
  ApprovalSchema,
  AuditEntrySchema,
  FrontierSchema,
  GatesConfigSchema,
  isWaiverActive,
  PhaseSchema,
  parseGoalMarkdown,
  WaiverSchema,
} from "../src/schema/index.ts"

describe("schemas", () => {
  test("frontier schema validates spend ceiling and nodes", () => {
    const valid = FrontierSchema.parse({
      spendCeiling: { currency: "USD", maxAmount: 50.0 },
      nodes: [{ id: "q1", question: "Monorepo or multi-repo?", answer: "Monorepo", status: "settled" }],
      settled: true,
    })
    expect(valid.spendCeiling.maxAmount).toBe(50.0)
    expect(valid.nodes.length).toBe(1)

    // Negative ceiling throws
    expect(() =>
      FrontierSchema.parse({
        spendCeiling: { currency: "USD", maxAmount: -10 },
      }),
    ).toThrow()
  })

  test("goal markdown parser parses frontmatter and acceptance criteria", () => {
    const content = `---
phase: 01-scaffold
title: Monorepo Scaffold
verticalSlice: true
acceptanceCriteria:
  - id: ac1
    description: bun test passes
    testCommand: bun test
dependencies:
  - dep1
spendBudget: 15.0
---
# Scaffold Goal
Here is the detailed body text.
`
    const { frontmatter, body } = parseGoalMarkdown(content)
    expect(frontmatter.phase).toBe("01-scaffold")
    expect(frontmatter.acceptanceCriteria.length).toBe(1)
    expect(frontmatter.acceptanceCriteria[0]?.testCommand).toBe("bun test")
    expect(body.trim()).toBe("# Scaffold Goal\nHere is the detailed body text.")
  })

  test("phase schema defaults and seat assignments", () => {
    const phase = PhaseSchema.parse({
      id: "p1",
      name: "Phase 1",
    })
    expect(phase.state).toBe("PENDING")
    expect(phase.assignedSeats.programmer).toBe("programmer")
    expect(phase.assignedSeats.qa_a).toBe("qa-a")
    expect(phase.assignedSeats.qa_b).toBe("qa-b")
    expect(phase.assignedSeats.manager).toBe("manager")
  })

  test("gates config schema validates default rules and budgets", () => {
    const config = GatesConfigSchema.parse({
      commands: {
        lint: { command: "biome check .", extensions: [".ts", ".js"] },
      },
      budgets: {
        maxDiffLines: 600,
        maxFileLines: 900,
        requireDepJustification: true,
      },
    })
    expect(config.budgets.maxDiffLines).toBe(600)
    expect(config.security.secrets).toBe(true)
  })

  test("waiver active check honours expiration timestamp", () => {
    const now = new Date("2026-10-06T12:00:00Z")
    const futureWaiver = WaiverSchema.parse({
      id: "w1",
      rule: "lint/no-explicit-any",
      filePattern: "test/**",
      reason: "Mocking complex host types",
      signedBy: "john",
      signedAt: "2026-10-06T10:00:00Z",
      expiresAt: "2026-10-07T10:00:00Z",
      artifactHash: "a".repeat(64),
    })
    expect(isWaiverActive(futureWaiver, now)).toBe(true)

    const expiredWaiver = WaiverSchema.parse({
      ...futureWaiver,
      expiresAt: "2026-10-05T10:00:00Z",
    })
    expect(isWaiverActive(expiredWaiver, now)).toBe(false)
  })

  test("approval schema checks required hashes and actor", () => {
    const approval = ApprovalSchema.parse({
      stage: "spec",
      phaseId: "01-scaffold",
      artifactPath: ".factory/specs/01-scaffold/GOAL.md",
      artifactHash: "b".repeat(64),
      approvedBy: "john",
      approvedAt: "2026-10-06T15:00:00Z",
    })
    expect(approval.artifactHash).toBe("b".repeat(64))
  })

  test("audit entry schema validates hash lengths and sequence", () => {
    const entry = AuditEntrySchema.parse({
      seq: 0,
      timestamp: "2026-10-06T15:00:00Z",
      prevHash: "0".repeat(64),
      actor: "manager",
      action: "phase_start",
      payload: { phase: "01-scaffold" },
      hash: "c".repeat(64),
    })
    expect(entry.seq).toBe(0)
  })
})
