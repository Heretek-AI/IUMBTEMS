// Rigorous SWE benchmark suite (#171): deterministic oracle grading
// (compilation, property tests, performance budgets) over isolated software
// engineering problem instances, with pass@1 / spend / step / regression
// tracking. Oracle-only runs are fast and model-free (CI-safe smoke); model
// runs stay opt-in behind scripts/benchmarks.ts --model, never CI-blocking.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BENCHMARKS } from "../src/evals/benchmark-cases.ts"
import {
  type BenchmarkCase,
  benchmarkPrompt,
  benchmarkReport,
  gradeBenchmarkSolution,
  readBenchmarkRuns,
  readWorktreeSolution,
  recordBenchmarkRun,
} from "../src/evals/benchmarks.ts"

const tiny: BenchmarkCase = {
  id: "tiny-add",
  category: "algorithms",
  difficulty: 1,
  description: "Add two numbers.",
  entry: "src/solution.ts",
  files: { "src/solution.ts": 'export function add(a: number, b: number): number {\n  throw new Error("stub")\n}\n' },
  oracle: {
    properties: [
      { fn: "add", args: [2, 3], expected: 5 },
      { fn: "add", args: [-1, 1], expected: 0 },
    ],
    perfBudgetMs: 1000,
  },
  reference: { "src/solution.ts": "export function add(a: number, b: number): number {\n  return a + b\n}\n" },
}

describe("oracle grading", () => {
  test("a correct solution passes; a stub fails", async () => {
    const pass = await gradeBenchmarkSolution(tiny, tiny.reference)
    expect(pass.pass).toBe(true)
    expect(pass.failures).toEqual([])
    const fail = await gradeBenchmarkSolution(tiny, tiny.files)
    expect(fail.pass).toBe(false)
    expect(fail.failures.length).toBeGreaterThan(0)
  })

  test("a solution that does not compile fails closed", async () => {
    const grade = await gradeBenchmarkSolution(tiny, { "src/solution.ts": "export function add( broken (((\n" })
    expect(grade.pass).toBe(false)
    expect(grade.failures.some((failure) => failure.includes("compil"))).toBe(true)
  })

  test("source constraints are enforced", async () => {
    const constrained: BenchmarkCase = {
      ...tiny,
      id: "tiny-constrained",
      oracle: { properties: tiny.oracle.properties, mustContain: ["return a + b"], mustNotContain: ["throw"] },
    }
    expect((await gradeBenchmarkSolution(constrained, tiny.reference)).pass).toBe(true)
    const weak = await gradeBenchmarkSolution(constrained, {
      "src/solution.ts": "export function add(a: number, b: number): number {\n  return a + b // throw\n}\n",
    })
    expect(weak.pass).toBe(false)
  })
})

describe("catalog integrity", () => {
  test("at least 50 isolated instances across four categories", () => {
    expect(BENCHMARKS.length).toBeGreaterThanOrEqual(50)
    const byCategory = new Map<string, number>()
    for (const item of BENCHMARKS) byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1)
    for (const category of ["algorithms", "refactoring", "api-integration", "debugging"])
      expect(byCategory.get(category) ?? 0).toBeGreaterThanOrEqual(10)
  })

  test("ids are unique kebab-case; entries exist in seed and reference; oracles are non-empty", () => {
    const ids = new Set<string>()
    for (const item of BENCHMARKS) {
      expect(item.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(ids.has(item.id)).toBe(false)
      ids.add(item.id)
      expect([1, 2, 3]).toContain(item.difficulty)
      expect(item.description.length).toBeGreaterThan(0)
      expect(item.files[item.entry]).toBeDefined()
      expect(item.reference[item.entry]).toBeDefined()
      expect(item.oracle.properties.length + (item.oracle.mustContain?.length ?? 0)).toBeGreaterThan(0)
    }
  })
})

describe("oracle self-check (the smoke proof)", () => {
  test("every reference passes its oracle", async () => {
    const failures: string[] = []
    for (const item of BENCHMARKS) {
      const grade = await gradeBenchmarkSolution(item, item.reference)
      if (!grade.pass) failures.push(`${item.id}: ${grade.failures.join("; ")}`)
    }
    expect(failures).toEqual([])
  }, 300_000)

  test("every seed fails its oracle (the oracle discriminates)", async () => {
    const passing: string[] = []
    for (const item of BENCHMARKS) {
      const grade = await gradeBenchmarkSolution(item, item.files)
      if (grade.pass) passing.push(item.id)
    }
    expect(passing).toEqual([])
  }, 300_000)
})

describe("metrics and regression tracking", () => {
  test("benchmarkPrompt seeds the stub and names the entry", () => {
    const { prompt, files, maxSteps } = benchmarkPrompt(tiny)
    expect(prompt).toContain("tiny-add")
    expect(prompt).toContain("src/solution.ts")
    expect(files["src/solution.ts"]).toContain("stub")
    expect(maxSteps).toBeGreaterThan(0)
  })

  test("readWorktreeSolution collects a model-run worktree for grading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-bench-ws-"))
    try {
      await mkdir(path.join(dir, ".factory/worktrees/phase-01/src"), { recursive: true })
      await writeFile(path.join(dir, ".factory/worktrees/phase-01/src/solution.ts"), tiny.reference["src/solution.ts"]!)
      const solution = await readWorktreeSolution(dir, ".factory/worktrees/phase-01")
      expect(await gradeBenchmarkSolution(tiny, solution)).toMatchObject({ pass: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test("benchmarkReport computes pass@1, spend, steps and deltas", () => {
    const current = [
      {
        caseId: "a",
        category: "algorithms" as const,
        pass: true,
        failures: [],
        durationMs: 10,
        steps: 4,
        costUSD: 0.5,
      },
      {
        caseId: "b",
        category: "debugging" as const,
        pass: false,
        failures: ["x"],
        durationMs: 20,
        steps: 6,
        costUSD: 1.5,
      },
    ]
    const report = benchmarkReport(current, { a: { pass: false, durationMs: 9 }, b: { pass: false, durationMs: 9 } })
    expect(report.passAt1).toBe(0.5)
    expect(report.passAt1ByCategory.algorithms).toBe(1)
    expect(report.passAt1ByCategory.debugging).toBe(0)
    expect(report.totalSpendUSD).toBe(2)
    expect(report.avgSteps).toBe(5)
    expect(report.fixes).toEqual(["a"])
    expect(report.regressions).toEqual([])
    const regressed = benchmarkReport(current, { a: { pass: true, durationMs: 9 }, b: { pass: true, durationMs: 9 } })
    expect(regressed.regressions).toEqual(["b"])
    expect(regressed.fixes).toEqual([])
  })

  test("runs round-trip through the results store", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-bench-"))
    try {
      const file = await recordBenchmarkRun(dir, {
        id: "run-1",
        at: new Date(0).toISOString(),
        attempts: [{ caseId: "a", category: "algorithms", pass: true, failures: [], durationMs: 3 }],
      })
      expect(file.endsWith("results.jsonl")).toBe(true)
      const runs = await readBenchmarkRuns(dir)
      expect(runs.length).toBe(1)
      expect(runs[0]!.attempts[0]!.caseId).toBe("a")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
