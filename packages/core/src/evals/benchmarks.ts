// Rigorous SWE benchmark harness (#171): deterministic oracle grading over
// isolated problem instances. The oracle is threefold — compilation (a real
// bundle build of the entry), property tests (exported functions called with
// fixed args, deep-compared), and a performance budget over the property
// batch. Grading is in-process and model-free, so the smoke proof runs in CI;
// model runs stay opt-in behind scripts/benchmarks.ts --model, never
// CI-blocking. Catalog seeds are reviewed repo files (like eval seeds): they
// must terminate, which the self-check proves by completing.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export type BenchmarkCategory = "algorithms" | "refactoring" | "api-integration" | "debugging"

export interface BenchmarkProperty {
  readonly fn: string
  readonly args: readonly unknown[]
  readonly expected: unknown
}

export interface BenchmarkOracle {
  readonly properties: readonly BenchmarkProperty[]
  readonly mustContain?: readonly string[]
  readonly mustNotContain?: readonly string[]
  readonly perfBudgetMs?: number
}

export interface BenchmarkCase {
  readonly id: string
  readonly category: BenchmarkCategory
  readonly difficulty: 1 | 2 | 3
  readonly description: string
  /** Module the oracle imports, relative to the solution dir (e.g. "src/solution.ts"). */
  readonly entry: string
  /** Seed workspace: stubs or buggy code the agent must fix. */
  readonly files: Readonly<Record<string, string>>
  readonly oracle: BenchmarkOracle
  /** Verified solution (the smoke proof grades it green). */
  readonly reference: Readonly<Record<string, string>>
}

export interface BenchmarkGrade {
  readonly pass: boolean
  readonly failures: readonly string[]
  readonly durationMs: number
}

const deepEqual = (a: unknown, b: unknown): boolean => Bun.deepEquals(a, b, true)

/** Write the candidate into the grade dir; an escaping path fails closed. */
async function writeSolutionFiles(
  dir: string,
  solution: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  for (const [file, content] of Object.entries(solution)) {
    const target = path.join(dir, file)
    if (path.relative(dir, target).startsWith("..")) return `solution escapes the workspace: ${file}`
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return undefined
}

/** Bundle-build the entry and import it; failures name the compile break. */
async function loadCompiledEntry(
  dir: string,
  entry: string,
): Promise<{ module: Record<string, unknown> } | { failure: string }> {
  const entryAbs = path.join(dir, entry)
  const build = await Bun.build({ entrypoints: [entryAbs], outdir: path.join(dir, "dist"), target: "bun" }).catch(
    (error: Error) => ({ success: false as const, logs: error.message }),
  )
  if (build.success !== true) {
    const logs =
      "logs" in build
        ? String(build.logs)
        : Array.isArray((build as { logs?: unknown }).logs)
          ? (build as { logs: Array<{ message?: string }> }).logs.map((log) => log.message ?? String(log)).join("\n")
          : "build failed"
    return { failure: `does not compile: ${logs.slice(0, 500)}` }
  }
  const module = await import(`${entryAbs}?bench=${Date.now()}`).catch(() => undefined)
  if (module === undefined) return { failure: "does not compile: the entry cannot be imported" }
  return { module: module as Record<string, unknown> }
}

/** Call every oracle property against the module exports, deep-comparing results. */
async function runOracleProperties(
  module: Record<string, unknown>,
  oracle: BenchmarkOracle,
): Promise<{ failures: string[]; durationMs: number }> {
  const failures: string[] = []
  const started = Date.now()
  for (const property of oracle.properties) {
    const fn = module[property.fn]
    if (typeof fn !== "function") {
      failures.push(`missing export: ${property.fn}`)
      continue
    }
    let actual: unknown
    try {
      actual = await (fn as (...args: unknown[]) => unknown)(...property.args)
    } catch (error) {
      failures.push(
        `${property.fn}(${JSON.stringify(property.args)}) threw: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    if (!deepEqual(actual, property.expected))
      failures.push(
        `${property.fn}(${JSON.stringify(property.args)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(property.expected)}`,
      )
  }
  const durationMs = Date.now() - started
  const budget = oracle.perfBudgetMs ?? 5_000
  if (durationMs > budget)
    failures.push(
      `performance budget exceeded: ${durationMs}ms > ${budget}ms for ${oracle.properties.length} properties`,
    )
  return { failures, durationMs }
}

/** Source-shape constraints (refactoring/API-use bars) over the entry text. */
function checkSourceConstraints(entry: string, oracle: BenchmarkOracle): string[] {
  const failures: string[] = []
  for (const needle of oracle.mustContain ?? [])
    if (!entry.includes(needle)) failures.push(`solution must contain: ${needle}`)
  for (const needle of oracle.mustNotContain ?? [])
    if (entry.includes(needle)) failures.push(`solution must not contain: ${needle}`)
  return failures
}

/** A candidate solution fails closed when the entry does not compile or an export is missing. */
export async function gradeBenchmarkSolution(
  testCase: BenchmarkCase,
  solution: Readonly<Record<string, string>>,
): Promise<BenchmarkGrade> {
  const started = Date.now()
  const dir = await mkdtemp(path.join(tmpdir(), "es-benchmark-"))
  try {
    const escapeFailure = await writeSolutionFiles(dir, solution)
    if (escapeFailure !== undefined) return { pass: false, failures: [escapeFailure], durationMs: Date.now() - started }
    const loaded = await loadCompiledEntry(dir, testCase.entry)
    if ("failure" in loaded) return { pass: false, failures: [loaded.failure], durationMs: Date.now() - started }
    const ran = await runOracleProperties(loaded.module, testCase.oracle)
    const failures = [...ran.failures, ...checkSourceConstraints(solution[testCase.entry] ?? "", testCase.oracle)]
    return { pass: failures.length === 0, failures, durationMs: Date.now() - started }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface BenchmarkAttempt {
  readonly caseId: string
  readonly category: BenchmarkCategory
  readonly pass: boolean
  readonly failures: readonly string[]
  readonly durationMs: number
  /** Model-run steps (oracle-only runs omit spend/steps). */
  readonly steps?: number
  readonly costUSD?: number
}

export interface BenchmarkRun {
  readonly id: string
  readonly at: string
  readonly attempts: readonly BenchmarkAttempt[]
}

export interface BenchmarkBaseline {
  readonly [caseId: string]: { readonly pass: boolean; readonly durationMs: number }
}

export interface BenchmarkDelta {
  /** Share of cases passing on this run (pass@1: one attempt per case). */
  readonly passAt1: number
  readonly passAt1ByCategory: Record<BenchmarkCategory, number>
  readonly totalSpendUSD: number
  readonly avgSteps: number
  /** Baseline-green cases now red. */
  readonly regressions: readonly string[]
  /** Baseline-red cases now green. */
  readonly fixes: readonly string[]
}

/** Pass@1, spend, steps and the regression delta against the baseline. */
export function benchmarkReport(current: readonly BenchmarkAttempt[], baseline: BenchmarkBaseline): BenchmarkDelta {
  const passAt1ByCategory: Record<BenchmarkCategory, number> = {
    algorithms: 0,
    refactoring: 0,
    "api-integration": 0,
    debugging: 0,
  }
  const counts: Record<BenchmarkCategory, number> = {
    algorithms: 0,
    refactoring: 0,
    "api-integration": 0,
    debugging: 0,
  }
  let passed = 0
  let spend = 0
  let steps = 0
  let stepped = 0
  const regressions: string[] = []
  const fixes: string[] = []
  for (const attempt of current) {
    counts[attempt.category]++
    if (attempt.pass) {
      passed++
      passAt1ByCategory[attempt.category]++
    }
    if (typeof attempt.costUSD === "number") spend += Math.max(0, attempt.costUSD)
    if (typeof attempt.steps === "number") {
      steps += attempt.steps
      stepped++
    }
    const was = baseline[attempt.caseId]?.pass
    if (was === true && !attempt.pass) regressions.push(attempt.caseId)
    if (was === false && attempt.pass) fixes.push(attempt.caseId)
  }
  for (const category of Object.keys(passAt1ByCategory) as BenchmarkCategory[])
    passAt1ByCategory[category] = counts[category] ? passAt1ByCategory[category] / counts[category] : 0
  return {
    passAt1: current.length ? passed / current.length : 0,
    passAt1ByCategory,
    totalSpendUSD: spend,
    avgSteps: stepped ? steps / stepped : 0,
    regressions,
    fixes,
  }
}

const RESULTS_FILE = "results.jsonl"

/** Append one run to the results store; returns the store path. */
export async function recordBenchmarkRun(dir: string, run: BenchmarkRun): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, RESULTS_FILE)
  const existing = await readFile(file, "utf8").catch(() => "")
  await writeFile(file, `${existing}${JSON.stringify(run)}\n`)
  return file
}

/** Every recorded run, oldest first; a missing store reads as no runs. */
export async function readBenchmarkRuns(dir: string): Promise<BenchmarkRun[]> {
  const text = await readFile(path.join(dir, RESULTS_FILE), "utf8").catch(() => "")
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as BenchmarkRun)
}

/**
 * Collect a model-run worktree back into a solution map for grading: every
 * file under `worktree` (relative to the workspace root), capped so a runaway
 * run cannot exhaust the grader. Skips node_modules and dot-dirs.
 */
export async function readWorktreeSolution(
  root: string,
  worktree: string,
  limits: { maxFiles?: number; maxBytes?: number } = {},
): Promise<Record<string, string>> {
  const maxFiles = limits.maxFiles ?? 50
  const maxBytes = limits.maxBytes ?? 500_000
  const base = path.join(root, worktree)
  const out: Record<string, string> = {}
  let bytes = 0
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (Object.keys(out).length >= maxFiles || bytes >= maxBytes) return
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) {
        const content = await readFile(absolute, "utf8").catch(() => undefined)
        if (content === undefined || content.includes("\0")) continue
        out[path.relative(base, absolute).split(path.sep).join("/")] = content
        bytes += content.length
      }
    }
  }
  await walk(base)
  return out
}

/**
 * Convert a benchmark case into a model-run prompt: the seed workspace plus
 * a task statement naming the entry module and the behavioural bar. The
 * oracle stays hidden (it grades afterwards from the workspace on disk).
 */
export function benchmarkPrompt(testCase: BenchmarkCase): {
  prompt: string
  files: Record<string, string>
  maxSteps: number
} {
  return {
    prompt: [
      `Benchmark ${testCase.id} [${testCase.category}, difficulty ${testCase.difficulty}]: ${testCase.description}`,
      `Work in the module ${testCase.entry}; keep every other file as is.`,
      "Make the described behaviour hold for all inputs, including edge cases, and keep the module compiling.",
      "This run is headless: never call the question tool.",
    ].join("\n"),
    files: { ...testCase.files },
    maxSteps: 10 + testCase.difficulty * 4,
  }
}
