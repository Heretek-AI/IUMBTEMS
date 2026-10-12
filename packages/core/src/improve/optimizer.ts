// Evolutionary prompt & cognitive strategy optimizer (#174).
//
// Systematic prompt optimization in the DSPy/GEPO spirit, driven by telemetry
// failure traces: recurring failure clusters become targeted candidate
// variations, candidates are graded against the benchmark suite in `evals/`,
// and only Pareto-dominating winners become reviewable proposals.
//
// FAIL-CLOSED and HUMAN-GATED by construction:
// - Signal-free telemetry yields no candidates (the optimizer never invents
//   variations without failure evidence), and a vacuous baseline (zero graded
//   attempts) is refused instead of proving non-degradation vacuously.
// - `writeOptimizerProposals` writes proposal dirs only. Shipped prompts are
//   never rewritten by any autonomous path: `applyPromptPatch` requires a
//   recorded human approval whose proposal id AND prompt hash match, and
//   throws otherwise. Human exercise (review + approval) is explicit.
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { type BenchmarkAttempt, type BenchmarkBaseline, benchmarkReport } from "../evals/benchmarks.ts"
import type { Telemetry } from "../schema/improve.ts"
import { compareStrings } from "../util/compare.ts"
import { atomicWrite, withLock } from "../util/fs.ts"
import { sha256, shortHash } from "../util/hash.ts"
import { clusterTelemetry } from "./distill.ts"

export class OptimizerError extends Error {
  override name = "OptimizerError"
}

export type PromptOperator = "append-guidance" | "trim-bloat" | "combine"

/** One candidate prompt variation with its lineage and rationale. */
export interface PromptCandidate {
  readonly id: string
  readonly parentIds: readonly string[]
  readonly operator: PromptOperator
  /** Targeted guidance lines this candidate adds (each names its signal). */
  readonly guidance: readonly string[]
  readonly prompt: string
  readonly rationale: string
}

/** A graded candidate: benchmark attempts plus the spend/steps it took. */
export interface PromptGrade {
  readonly attempts: readonly BenchmarkAttempt[]
  readonly costUSD: number
  readonly steps: number
}

/** Before/after benchmark receipt for one candidate. */
export interface OptimizerReceipt {
  readonly candidateId: string
  readonly passAt1: number
  readonly totalSpendUSD: number
  readonly avgSteps: number
  /** Baseline-green cases now red: any entry vetoes Pareto dominance. */
  readonly regressions: readonly string[]
  readonly fixes: readonly string[]
  /** Deterministic holdout split (#341): selection drives the win, the held-out part must not regress. */
  readonly selection: readonly string[]
  readonly holdout: readonly string[]
  /** Regressions on held-out cases: any entry vetoes the win even when selection dominates. */
  readonly holdoutRegressions: readonly string[]
  /** Baseline cases with no graded attempt: any entry vetoes the win (ungraded is not proof). */
  readonly ungraded: readonly string[]
}

/** A recorded human approval to apply one proposal to one prompt file. */
export interface HumanApproval {
  /** Must equal the proposal id being applied. */
  readonly proposalId: string
  /** Must equal `hashPrompt` of the proposed prompt. */
  readonly promptHash: string
  /** Non-empty human identity (who reviewed and signed). */
  readonly approver: string
  /** ISO timestamp of the human's sign-off. */
  readonly signedAt: string
}

/** A Pareto winner paired with its receipts, ready for proposal writing. */
export interface OptimizerWinner {
  readonly candidate: PromptCandidate
  readonly receipt: OptimizerReceipt
  readonly before: OptimizerReceipt
}

/** Content hash of a prompt (approval binding + deterministic ids). */
export const hashPrompt = (prompt: string): string => sha256(prompt)

/** Re-exported for the `es improve optimize` grader (CLI wiring, #341): the
 * benchmark catalog and the oracle graders it runs per candidate. */
export { BENCHMARKS } from "../evals/benchmark-cases.ts"
export { benchmarkPrompt, gradeBenchmarkSolution, readWorktreeSolution } from "../evals/benchmarks.ts"

const candidateId = (operator: PromptOperator, prompt: string): string =>
  `prompt-${operator}-${shortHash(hashPrompt(`${operator}:${prompt}`))}`

/** URL-safe slug without regular expressions (linear scan; no ReDoS surface). */
const slug = (text: string): string => {
  let out = ""
  let prevDash = true // Leading runs collapse to nothing (trimmed).
  for (const ch of text.toLowerCase()) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")
    if (ok) {
      out += ch
      prevDash = false
    } else if (!prevDash) {
      out += "-"
      prevDash = true
    }
  }
  if (out.endsWith("-")) out = out.slice(0, -1)
  return out.slice(0, 48) || "signal"
}

/**
 * Derive candidate prompt variations from telemetry failure clusters. Each
 * cluster becomes one `append-guidance` candidate whose guidance names the
 * failing rule/category/case, plus one `trim-bloat` candidate when the base
 * prompt already carries appended guidance (token reduction). Deterministic:
 * same inputs, same ids in the same order. Fail-closed: no clusters, no
 * candidates; an empty base prompt is refused.
 */
export function generatePromptCandidates(
  basePrompt: string,
  telemetry: Telemetry,
  options: { maxCandidates?: number } = {},
): PromptCandidate[] {
  if (!basePrompt.trim()) throw new OptimizerError("refusing to optimize an empty base prompt")
  const max = options.maxCandidates ?? 12
  if (!(max > 0)) throw new OptimizerError("maxCandidates must be positive")
  const clusters = clusterTelemetry(telemetry)
  const out: PromptCandidate[] = []
  for (const cluster of clusters) {
    if (out.length >= max) break
    const line = `Known pitfall (${cluster.kind} ${cluster.label}): re-check this before finishing.`
    if (basePrompt.includes(line)) continue
    const prompt = `${basePrompt.trimEnd()}\n\n${line}\n`
    out.push({
      id: candidateId("append-guidance", prompt),
      parentIds: [],
      operator: "append-guidance",
      guidance: [line],
      prompt,
      rationale:
        `Targets recurring ${cluster.kind} failure "${cluster.label}" ` +
        `(${cluster.occurrences}× across ${cluster.runIds.length} run(s), cluster ${cluster.key}).`,
    })
  }
  const bloat = basePrompt.split("\n").filter((line) => line.startsWith("Known pitfall"))
  if (bloat.length > 0 && out.length < max) {
    const prompt = `${basePrompt
      .split("\n")
      .filter((line) => !line.startsWith("Known pitfall"))
      .join("\n")
      .trimEnd()}\n`
    out.push({
      id: candidateId("trim-bloat", prompt),
      parentIds: [],
      operator: "trim-bloat",
      guidance: [],
      prompt,
      rationale: `Removes ${bloat.length} appended guidance line(s) to cut tokens; grades must show no regression.`,
    })
  }
  out.sort((a, b) => compareStrings(a.id, b.id))
  return out
}

/** Deterministic holdout split (#341): the sorted head (first third, at
 * least one case when there are two or more) is held out, the rest selects.
 * Same case ids always split the same way, however ordered. A single case
 * cannot be split: selection keeps it and the holdout stays empty.
 */
export interface HoldoutSplit {
  readonly selection: readonly string[]
  readonly holdout: readonly string[]
}

export function splitHoldout(caseIds: readonly string[]): HoldoutSplit {
  const sorted = [...new Set(caseIds)].sort(compareStrings)
  if (sorted.length < 2) return { selection: sorted, holdout: [] }
  const held = Math.max(1, Math.floor(sorted.length / 3))
  return { selection: sorted.slice(held), holdout: sorted.slice(0, held) }
}

/** Before/after receipt for one candidate's attempts against the baseline. */
export function receiptFor(
  candidateIdValue: string,
  attempts: readonly BenchmarkAttempt[],
  baseline: BenchmarkBaseline,
  totals?: { costUSD?: number; steps?: number },
): OptimizerReceipt {
  const report = benchmarkReport(attempts, baseline)
  const { selection, holdout } = splitHoldout(Object.keys(baseline))
  const held = new Set(holdout)
  const graded = new Set(attempts.map((attempt) => attempt.caseId))
  return {
    candidateId: candidateIdValue,
    passAt1: report.passAt1,
    totalSpendUSD: totals?.costUSD ?? report.totalSpendUSD,
    avgSteps: totals?.steps !== undefined ? totals.steps / Math.max(1, attempts.length) : report.avgSteps,
    regressions: [...report.regressions].sort(compareStrings),
    fixes: [...report.fixes].sort(compareStrings),
    selection: [...selection],
    holdout: [...holdout],
    holdoutRegressions: [...report.regressions].filter((caseId) => held.has(caseId)).sort(compareStrings),
    ungraded: Object.keys(baseline)
      .filter((caseId) => !graded.has(caseId))
      .sort(compareStrings),
  }
}

/**
 * Strict Pareto dominance: the candidate degrades no existing benchmark
 * (zero regressions) and is strictly better on at least one axis — higher
 * pass rate, or equal pass rate with lower spend/steps.
 */
export function paretoDominates(candidate: OptimizerReceipt, baseline: OptimizerReceipt): boolean {
  if (candidate.regressions.length > 0) return false
  if (candidate.passAt1 > baseline.passAt1) return true
  if (candidate.passAt1 < baseline.passAt1) return false
  return candidate.totalSpendUSD < baseline.totalSpendUSD || candidate.avgSteps < baseline.avgSteps
}

export interface EvolveInput {
  readonly basePrompt: string
  readonly basePromptId: string
  readonly telemetry: Telemetry
  readonly baseline: BenchmarkBaseline
  /** Grades one candidate prompt (model or stub); attempts must cover the baseline cases. */
  readonly grade: (prompt: string) => Promise<PromptGrade>
  readonly generations?: number
  readonly maxCandidates?: number
}

export interface EvolveResult {
  readonly basePromptId: string
  readonly baselineReceipt: OptimizerReceipt
  readonly receipts: OptimizerReceipt[]
  readonly winners: OptimizerWinner[]
  readonly dominated: OptimizerReceipt[]
  /** The deterministic holdout split every receipt in this run was gated on. */
  readonly selection: readonly string[]
  readonly holdout: readonly string[]
}

/**
 * Run the evolutionary loop: generate candidates, grade each against the
 * benchmark suite, keep holdout-gated winners, and breed one `combine`
 * generation from the winners' guidance. Fail-closed: a baseline with no
 * cases is refused (non-degradation must be proven, never vacuous), and
 * candidates grading zero attempts are dropped with a reason instead of
 * winning. Winners are selected on the holdout split (#341): Pareto
 * dominance on the selection cases plus zero regressions on the held-out
 * cases, with every baseline case graded (ungraded is not proof).
 */
export async function evolvePrompts(input: EvolveInput): Promise<EvolveResult> {
  const cases = Object.keys(input.baseline)
  if (cases.length === 0)
    throw new OptimizerError("refusing to evolve against an empty baseline (prove non-degradation)")
  const generations = input.generations ?? 1
  if (!Number.isInteger(generations) || generations < 1)
    throw new OptimizerError("generations must be a positive integer")
  const { selection, holdout } = splitHoldout(cases)
  const selected = new Set(selection)
  const held = new Set(holdout)
  const selectionBaseline: BenchmarkBaseline = Object.fromEntries(
    selection.map((caseId) => [caseId, input.baseline[caseId]!]),
  )
  const holdoutBaseline: BenchmarkBaseline = Object.fromEntries(
    holdout.map((caseId) => [caseId, input.baseline[caseId]!]),
  )
  const graded = async (
    candidate: PromptCandidate,
  ): Promise<{ receipt: OptimizerReceipt; attempts: readonly BenchmarkAttempt[] } | { dropped: string }> => {
    const result = await input.grade(candidate.prompt)
    if (result.attempts.length === 0) return { dropped: `${candidate.id}: graded zero attempts` }
    const receipt = receiptFor(candidate.id, result.attempts, input.baseline, {
      costUSD: result.costUSD,
      steps: result.steps,
    })
    return { receipt, attempts: result.attempts }
  }
  let population = generatePromptCandidates(input.basePrompt, input.telemetry, { maxCandidates: input.maxCandidates })
  const seen = new Map<string, PromptCandidate>(population.map((candidate) => [candidate.id, candidate]))
  // Baseline receipt first: every baseline case attempted once, graded
  // against itself (pass rate 1.0 on green cases, zero regressions).
  const baselineReceipt = receiptFor(
    "baseline",
    cases.map((caseId) => ({
      caseId,
      category: "algorithms" as const,
      pass: input.baseline[caseId]!.pass,
      failures: [],
      durationMs: input.baseline[caseId]!.durationMs,
    })),
    input.baseline,
  )
  const selectionBaselineReceipt = receiptFor(
    "baseline:selection",
    selection.map((caseId) => ({
      caseId,
      category: "algorithms" as const,
      pass: input.baseline[caseId]!.pass,
      failures: [],
      durationMs: input.baseline[caseId]!.durationMs,
    })),
    selectionBaseline,
  )
  // A win has to generalise: Pareto dominance on the selection cases (same
  // spend/steps as the full receipt — grading cost is global) with no
  // regressions on the held-out cases and no ungraded baseline case.
  const winsHoldout = (receipt: OptimizerReceipt, attempts: readonly BenchmarkAttempt[]): boolean => {
    if (receipt.ungraded.length > 0) return false
    const selectionAttempts = attempts.filter((attempt) => selected.has(attempt.caseId))
    const selectionReport = benchmarkReport(selectionAttempts, selectionBaseline)
    const selectionReceipt: OptimizerReceipt = {
      ...receipt,
      passAt1: selectionReport.passAt1,
      regressions: [...selectionReport.regressions].sort(compareStrings),
      fixes: [...selectionReport.fixes].sort(compareStrings),
    }
    if (!paretoDominates(selectionReceipt, selectionBaselineReceipt)) return false
    const holdoutAttempts = attempts.filter((attempt) => held.has(attempt.caseId))
    return benchmarkReport(holdoutAttempts, holdoutBaseline).regressions.length === 0
  }
  const receipts: OptimizerReceipt[] = []
  const attemptsById = new Map<string, readonly BenchmarkAttempt[]>()
  for (let generation = 0; generation < generations; generation++) {
    for (const candidate of population) {
      const gradedCandidate = await graded(candidate)
      if ("dropped" in gradedCandidate) continue
      receipts.push(gradedCandidate.receipt)
      attemptsById.set(gradedCandidate.receipt.candidateId, gradedCandidate.attempts)
    }
    if (generation + 1 >= generations) break
    // Breed one `combine` child from this generation's holdout winners.
    const winning = receipts.filter((receipt) => winsHoldout(receipt, attemptsById.get(receipt.candidateId) ?? []))
    const guidance = [...new Set(winning.flatMap((receipt) => seen.get(receipt.candidateId)?.guidance ?? []))]
    if (guidance.length < 2) break
    const prompt = `${input.basePrompt.trimEnd()}\n\n${guidance.join("\n")}\n`
    const child: PromptCandidate = {
      id: candidateId("combine", prompt),
      parentIds: winning.map((receipt) => receipt.candidateId),
      operator: "combine",
      guidance,
      prompt,
      rationale: `Generation ${generation + 2}: combines guidance from Pareto winner(s).`,
    }
    if (seen.has(child.id)) break
    seen.set(child.id, child)
    population = [child]
  }
  const winners: OptimizerWinner[] = []
  const dominated: OptimizerReceipt[] = []
  for (const receipt of receipts) {
    const before = { ...baselineReceipt, candidateId: receipt.candidateId }
    const candidate = seen.get(receipt.candidateId)
    if (candidate && winsHoldout(receipt, attemptsById.get(receipt.candidateId) ?? []))
      winners.push({ candidate, receipt, before })
    else dominated.push(receipt)
  }
  winners.sort((a, b) => compareStrings(a.candidate.id, b.candidate.id))
  dominated.sort((a, b) => compareStrings(a.candidateId, b.candidateId))
  return {
    basePromptId: input.basePromptId,
    baselineReceipt,
    receipts,
    winners,
    dominated,
    selection: [...selection],
    holdout: [...holdout],
  }
}

export interface WrittenOptimizerProposal {
  /** Proposal dir under the output root. */
  readonly dir: string
  readonly id: string
  readonly candidateId: string
}

/**
 * Write one proposal dir per holdout-gated winner: `proposal.json` (candidate +
 * before/after receipts, including the selection/holdout split), `prompt.patch.md`
 * (before/after diff), and `receipt.json`. Writes nowhere else — prompts are
 * never touched here. Dominated candidates land in `dropped.json` with their reasons.
 */
export async function writeOptimizerProposals(
  out: string,
  result: EvolveResult,
  basePrompt: string,
): Promise<{ written: WrittenOptimizerProposal[]; droppedFile: string }> {
  const written: WrittenOptimizerProposal[] = []
  for (const winner of result.winners) {
    const id = `optimizer-${slug(result.basePromptId)}-${winner.candidate.id}`
    const dir = path.join(out, id)
    await withLock(dir, async () => {
      await mkdir(dir, { recursive: true })
      // Hoisted payloads + concatenation: no object braces inside template
      // literals (keeps the missing-indicator lint quiet and stays readable).
      const proposalBody = {
        id,
        basePromptId: result.basePromptId,
        candidate: winner.candidate,
        before: winner.before,
        after: winner.receipt,
      }
      await atomicWrite(path.join(dir, "proposal.json"), `${JSON.stringify(proposalBody, null, 2)}\n`)
      await atomicWrite(
        path.join(dir, "prompt.patch.md"),
        [
          `# Prompt proposal ${id}`,
          "",
          `Operator: ${winner.candidate.operator}. Rationale: ${winner.candidate.rationale}`,
          "",
          `Pass rate ${winner.before.passAt1.toFixed(3)} → ${winner.receipt.passAt1.toFixed(3)}; `,
          `spend $${winner.before.totalSpendUSD.toFixed(4)} → $${winner.receipt.totalSpendUSD.toFixed(4)}; `,
          `steps ${winner.before.avgSteps.toFixed(1)} → ${winner.receipt.avgSteps.toFixed(1)}.`,
          `Regressions: ${winner.receipt.regressions.join(", ") || "none"}. Fixes: ${winner.receipt.fixes.join(", ") || "none"}.`,
          "",
          "## Before",
          "",
          "```",
          basePrompt,
          "```",
          "",
          "## After",
          "",
          "```",
          winner.candidate.prompt,
          "```",
          "",
          "_A human applies this after review; nothing here rewrites shipped prompts._",
          "",
        ].join("\n"),
      )
      const receiptBody = { before: winner.before, after: winner.receipt }
      await atomicWrite(path.join(dir, "receipt.json"), `${JSON.stringify(receiptBody, null, 2)}\n`)
    })
    written.push({ dir, id, candidateId: winner.candidate.id })
  }
  written.sort((a, b) => compareStrings(a.id, b.id))
  const droppedFile = path.join(out, "dropped.json")
  const droppedBody = result.dominated.map((receipt) => ({
    candidateId: receipt.candidateId,
    reasons:
      receipt.ungraded.length > 0
        ? [`ungraded: ${receipt.ungraded.join(", ")} (every baseline case must be graded)`]
        : receipt.holdoutRegressions.length > 0
          ? [`holdout regressions: ${receipt.holdoutRegressions.join(", ")}`]
          : receipt.regressions.length > 0
            ? [`regressions: ${receipt.regressions.join(", ")}`]
            : ["dominated: no axis strictly improves on selection"],
  }))
  await withLock(droppedFile, () => atomicWrite(droppedFile, `${JSON.stringify(droppedBody, null, 2)}\n`))
  return { written, droppedFile }
}

export interface ApplyInput {
  readonly proposal: { id: string; prompt: string; before: string }
  readonly targetFile: string
  /** Recorded human approval; absent or mismatched approvals refuse. */
  readonly approval?: HumanApproval
}

/**
 * Apply one reviewed proposal to a prompt file. HUMAN-GATED: without a
 * recorded approval whose proposal id, prompt hash and approver all verify,
 * this throws instead of writing. This is the only optimizer path that
 * writes outside proposal dirs, and it never runs autonomously.
 */
export async function applyPromptPatch(input: ApplyInput): Promise<{ targetFile: string; promptHash: string }> {
  const approval = input.approval
  if (!approval) throw new OptimizerError(`refusing to apply ${input.proposal.id} without a recorded human approval`)
  if (approval.proposalId !== input.proposal.id)
    throw new OptimizerError(`approval targets ${approval.proposalId}, not ${input.proposal.id}`)
  const promptHash = hashPrompt(input.proposal.prompt)
  if (approval.promptHash !== promptHash) throw new OptimizerError("approval hash does not match the proposed prompt")
  if (!approval.approver.trim()) throw new OptimizerError("approval needs a non-empty approver identity")
  if (Number.isNaN(Date.parse(approval.signedAt))) throw new OptimizerError("approval needs a valid signedAt timestamp")
  await mkdir(path.dirname(input.targetFile), { recursive: true })
  await atomicWrite(input.targetFile, input.proposal.prompt)
  return { targetFile: input.targetFile, promptHash }
}
