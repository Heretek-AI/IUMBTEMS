// Audit proofs for #337 (prompt optimizer): forged approvals refused, and the
// full stub-grader loop leaves shipped assets untouched.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { BenchmarkAttempt } from "../src/evals/benchmarks.ts"
import {
  applyPromptPatch,
  evolvePrompts,
  generatePromptCandidates,
  type HumanApproval,
  hashPrompt,
  OptimizerError,
  writeOptimizerProposals,
} from "../src/improve/optimizer.ts"
import type { RunTelemetry, Telemetry } from "../src/schema/improve.ts"

const runTelemetry = (id: string): RunTelemetry => ({
  id,
  mode: "build",
  stage: "HALTED",
  spend: { usd: 1, estimated: false, events: 5 },
  phases: [],
  gateRejections: [{ rule: "lint/no-unused-vars", count: 2, logs: ["gates/s1/summary.json"] }],
  auditFindings: [],
  auditChain: { entries: 1, valid: true, trail: [] },
  seal: { valid: true },
})

const telemetry = (): Telemetry => ({
  version: 2,
  harvestedAt: "2026-10-11T00:00:00.000Z",
  runs: [runTelemetry("run-a"), runTelemetry("run-b")],
  evals: [{ case: "case-x", pass: false, failures: ["missing export: run"], steps: 9, source: "agg.json" }],
})

const attempt = (caseId: string, pass: boolean): BenchmarkAttempt => ({
  caseId,
  category: "algorithms",
  pass,
  failures: pass ? [] : ["oracle red"],
  durationMs: 5,
})

const BASE = "Solve the task. Keep the module compiling."
const BASELINE = { a: { pass: true, durationMs: 4 }, b: { pass: false, durationMs: 4 } }

describe("audit #337: forged or mismatched approvals are refused", () => {
  const proposalOf = () => ({
    id: "prompt-guidance-gate-lint",
    prompt: `${BASE}\n\nKnown pitfall: lint/no-unused-vars.`,
    before: BASE,
  })

  test("forged hash is refused even with the right proposal id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-audit-opt-"))
    const target = path.join(dir, "prompt.md")
    const approval: HumanApproval = {
      proposalId: proposalOf().id,
      promptHash: "deadbeef".repeat(8),
      approver: "human-director",
      signedAt: "2026-10-11T00:00:00.000Z",
    }
    await expect(applyPromptPatch({ proposal: proposalOf(), targetFile: target, approval })).rejects.toThrow(
      OptimizerError,
    )
    await expect(readFile(target, "utf8").catch(() => "missing")).resolves.toBe("missing")
    await rm(dir, { recursive: true, force: true })
  })

  test("mismatched proposal id is refused even with the right hash", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-audit-opt-"))
    const target = path.join(dir, "prompt.md")
    const proposal = proposalOf()
    const approval: HumanApproval = {
      proposalId: "optimizer-other-candidate",
      promptHash: hashPrompt(proposal.prompt),
      approver: "human-director",
      signedAt: "2026-10-11T00:00:00.000Z",
    }
    await expect(applyPromptPatch({ proposal, targetFile: target, approval })).rejects.toThrow(OptimizerError)
    await rm(dir, { recursive: true, force: true })
  })

  test("empty approver and bad timestamp are refused", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-audit-opt-"))
    const target = path.join(dir, "prompt.md")
    const proposal = proposalOf()
    const good: HumanApproval = {
      proposalId: proposal.id,
      promptHash: hashPrompt(proposal.prompt),
      approver: "human-director",
      signedAt: "2026-10-11T00:00:00.000Z",
    }
    await expect(
      applyPromptPatch({ proposal, targetFile: target, approval: { ...good, approver: "  " } }),
    ).rejects.toThrow(OptimizerError)
    await expect(
      applyPromptPatch({ proposal, targetFile: target, approval: { ...good, signedAt: "not-a-date" } }),
    ).rejects.toThrow(OptimizerError)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("audit #337: stub-grader full loop leaves assets untouched", () => {
  test("evolve + write proposals touches only the output dir", async () => {
    const assetsDir = path.join(import.meta.dir, "..", "assets", "prompts")
    const before: Record<string, string> = {}
    for (const name of await readdir(assetsDir)) {
      before[name] = await readFile(path.join(assetsDir, name), "utf8")
    }
    const grade = async (prompt: string) =>
      prompt.includes("lint/no-unused-vars")
        ? { attempts: [attempt("a", true), attempt("b", true)], costUSD: 0.02, steps: 6 }
        : { attempts: [attempt("a", true), attempt("b", false)], costUSD: 0.02, steps: 6 }
    const result = await evolvePrompts({
      basePrompt: BASE,
      basePromptId: "programmer",
      telemetry: telemetry(),
      baseline: BASELINE,
      grade,
    })
    expect(result.winners.length).toBeGreaterThan(0)
    const out = await mkdtemp(path.join(tmpdir(), "es-audit-opt-loop-"))
    const { written } = await writeOptimizerProposals(out, result, BASE)
    expect(written.length).toBe(result.winners.length)
    for (const entry of written) {
      expect(path.resolve(entry.dir).startsWith(`${path.resolve(out)}${path.sep}`)).toBe(true)
    }
    // Shipped assets are byte-identical after the full loop.
    for (const [name, content] of Object.entries(before)) {
      expect(await readFile(path.join(assetsDir, name), "utf8")).toBe(content)
    }
    // Candidates derive from telemetry signals only (no invented guidance).
    const candidates = generatePromptCandidates(BASE, telemetry())
    expect(candidates.some((c) => c.prompt.includes("lint/no-unused-vars"))).toBe(true)
    await rm(out, { recursive: true, force: true })
  })
})
