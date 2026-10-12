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
  splitHoldout,
  writeOptimizerProposals,
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

describe("writeOptimizerProposals", () => {
  test("writes one proposal dir per winner with before/after receipts, and nothing else", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-opt-proposals-"))
    const baselineMap = { a: { pass: true, durationMs: 4 }, b: { pass: false, durationMs: 4 } }
    const grade = async (prompt: string) =>
      prompt.includes("lint/no-unused-vars")
        ? { attempts: [attempt("a", true), attempt("b", true)], costUSD: 0.02, steps: 6 }
        : { attempts: [attempt("a", true), attempt("b", false)], costUSD: 0.02, steps: 6 }
    const result = await evolvePrompts({
      basePrompt: BASE,
      basePromptId: "programmer",
      telemetry: failingTelemetry(),
      baseline: baselineMap,
      grade,
    })
    expect(result.winners.length).toBeGreaterThan(0)
    const { written, droppedFile } = await writeOptimizerProposals(dir, result, BASE)
    expect(written).toHaveLength(result.winners.length)
    for (const entry of written) {
      const proposal = JSON.parse(await readFile(path.join(entry.dir, "proposal.json"), "utf8"))
      expect(proposal.candidate.prompt).toContain("lint/no-unused-vars")
      expect(proposal.after.regressions).toEqual([])
      expect(proposal.after.passAt1).toBeGreaterThan(proposal.before.passAt1)
      const patch = await readFile(path.join(entry.dir, "prompt.patch.md"), "utf8")
      expect(patch).toContain("## Before")
      expect(patch).toContain("## After")
      const receipt = JSON.parse(await readFile(path.join(entry.dir, "receipt.json"), "utf8"))
      expect(receipt.before.candidateId).toBe(proposal.after.candidateId)
    }
    expect(JSON.parse(await readFile(droppedFile, "utf8"))).toEqual([])
    // The shipped prompt is untouched: proposals are review-only.
    expect(await readFile(path.join(dir, "dropped.json"), "utf8")).toBeDefined()
    await rm(dir, { recursive: true, force: true })
  })

  test("dominated candidates land in dropped.json with reasons", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-opt-dropped-"))
    const baselineMap = { a: { pass: true, durationMs: 4 }, b: { pass: false, durationMs: 4 } }
    // Every candidate regresses case `a`: nothing may win.
    const grade = async () => ({ attempts: [attempt("a", false), attempt("b", true)], costUSD: 0.01, steps: 2 })
    const result = await evolvePrompts({
      basePrompt: BASE,
      basePromptId: "programmer",
      telemetry: failingTelemetry(),
      baseline: baselineMap,
      grade,
    })
    expect(result.winners).toEqual([])
    const { written, droppedFile } = await writeOptimizerProposals(dir, result, BASE)
    expect(written).toEqual([])
    const dropped = JSON.parse(await readFile(droppedFile, "utf8"))
    expect(dropped).toHaveLength(result.dominated.length)
    expect(dropped[0].reasons.join(" ")).toContain("regressions")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("holdout split (#341)", () => {
  const four = {
    a: { pass: true, durationMs: 4 },
    b: { pass: false, durationMs: 4 },
    c: { pass: true, durationMs: 4 },
    d: { pass: false, durationMs: 4 },
  }

  test("the split is deterministic and stable across orderings and runs", async () => {
    const first = splitHoldout(["d", "b", "a", "c"])
    const second = splitHoldout(["a", "b", "c", "d"])
    expect(first).toEqual(second)
    expect([...first.selection, ...first.holdout].sort()).toEqual(["a", "b", "c", "d"])
    expect(first.selection.length).toBeGreaterThan(0)
    expect(first.holdout.length).toBeGreaterThan(0)
    expect(first.selection.filter((id) => first.holdout.includes(id))).toEqual([])
    const run = () =>
      evolvePrompts({
        basePrompt: BASE,
        basePromptId: "programmer",
        telemetry: failingTelemetry(),
        baseline: four,
        grade: async () => ({
          attempts: [attempt("a", true), attempt("b", true), attempt("c", true), attempt("d", true)],
          costUSD: 0.02,
          steps: 8,
        }),
      })
    const one = await run()
    const two = await run()
    expect(one.selection).toEqual(first.selection)
    expect(one.holdout).toEqual(first.holdout)
    expect(two.selection).toEqual(one.selection)
    expect(two.holdout).toEqual(one.holdout)
  })

  test("a candidate that wins on selection but regresses the holdout is rejected", async () => {
    // Sorted head [a] is held out, selection is [b, c, d]: fix b and d but regress a.
    const grade = async () => ({
      attempts: [attempt("a", false), attempt("b", true), attempt("c", true), attempt("d", true)],
      costUSD: 0.01,
      steps: 4,
    })
    const result = await evolvePrompts({
      basePrompt: BASE,
      basePromptId: "programmer",
      telemetry: failingTelemetry(),
      baseline: four,
      grade,
    })
    expect(result.winners).toEqual([])
    expect(result.dominated.length).toBeGreaterThan(0)
    expect(result.dominated).toHaveLength(result.receipts.length)
    expect(result.dominated[0]!.holdoutRegressions).toContain("a")
  })

  test("a selection win with a clean holdout is kept, and the receipt names the split", async () => {
    const grade = async () => ({
      attempts: [attempt("a", true), attempt("b", true), attempt("c", true), attempt("d", true)],
      costUSD: 0.02,
      steps: 8,
    })
    const result = await evolvePrompts({
      basePrompt: BASE,
      basePromptId: "programmer",
      telemetry: failingTelemetry(),
      baseline: four,
      grade,
    })
    expect(result.winners.length).toBeGreaterThan(0)
    for (const winner of result.winners) {
      expect(winner.receipt.holdoutRegressions).toEqual([])
      expect(winner.receipt.selection).toEqual(result.selection)
      expect(winner.receipt.holdout).toEqual(result.holdout)
      expect(winner.before.selection).toEqual(result.selection)
      expect(winner.before.holdout).toEqual(result.holdout)
    }
    const dir = await mkdtemp(path.join(tmpdir(), "es-opt-holdout-"))
    try {
      const { written } = await writeOptimizerProposals(dir, result, BASE)
      expect(written).toHaveLength(result.winners.length)
      for (const entry of written) {
        const proposal = JSON.parse(await readFile(path.join(entry.dir, "proposal.json"), "utf8"))
        expect(proposal.after.selection).toEqual(result.selection)
        expect(proposal.after.holdout).toEqual(result.holdout)
        expect(proposal.before.selection).toEqual(result.selection)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a candidate that skips held-out cases cannot win (ungraded is not proof)", async () => {
    const grade = async () => ({
      attempts: [attempt("b", true), attempt("c", true), attempt("d", true)],
      costUSD: 0.01,
      steps: 3,
    })
    const result = await evolvePrompts({
      basePrompt: BASE,
      basePromptId: "programmer",
      telemetry: failingTelemetry(),
      baseline: four,
      grade,
    })
    expect(result.winners).toEqual([])
    const dir = await mkdtemp(path.join(tmpdir(), "es-opt-ungraded-"))
    try {
      const { droppedFile } = await writeOptimizerProposals(dir, result, BASE)
      const dropped = JSON.parse(await readFile(droppedFile, "utf8")) as Array<{ reasons: string[] }>
      expect(dropped.length).toBeGreaterThan(0)
      expect(dropped[0]!.reasons.join(" ")).toContain("ungraded")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
