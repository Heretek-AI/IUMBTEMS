// SWE benchmark runner (#171). Two modes, neither CI-blocking:
//
//   bun scripts/benchmarks.ts            oracle smoke: every reference must pass,
//                                        every seed must fail; writes
//                                        evals/benchmarks/baseline.json and prints
//                                        the delta against the previous baseline.
//                                        Fast, deterministic, model-free.
//
//   bun scripts/benchmarks.ts --model    dispatch one real model turn per case
//                                        (needs the opencode CLI and ES_EVAL_MODEL;
//                                        skips cleanly without them), grade the
//                                        phase worktree with the hidden oracle,
//                                        record pass@1 / spend / steps to
//                                        evals/benchmarks/results/ and print the
//                                        delta against the baseline.
//
// Model runs are spend-bearing and human-dispatched, like `bun run evals`.
import { accessSync, constants } from "node:fs"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { BENCHMARKS } from "../packages/core/src/evals/benchmark-cases.ts"
import {
  benchmarkReport,
  gradeBenchmarkSolution,
  readWorktreeSolution,
  recordBenchmarkRun,
  type BenchmarkAttempt,
  type BenchmarkBaseline,
} from "../packages/core/src/evals/benchmarks.ts"
import { caseStepCap, evalWorkspace, runEvalCase } from "../packages/core/src/evals/run.ts"

const root = path.resolve(import.meta.dir, "..")
const benchDir = path.join(root, "evals/benchmarks")
const baselineFile = path.join(benchDir, "baseline.json")
const resultsDir = path.join(benchDir, "results")
const modelMode = process.argv.includes("--model")
const stepCeiling = Number(process.env.ES_BENCH_MAX_STEPS || 24)
const timeoutMs = Number(process.env.ES_BENCH_TIMEOUT_MS || 300_000)
const budgetUSD = process.env.ES_BENCH_MAX_USD ? Number(process.env.ES_BENCH_MAX_USD) : undefined

const phaseState = (runId: string) =>
  JSON.stringify(
    {
      version: 2,
      runId,
      stage: "BUILD",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
      spendCeilingUSD: 15,
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
          worktree: ".factory/worktrees/phase-01",
          history: [],
        },
      ],
      activePhase: "phase-01",
      audits: [],
    },
    null,
    2,
  )

function resolveOnPath(binary: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    try {
      accessSync(path.join(dir, binary), constants.X_OK)
      return path.join(dir, binary)
    } catch {
      // not executable here; keep looking
    }
  }
  return undefined
}

async function readBaseline(): Promise<BenchmarkBaseline> {
  return JSON.parse(await readFile(baselineFile, "utf8").catch(() => "{}")) as BenchmarkBaseline
}

function printReport(label: string, attempts: readonly BenchmarkAttempt[], baseline: BenchmarkBaseline): void {
  const report = benchmarkReport(attempts, baseline)
  console.log(`--- ${label} ---`)
  console.log(`pass@1: ${(report.passAt1 * 100).toFixed(1)}% (${attempts.filter((a) => a.pass).length}/${attempts.length})`)
  for (const [category, rate] of Object.entries(report.passAt1ByCategory))
    console.log(`  ${category}: ${(rate * 100).toFixed(1)}%`)
  if (report.totalSpendUSD > 0) console.log(`spend: $${report.totalSpendUSD.toFixed(4)}`)
  if (report.avgSteps > 0) console.log(`avg steps: ${report.avgSteps.toFixed(1)}`)
  for (const id of report.regressions) console.log(`REGRESSION: ${id} (baseline green, now red)`)
  for (const id of report.fixes) console.log(`FIX: ${id} (baseline red, now green)`)
}

if (!modelMode) {
  // Oracle smoke: the oracle must accept every reference and reject every seed.
  const baseline: Record<string, { pass: boolean; durationMs: number }> = {}
  const attempts: BenchmarkAttempt[] = []
  const failures: string[] = []
  for (const testCase of BENCHMARKS) {
    const ref = await gradeBenchmarkSolution(testCase, testCase.reference)
    const seed = await gradeBenchmarkSolution(testCase, testCase.files)
    baseline[testCase.id] = { pass: ref.pass, durationMs: ref.durationMs }
    attempts.push({
      caseId: testCase.id,
      category: testCase.category,
      pass: ref.pass,
      failures: ref.failures,
      durationMs: ref.durationMs,
    })
    if (!ref.pass) failures.push(`reference red: ${testCase.id}: ${ref.failures.join("; ")}`)
    if (seed.pass) failures.push(`seed green (oracle blind): ${testCase.id}`)
  }
  const previous = await readBaseline()
  await mkdir(benchDir, { recursive: true })
  await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
  printReport("oracle smoke (references)", attempts, previous)
  if (failures.length) {
    for (const failure of failures) console.log(`FAIL: ${failure}`)
    process.exit(1)
  }
  console.log(`smoke green: ${BENCHMARKS.length} references pass, ${BENCHMARKS.length} seeds fail`)
  process.exit(0)
}

// Model mode: one real turn per case in an isolated workspace with a seeded
// BUILD run (the programmer shape from evals/cases/programmer.json), graded
// afterwards by the hidden oracle.
const binary = resolveOnPath("opencode")
const model = process.env.ES_EVAL_MODEL
if (!binary || !model) {
  console.log(
    `benchmarks: skipping model runs (${binary ? "" : "no opencode CLI on PATH; "}${model ? "" : "ES_EVAL_MODEL is not set"}).`,
  )
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const attempts: BenchmarkAttempt[] = []
let spentUSD = 0
for (const testCase of BENCHMARKS) {
  const runId = `run-benchmark-${testCase.id}`
  const worktree = ".factory/worktrees/phase-01"
  const seed: Record<string, string> = {
    ".factory/runtime/state.json": phaseState(runId),
    [`${worktree}/package.json`]: JSON.stringify({ name: `bench-${testCase.id}`, version: "1.0.0" }),
  }
  for (const [file, content] of Object.entries(testCase.files)) seed[`${worktree}/${file}`] = content
  const workspace = await evalWorkspace({ pluginDir: path.join(root, "packages/opencode"), model, files: seed })
  const maxSteps = caseStepCap(10 + testCase.difficulty * 4, stepCeiling)
  const remaining = budgetUSD === undefined ? undefined : budgetUSD - spentUSD
  if (remaining !== undefined && remaining <= 0) {
    console.log(`SKIP ${testCase.id} — spend budget used up`)
    await workspace.cleanup()
    continue
  }
  const prompt = [
    `Benchmark ${testCase.id} [${testCase.category}]: ${testCase.description}`,
    `Your phase worktree is ${worktree} (absolute path in es_status). Implement ${testCase.entry} inside the worktree so the described behaviour holds for all inputs, including edge cases, keeping the module compiling.`,
    "This run is headless: never call the question tool. Make independent tool calls in the same block.",
  ].join("\n")
  const result = await runEvalCase(
    { id: testCase.id, description: testCase.description, agent: "es-programmer", prompt, maxSteps },
    workspace,
    {
      binary,
      maxSteps,
      timeoutMs,
      ...(remaining !== undefined ? { budgetUSD: remaining } : {}),
    },
  )
  spentUSD += result.transcript.costUSD
  const solution = await readWorktreeSolution(workspace.dir, worktree)
  const grade = await gradeBenchmarkSolution(testCase, solution)
  const failures = [...result.failures, ...grade.failures]
  attempts.push({
    caseId: testCase.id,
    category: testCase.category,
    pass: failures.length === 0,
    failures,
    durationMs: grade.durationMs,
    steps: result.transcript.steps,
    costUSD: result.transcript.costUSD,
  })
  console.log(`${failures.length === 0 ? "PASS" : "FAIL"} ${testCase.id} (steps ${result.transcript.steps}, $${result.transcript.costUSD.toFixed(4)})`)
  if (failures.length === 0) await workspace.cleanup()
  else {
    const keep = path.join(resultsDir, stamp, testCase.id)
    await mkdir(keep, { recursive: true })
    await cp(workspace.dir, path.join(keep, "workspace"), { recursive: true })
    await writeFile(path.join(keep, "failures.json"), `${JSON.stringify(failures, null, 2)}\n`)
    await workspace.cleanup()
  }
}

const baseline = await readBaseline()
printReport(`model run ${stamp}`, attempts, baseline)
await recordBenchmarkRun(resultsDir, { id: stamp, at: new Date().toISOString(), attempts })
