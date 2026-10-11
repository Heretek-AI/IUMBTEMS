// Evolutionary prompt & cognitive strategy optimizer (#174): candidates are
// derived from telemetry failure clusters, graded against the benchmark
// suite, and only Pareto-dominating winners become reviewable proposals.
// Nothing is ever applied without a recorded human approval.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { BenchmarkAttempt } from "../src/evals/benchmarks.ts"
import {
  applyPromptPatch,
  evolvePrompts,
  generatePromptCandidates,
  type HumanApproval,
  OptimizerError,
  paretoDominates,
  receiptFor,
} from "../src/improve/optimizer.ts"
import type { RunTelemetry, Telemetry } from "../src/schema/improve.ts"

const runTelemetry = (id: string, extra: Partial<RunTelemetry> = {}): RunTelemetry => ({
  id,
  mode: "build",
  stage: "HALTED",
  spend: { usd: 1, estimated: false, events: 5 },
  phases: [],
  gateRejections: [],
  auditFindings: [],
  auditChain: { entries: 1, valid: true, trail: [] },
  seal: { valid: true },
  ...extra,
})

/** Telemetry with a recurring gate failure to optimize against. */
const failingTelemetry = (): Telemetry => ({
  version: 2,
  harvestedAt: "2026-10-11T00:00:00.000Z",
  runs: [
    runTelemetry("run-a", {
      gateRejections: [{ rule: "lint/no-unused-vars", count: 2, logs: ["gates/s1/summary.json"] }],
    }),
    runTelemetry("run-b", {
      gateRejections: [{ rule: "lint/no-unused-vars", count: 1, logs: ["gates/s1/summary.json"] }],
    }),
  ],
  evals: [
    { case: "case-x", pass: false, failures: ["missing export: run"], steps: 9, source: "agg.json" },
    { case: "case-y", pass: false, failures: ["missing export: run"], steps: 4, source: "agg.json" },
  ],
})

const emptyTelemetry = (): Telemetry => ({
  version: 2,
  harvestedAt: "2026-10-11T00:00:00.000Z",
  runs: [],
  evals: [],
})

const attempt = (caseId: string, pass: boolean, extra: Partial<BenchmarkAttempt> = {}): BenchmarkAttempt => ({
  caseId,
  category: "algorithms",
  pass,
  failures: pass ? [] : ["oracle red"],
  durationMs: 5,
  ...extra,
})

const BASE = "Solve the task. Keep the module compiling."

describe("generatePromptCandidates", () => {
  test("derives targeted variations from telemetry failure clusters", () => {
    const candidates = generatePromptCandidates(BASE, failingTelemetry())
    expect(candidates.length).toBeGreaterThan(0)
    // Every candidate names the failing signal it targets (no invented guidance).
    expect(candidates.every((c) => c.rationale.length > 0)).toBe(true)
    expect(candidates.some((c) => c.prompt.includes("lint/no-unused-vars"))).toBe(true)
    // Candidate ids are deterministic.
    expect(generatePromptCandidates(BASE, failingTelemetry()).map((c) => c.id)).toEqual(candidates.map((c) => c.id))
  })

  test("fail-closed: signal-free telemetry yields no candidates", () => {
    expect(generatePromptCandidates(BASE, emptyTelemetry())).toEqual([])
  })

  test("fail-closed: an empty base prompt is refused", () => {
    expect(() => generatePromptCandidates("", failingTelemetry())).toThrow(OptimizerError)
    expect(() => generatePromptCandidates("   ", failingTelemetry())).toThrow(OptimizerError)
  })
})

describe("paretoDominates", () => {
  const baseline = receiptFor("base", [attempt("a", true), attempt("b", false)], {
    a: { pass: true, durationMs: 4 },
    b: { pass: false, durationMs: 4 },
  })

  test("higher pass rate with no regressions dominates", () => {
    const fix = receiptFor("fix", [attempt("a", true), attempt("b", true)], {
      a: { pass: true, durationMs: 4 },
      b: { pass: false, durationMs: 4 },
    })
    expect(fix.regressions).toEqual([])
    expect(paretoDominates(fix, baseline)).toBe(true)
  })

  test("a regression vetoes dominance even when the pass rate rises", () => {
    const bad = receiptFor("bad", [attempt("a", false), attempt("b", true)], {
      a: { pass: true, durationMs: 4 },
      b: { pass: false, durationMs: 4 },
    })
    expect(bad.regressions).toEqual(["a"])
    expect(paretoDominates(bad, baseline)).toBe(false)
  })

  test("lower cost at equal pass rate dominates; identical receipts do not", () => {
    const cheaper = receiptFor(
      "cheap",
      [attempt("a", true, { costUSD: 0.01 }), attempt("b", false, { costUSD: 0.01 })],
      { a: { pass: true, durationMs: 4 }, b: { pass: false, durationMs: 4 } },
    )
    const pricey = receiptFor("pricey", [attempt("a", true, { costUSD: 9 }), attempt("b", false, { costUSD: 9 })], {
      a: { pass: true, durationMs: 4 },
      b: { pass: false, durationMs: 4 },
    })
    expect(paretoDominates(cheaper, pricey)).toBe(true)
    expect(paretoDominates(pricey, cheaper)).toBe(false)
    expect(paretoDominates(pricey, pricey)).toBe(false)
  })
})

describe("evolvePrompts", () => {
  test("grades candidates and keeps only Pareto winners, with receipts", async () => {
    const baselineAttempts = [attempt("a", true), attempt("b", false)]
    const baselineMap = { a: { pass: true, durationMs: 4 }, b: { pass: false, durationMs: 4 } }
    const grade = async (prompt: string) =>
      prompt.includes("lint/no-unused-vars")
        ? { attempts: [attempt("a", true), attempt("b", true)], costUSD: 0.02, steps: 6 }
        : { attempts: baselineAttempts, costUSD: 0.02, steps: 6 }
    const result = await evolvePrompts({
      basePrompt: BASE,
      basePromptId: "programmer",
      telemetry: failingTelemetry(),
      baseline: baselineMap,
      grade,
    })
    expect(result.receipts.length).toBeGreaterThan(0)
    expect(result.winners.length).toBeGreaterThan(0)
    for (const winner of result.winners) {
      expect(winner.receipt.regressions).toEqual([])
      expect(winner.before.passAt1).toBeLessThanOrEqual(winner.receipt.passAt1)
    }
  })

  test("fail-closed: a vacuous baseline (zero attempts) is refused", async () => {
    await expect(
      evolvePrompts({
        basePrompt: BASE,
        basePromptId: "programmer",
        telemetry: failingTelemetry(),
        baseline: {},
        grade: async () => ({ attempts: [], costUSD: 0, steps: 0 }),
      }),
    ).rejects.toThrow(OptimizerError)
  })
})

describe("applyPromptPatch is human-gated", () => {
  const setup = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-optimizer-"))
    const target = path.join(dir, "prompt.md")
    const proposal = {
      id: "prompt-guidance-gate-lint",
      prompt: `${BASE}\n\nKnown pitfall: lint/no-unused-vars.`,
      before: BASE,
    }
    return { dir, target, proposal }
  }

  test("refuses to write without a recorded human approval", async () => {
    const { target, proposal } = await setup()
    await expect(applyPromptPatch({ proposal, targetFile: target })).rejects.toThrow(OptimizerError)
    await expect(readFile(target, "utf8").catch(() => "missing")).resolves.toBe("missing")
  })

  test("refuses mismatched proposal ids and hashes", async () => {
    const { target, proposal } = await setup()
    const approval: HumanApproval = {
      proposalId: "other-id",
      promptHash: "deadbeef",
      approver: "human",
      signedAt: "2026-10-11T00:00:00.000Z",
    }
    await expect(applyPromptPatch({ proposal, targetFile: target, approval })).rejects.toThrow(OptimizerError)
  })

  test("a matching human approval applies exactly the proposed prompt", async () => {
    const { dir, target, proposal } = await setup()
    const { hashPrompt } = await import("../src/improve/optimizer.ts")
    const approval: HumanApproval = {
      proposalId: proposal.id,
      promptHash: hashPrompt(proposal.prompt),
      approver: "human-director",
      signedAt: "2026-10-11T00:00:00.000Z",
    }
    const applied = await applyPromptPatch({ proposal, targetFile: target, approval })
    expect(await readFile(target, "utf8")).toBe(proposal.prompt)
    expect(applied.promptHash).toBe(approval.promptHash)
    await rm(dir, { recursive: true, force: true })
  })
})
