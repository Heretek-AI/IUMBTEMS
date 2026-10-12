// `es improve` (#135 harvest, #136 distill, #341 optimize): read-only
// telemetry harvest over run and eval dirs, deterministic distillation into
// reviewable proposals, and evolution of prompt candidates with a holdout
// split. Harvest, distill and export-dataset are agent-safe by construction —
// they only read the inputs and write the one `--out` location — so they stay
// out of HUMAN_VERBS in core. `optimize` grades candidates with model runs
// (spend-bearing), so it is human-only there and requires a `--max-usd` cap;
// without a terminal it refuses instead of spending anything.
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  type Args,
  BENCHMARKS,
  benchmarkPrompt,
  caseStepCap,
  compareStrings,
  type DistillThresholds,
  disposedWithReasons,
  distillProposals,
  evalWorkspace,
  evolvePrompts,
  exportDataset,
  factoryLayout,
  findExecutable,
  flag,
  git,
  gradeBenchmarkSolution,
  harvestTelemetry,
  harvestTrajectories,
  OptimizerError,
  type PromptGrade,
  type Proposal,
  readWorktreeSolution,
  renderProposalFiles,
  run,
  runEvalCase,
  type Telemetry,
  TelemetrySchema,
  undisposed,
  verifyAuditChain,
  type WorktreeInput,
  type WrittenProposal,
  writeDropped,
  writeOptimizerProposals,
  writeProposals,
} from "@heretek-ai/es-core"
import type { ConfirmIO } from "./tty.ts"
import { NotInteractive } from "./tty.ts"

const splitList = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)

export async function improveHarvest(args: Args, io: { print: (text: string) => void; cwd: string }): Promise<number> {
  const runs = splitList(flag(args, "runs")).map((dir) => path.resolve(io.cwd, dir))
  const evals = splitList(flag(args, "evals")).map((dir) => path.resolve(io.cwd, dir))
  if (runs.length === 0 && evals.length === 0) {
    io.print("Usage: es improve harvest --runs <dir>[,<dir>] [--evals <dir>[,<dir>]] --out <file>")
    return 2
  }
  const out = flag(args, "out")
  const telemetry = await harvestTelemetry({ runs, evals })
  const rendered = `${JSON.stringify(telemetry, null, 2)}\n`
  if (out) {
    const file = path.resolve(io.cwd, out)
    await writeFile(file, rendered)
    const rel = path.relative(io.cwd, file) || file
    io.print(
      `Harvested ${telemetry.runs.length} run(s) and ${telemetry.evals.length} eval(s) to ${rel} (telemetry v${telemetry.version}).`,
    )
    return 0
  }
  io.print(rendered.trimEnd())
  return 0
}

export interface ImproveIO {
  readonly print: (text: string) => void
  readonly cwd: string
  readonly confirm: ConfirmIO
}

/** Stage only the proposal dirs, commit on a topic branch and open a draft PR. Never pushes the base branch. */
export async function openProposalsPr(
  root: string,
  proposalDirs: readonly string[],
  options: {
    readonly base?: string
    readonly date?: string
    readonly run?: (argv: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  } = {},
): Promise<{ branch: string; url: string; staged: string[] }> {
  const exec = options.run ?? ((argv: readonly string[]) => run([...argv], { cwd: root, timeoutMs: 60_000 }))
  const auth = await exec(["gh", "auth", "status"])
  if (auth.code !== 0) throw new Error("gh is not authenticated (gh auth status failed); cannot open a draft PR.")
  const stamp = (options.date ?? new Date().toISOString().slice(0, 10)).replaceAll("-", "")
  const branch = `improve/${stamp}`
  const current = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
  const base = options.base ?? current.stdout.trim()
  if (!base) throw new Error("cannot determine the PR base branch")
  await git(root, ["checkout", "-b", branch])
  const staged = [...proposalDirs]
  staged.sort(compareStrings)
  await git(root, ["add", "--", ...staged])
  await git(root, ["commit", "-q", "-m", `Distilled improvement proposals (${staged.length})`])
  await git(root, ["push", "--set-upstream", "origin", `${branch}:${branch}`])
  const pr = await exec([
    "gh",
    "pr",
    "create",
    "--draft",
    "--head",
    branch,
    "--base",
    base,
    "--title",
    `Distilled improvement proposals (${stamp})`,
    "--body",
    prBody(root, staged),
  ])
  const url = prUrl(pr.stdout)
  if (pr.code !== 0 || !url) throw new Error("gh pr create failed")
  return { branch, url, staged }
}

const prBody = (root: string, staged: readonly string[]): string => {
  const entries = staged.map((dir) => `- ${path.relative(root, dir)}`)
  return [
    "Review-only proposals distilled from telemetry. Nothing is applied by merging this PR's branch alone;",
    "a human applies what they review.",
    "",
    ...entries,
  ].join("\n")
}

const prUrl = (stdout: string): string | undefined =>
  stdout
    .trim()
    .split("\n")
    .find((line) => /^https?:\/\//.test(line))

const readTelemetry = async (cwd: string, file: string): Promise<Telemetry> => {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path.resolve(cwd, file), "utf8"))
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = TelemetrySchema.safeParse(raw)
  if (!parsed.success)
    throw new Error(`Invalid telemetry in ${file}: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`)
  return parsed.data
}

const readThreshold = (args: Args, name: string): number | undefined => {
  const raw = flag(args, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Bad --${name}: takes a positive integer.`)
  return value
}

const distillThresholds = (args: Args): DistillThresholds => {
  const minOccurrences = readThreshold(args, "min-occurrences")
  const minRuns = readThreshold(args, "min-runs")
  return {
    ...(minOccurrences !== undefined ? { minOccurrences } : {}),
    ...(minRuns !== undefined ? { minRuns } : {}),
  }
}

const renderStanding = async (
  telemetry: Telemetry,
  thresholds: DistillThresholds,
  out: string,
): Promise<{
  proposals: Proposal[]
  standing: Proposal[]
  dropped: Array<{ proposal: Proposal; reasons: string[] }>
  written: WrittenProposal[]
  droppedFile: string
}> => {
  const proposals = await distillProposals(telemetry, thresholds)
  const standing = undisposed(proposals, telemetry)
  const dropped = disposedWithReasons(proposals, telemetry)
  const rendered = new Map<string, Record<string, string>>()
  const files = await Promise.all(standing.map((proposal) => renderProposalFiles(proposal.cluster)))
  for (const [index, proposal] of standing.entries()) rendered.set(proposal.id, files[index]!.files)
  const written = await writeProposals(out, standing, rendered)
  const droppedFile = await writeDropped(out, dropped)
  return { proposals, standing, dropped, written, droppedFile }
}

const openPr = async (
  args: Args,
  io: ImproveIO,
  root: string,
  written: WrittenProposal[],
  lines: string[],
): Promise<void> => {
  if (args.flags["open-pr"] !== true) return
  if (!io.confirm.interactive) throw new NotInteractive("es improve distill --open-pr")
  const base = flag(args, "base")
  try {
    const opened = await openProposalsPr(
      root,
      written.map((item) => item.dir),
      { ...(base ? { base } : {}) },
    )
    const target = base ?? "current branch"
    lines.push(
      `Draft PR: ${opened.url} (${opened.branch} → ${target}; ${opened.staged.length} proposal(s) staged, base never pushed).`,
    )
  } catch (error) {
    throw new Error(`Could not open a draft PR: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function improveDistill(args: Args, io: ImproveIO, root: string): Promise<number> {
  const telemetryFile = flag(args, "telemetry")
  if (!telemetryFile) {
    io.print("Usage: es improve distill --telemetry <file> --out <dir> [--open-pr] [--base <ref>]")
    return 2
  }
  let telemetry: Telemetry
  try {
    telemetry = await readTelemetry(io.cwd, telemetryFile)
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error))
    return 1
  }
  let thresholds: DistillThresholds
  try {
    thresholds = distillThresholds(args)
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error))
    return 2
  }
  const out = flag(args, "out") ? path.resolve(io.cwd, flag(args, "out")!) : factoryLayout(root).improveProposals
  const { proposals, standing, dropped, written, droppedFile } = await renderStanding(telemetry, thresholds, out)
  const disposed = proposals.length - standing.length
  const lines = [
    `Distilled ${proposals.length} proposal(s) (${standing.length} standing, ${disposed} disposed by the gate):`,
    ...written.map((item) => `  ${item.kind} ${item.id} (${item.cluster.occurrences}× ${item.cluster.key})`),
    // Dropped proposals are never silent: each is reported with its reason,
    // and `dropped.json` records them all (S3.5, #136).
    ...(dropped.length > 0
      ? [
          `Disposed by the gate (${dropped.length}):`,
          ...dropped.map(
            (entry) =>
              `  ${entry.proposal.kind} ${entry.proposal.id} (${entry.proposal.cluster.key}): ${entry.reasons.join("; ")}`,
          ),
          `Dropped details: ${path.relative(io.cwd, droppedFile) || droppedFile}.`,
        ]
      : []),
    `Wrote ${written.length} proposal(s) under ${path.relative(io.cwd, out) || out}. Nothing was applied.`,
  ]
  try {
    await openPr(args, io, root, written, lines)
  } catch (error) {
    if (error instanceof NotInteractive) throw error
    io.print([...lines, error instanceof Error ? error.message : String(error)].join("\n"))
    return 1
  }
  io.print(lines.join("\n"))
  return 0
}

/** Every gate summary.json under a .factory tree, deepest first in stable order. */
async function exportGateSummaries(factoryDir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(factoryDir)
  } catch {
    return []
  }
  const found: string[] = []
  for (const name of entries) {
    const full = path.join(factoryDir, name)
    const info = await stat(full).catch(() => undefined)
    if (info?.isDirectory() === true) found.push(...(await exportGateSummaries(full)))
    else if (name === "summary.json") found.push(full)
  }
  found.sort(compareStrings)
  return found
}

/**
 * Derive the harvester's verification attestation from on-disk evidence:
 * gates are green only when at least one gate summary exists and every one
 * passed, and the audit is valid only when the hash chain verifies over a
 * non-empty log (an empty log verifies vacuously, so it does not count).
 */
async function verifyWorktreeForExport(dir: string): Promise<WorktreeInput> {
  const summaries = await exportGateSummaries(path.join(dir, ".factory"))
  let gatesGreen = summaries.length > 0
  for (const file of summaries) {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
      if (typeof parsed !== "object" || parsed === null || (parsed as { passed?: unknown }).passed !== true) {
        gatesGreen = false
        break
      }
    } catch {
      gatesGreen = false
      break
    }
  }
  const chain = await verifyAuditChain(dir)
  return { dir, verification: { gatesGreen, auditValid: chain.valid && chain.entries.length > 0 } }
}

export async function improveExportDataset(
  args: Args,
  io: { print: (text: string) => void; cwd: string },
): Promise<number> {
  const usage =
    "Usage: es improve export-dataset --format jsonl --kind <sft|dpo> --worktrees <dir>[,<dir>] --output <path>"
  const format = flag(args, "format") ?? "jsonl"
  const kind = flag(args, "kind") ?? "sft"
  const dirs = splitList(flag(args, "worktrees")).map((dir) => path.resolve(io.cwd, dir))
  const output = flag(args, "output")
  if (dirs.length === 0 || !output) {
    io.print(usage)
    return 2
  }
  if (kind !== "sft" && kind !== "dpo") {
    io.print(`Bad --kind ${kind}: takes sft or dpo.\n${usage}`)
    return 2
  }
  const worktrees = await Promise.all(dirs.map((dir) => verifyWorktreeForExport(dir)))
  const { trajectories, skipped: harvestSkipped } = await harvestTrajectories({ worktrees })
  const file = path.resolve(io.cwd, output)
  try {
    const result = await exportDataset(trajectories, { format, kind, output: file })
    const rel = path.relative(io.cwd, file) || file
    io.print(
      [
        `Exported ${result.records} ${kind} record(s) from ${trajectories.length} trajector(y/ies) to ${rel} (+ manifest).`,
        ...[...harvestSkipped, ...result.skipped].map((entry) => `Skipped ${entry.worktree}: ${entry.reason}`),
      ].join("\n"),
    )
    return 0
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error))
    return 2
  }
}

// ------------------------------------------------- es improve optimize (#341)

export const OPTIMIZE_USAGE =
  "Usage: es improve optimize --telemetry <file> --prompt <file> [--prompt-id <id>] --baseline <file> --out <dir> --max-usd <USD> [--model <provider/model>] [--generations N] [--max-candidates N]"

/** One benchmark case graded with a candidate prompt (model spend + oracle verdict). */
export interface OptimizeCaseResult {
  readonly pass: boolean
  readonly failures: readonly string[]
  readonly durationMs: number
  readonly steps: number
  readonly costUSD: number
}

/** Runs one benchmark case with the candidate prompt. The default implementation
 * drives a real model turn in an isolated workspace and grades the worktree
 * with the hidden oracle; tests inject a stub. */
export interface OptimizeRunner {
  runCase(testCase: (typeof BENCHMARKS)[number], prompt: string, budgetUSD: number): Promise<OptimizeCaseResult>
}

export interface ModelGraderOptions {
  readonly cases: readonly (typeof BENCHMARKS)[number][]
  readonly runner: OptimizeRunner
  /** Hard spend ceiling (USD) across every candidate and generation. */
  readonly budgetUSD: number
}

/**
 * Grade every candidate on every case, tracking spend against the cap. The
 * cap is checked before each case: once it is reached the run halts with an
 * OptimizerError instead of overspending. Attempt order follows `cases`.
 */
export const makeModelGrader = (options: ModelGraderOptions): ((prompt: string) => Promise<PromptGrade>) => {
  let spent = 0
  return async (prompt: string): Promise<PromptGrade> => {
    const attempts: Array<{
      caseId: string
      category: "algorithms" | "refactoring" | "api-integration" | "debugging"
      pass: boolean
      failures: readonly string[]
      durationMs: number
      steps: number
      costUSD: number
    }> = []
    let costUSD = 0
    let steps = 0
    for (const testCase of options.cases) {
      const remaining = options.budgetUSD - spent
      if (!(remaining > 0))
        throw new OptimizerError(
          `spend cap $${options.budgetUSD} reached while grading ${testCase.id}; halted instead of overspending`,
        )
      const graded = await options.runner.runCase(testCase, prompt, remaining)
      const cost = Math.max(0, graded.costUSD)
      spent += cost
      costUSD += cost
      steps += graded.steps
      attempts.push({
        caseId: testCase.id,
        category: testCase.category,
        pass: graded.pass,
        failures: [...graded.failures],
        durationMs: graded.durationMs,
        steps: graded.steps,
        costUSD: graded.costUSD,
      })
    }
    return { attempts, costUSD, steps }
  }
}

const OPTIMIZE_WORKTREE = ".factory/worktrees/phase-01"

/** Seeded BUILD state for a grading workspace (the programmer shape from the benchmark runner). */
const optimizePhaseState = (runId: string, ceilingUSD: number): string =>
  JSON.stringify(
    {
      version: 2,
      runId,
      stage: "BUILD",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
      spendCeilingUSD: ceilingUSD,
      spend: { usd: 0, estimated: false, events: 0 },
      phases: [
        {
          id: "phase-01",
          title: "Benchmark solution",
          status: "building",
          goalHash: "benchmark",
          failures: 0,
          replanned: false,
          branch: `factory/${runId}/phase-phase-01`,
          worktree: OPTIMIZE_WORKTREE,
          history: [],
        },
      ],
      activePhase: "phase-01",
      audits: [],
    },
    null,
    2,
  )

/**
 * The production runner: one real model turn per case in an isolated
 * workspace, graded afterwards by the hidden oracle. The candidate prompt is
 * prepended to the benchmark task as in-context guidance (a first-wiring
 * approximation: it does not replace the seat's system prompt — filed as a
 * fidelity follow-up for the human). Spend per case is bounded by the
 * remaining cap; the run is killed at the first step over it.
 */
const modelRunner = (options: {
  binary: string
  model: string
  pluginDir: string
  maxSteps: number
  timeoutMs: number
}): OptimizeRunner => ({
  runCase: async (testCase, prompt, budgetUSD) => {
    const built = benchmarkPrompt(testCase)
    const fullPrompt = `${prompt}\n\n---\n\n${built.prompt}`
    const runId = `run-optimize-${testCase.id}`
    const seed: Record<string, string> = {
      ".factory/runtime/state.json": optimizePhaseState(runId, budgetUSD),
      [`${OPTIMIZE_WORKTREE}/package.json`]: JSON.stringify({ name: `bench-${testCase.id}`, version: "1.0.0" }),
    }
    for (const [file, content] of Object.entries(testCase.files)) seed[`${OPTIMIZE_WORKTREE}/${file}`] = content
    const workspace = await evalWorkspace({ pluginDir: options.pluginDir, model: options.model, files: seed })
    try {
      const maxSteps = caseStepCap(built.maxSteps, options.maxSteps)
      const result = await runEvalCase(
        { id: testCase.id, description: testCase.description, agent: "es-programmer", prompt: fullPrompt, maxSteps },
        workspace,
        { binary: options.binary, maxSteps, timeoutMs: options.timeoutMs, budgetUSD },
      )
      const solution = await readWorktreeSolution(workspace.dir, OPTIMIZE_WORKTREE)
      const grade = await gradeBenchmarkSolution(testCase, solution)
      const failures = [...result.failures, ...grade.failures]
      return {
        pass: failures.length === 0,
        failures,
        durationMs: grade.durationMs,
        steps: result.transcript.steps,
        costUSD: result.transcript.costUSD,
      }
    } finally {
      await workspace.cleanup()
    }
  },
})

/** Benchmark cases for the baseline ids, fail-closed on unknown or empty sets. */
const resolveBenchmarkCases = (baselineIds: readonly string[]): (typeof BENCHMARKS)[number][] => {
  const byId = new Map(BENCHMARKS.map((testCase) => [testCase.id, testCase] as const))
  const unknown = baselineIds.filter((id) => !byId.has(id))
  if (unknown.length > 0)
    throw new OptimizerError(
      `unknown benchmark case(s): ${unknown.sort(compareStrings).join(", ")} (grade only catalogued cases)`,
    )
  return baselineIds.map((id) => byId.get(id)!).sort((a, b) => compareStrings(a.id, b.id))
}

const readBaseline = async (
  cwd: string,
  file: string,
): Promise<Record<string, { pass: boolean; durationMs: number }>> => {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path.resolve(cwd, file), "utf8"))
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`Invalid baseline in ${file}: takes {caseId: {pass, durationMs}}.`)
  const out: Record<string, { pass: boolean; durationMs: number }> = {}
  for (const [caseId, entry] of Object.entries(raw as Record<string, unknown>)) {
    const pass = (entry as { pass?: unknown } | null)?.pass
    const durationMs = (entry as { durationMs?: unknown } | null)?.durationMs
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof pass !== "boolean" ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    )
      throw new Error(`Invalid baseline in ${file}: case "${caseId}" takes {pass: boolean, durationMs: number}.`)
    out[caseId] = { pass, durationMs }
  }
  return out
}

const defaultPromptId = (promptFile: string): string =>
  path.basename(promptFile).replace(/\.[^.]*$/, "") || "programmer"

export interface OptimizeOptions {
  /** Injected grader (tests); the human path grades with model runs. */
  readonly grade?: (prompt: string) => Promise<PromptGrade>
}

/**
 * Human-only `es improve optimize`: evolve prompt candidates from telemetry
 * failure clusters, grade each against the benchmark baseline with a
 * deterministic holdout split (selection wins must not regress held-out
 * cases), and write review-only proposal dirs with before/after receipts.
 * Changes no prompt file; there is no apply verb here — `applyPromptPatch`
 * keeps refusing without a recorded human approval.
 */
export async function improveOptimize(
  args: Args,
  io: ImproveIO,
  root: string,
  options: OptimizeOptions = {},
): Promise<number> {
  const telemetryFile = flag(args, "telemetry")
  const promptFile = flag(args, "prompt")
  const baselineFile = flag(args, "baseline")
  if (!telemetryFile || !promptFile || !baselineFile) {
    io.print(OPTIMIZE_USAGE)
    return 2
  }
  const rawCap = flag(args, "max-usd")
  const cap = rawCap === undefined ? Number.NaN : Number(rawCap)
  if (!(cap > 0)) {
    io.print("es improve optimize needs a spend ceiling (grading runs model turns). Give one: --max-usd <USD>.")
    return 2
  }
  let generations = 1
  let maxCandidates = 12
  try {
    const parsedGenerations = readThreshold(args, "generations")
    const parsedMax = readThreshold(args, "max-candidates")
    if (parsedGenerations !== undefined) generations = parsedGenerations
    if (parsedMax !== undefined) maxCandidates = parsedMax
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error))
    return 2
  }
  let telemetry: Telemetry
  try {
    telemetry = await readTelemetry(io.cwd, telemetryFile)
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error))
    return 1
  }
  let basePrompt: string
  try {
    basePrompt = await readFile(path.resolve(io.cwd, promptFile), "utf8")
  } catch (error) {
    io.print(`Cannot read ${promptFile}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  let baseline: Record<string, { pass: boolean; durationMs: number }>
  try {
    baseline = await readBaseline(io.cwd, baselineFile)
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error))
    return 1
  }
  const basePromptId = flag(args, "prompt-id")?.trim() || defaultPromptId(promptFile)
  const out = flag(args, "out") ? path.resolve(io.cwd, flag(args, "out")!) : factoryLayout(root).improveProposals
  let grade = options.grade
  if (!grade) {
    // Real spend below: refuse without a terminal instead of grading blindly.
    if (!io.confirm.interactive) throw new NotInteractive("es improve optimize")
    const model = flag(args, "model") ?? process.env.ES_EVAL_MODEL
    if (!model) {
      io.print("Model grading needs a model. Give one: --model <provider/model> (or set ES_EVAL_MODEL).")
      return 2
    }
    const binary = findExecutable("opencode")
    if (!binary) {
      io.print("The opencode CLI is not installed or not on PATH; nothing was graded.")
      return 2
    }
    const pluginDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "opencode")
    const pluginPkg = await stat(path.join(pluginDir, "package.json"))
      .then((info) => info.isFile())
      .catch(() => false)
    if (!pluginPkg) {
      io.print("Model grading needs the local OpenCode plugin checkout (packages/opencode); nothing was graded.")
      return 1
    }
    let cases: (typeof BENCHMARKS)[number][]
    try {
      cases = resolveBenchmarkCases(Object.keys(baseline))
    } catch (error) {
      io.print(error instanceof Error ? error.message : String(error))
      return 1
    }
    if (cases.length === 0) {
      io.print("Refusing to evolve against an empty baseline (prove non-degradation).")
      return 1
    }
    const maxSteps = Number(process.env.ES_BENCH_MAX_STEPS || 24)
    const timeoutMs = Number(process.env.ES_BENCH_TIMEOUT_MS || 300_000)
    io.print(
      `Grading candidates for ${basePromptId} on ${cases.length} benchmark case(s) with up to $${cap} (${model}).`,
    )
    grade = makeModelGrader({
      cases,
      runner: modelRunner({ binary, model, pluginDir, maxSteps, timeoutMs }),
      budgetUSD: cap,
    })
  }
  let result: Awaited<ReturnType<typeof evolvePrompts>>
  try {
    result = await evolvePrompts({
      basePrompt,
      basePromptId,
      telemetry,
      baseline,
      grade,
      generations,
      maxCandidates,
    })
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error))
    return 1
  }
  const { written, droppedFile } = await writeOptimizerProposals(out, result, basePrompt)
  const lines = [
    `Optimized ${basePromptId}: graded ${result.receipts.length} candidate(s) ` +
      `(selection ${result.selection.join(", ") || "none"}; holdout ${result.holdout.join(", ") || "none"}), ` +
      `${result.winners.length} winner(s).`,
    ...result.winners.map(
      (winner) =>
        `  ${winner.candidate.id}: pass ${winner.before.passAt1.toFixed(3)} → ${winner.receipt.passAt1.toFixed(3)}`,
    ),
    ...(result.dominated.length > 0
      ? [
          `Dominated (${result.dominated.length}):`,
          ...result.dominated.map((receipt) => `  ${receipt.candidateId}`),
          `Dropped details: ${path.relative(io.cwd, droppedFile) || droppedFile}.`,
        ]
      : []),
    `Wrote ${written.length} proposal(s) under ${path.relative(io.cwd, out) || out}. Nothing was applied.`,
  ]
  io.print(lines.join("\n"))
  return 0
}
