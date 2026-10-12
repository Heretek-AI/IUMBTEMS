// Audit proofs for the rigorous SWE benchmark suite (#336, built in #171).
//
//  1. Instance counts pinned against evals/benchmarks/README.md (16/12/12/14)
//     — the close comment on #171 says "five families"; the source has four
//     categories, and this test pins that shape.
//  2. Oracle invisibility: `benchmarkPrompt` (the only thing a model run is
//     given besides the seed files) carries no oracle file, no reference
//     solution and no expected values — for EVERY catalog case.
//  3. Determinism limit pinned: a deliberately slow but correct solution is
//     failed by the performance budget alone, so wall-clock timing CAN flip
//     a verdict (the budget is generous in practice, but it is not free).
//  4. `scripts/benchmarks.ts --model` without credentials skips cleanly with
//     exit 0 (never CI-blocking) — real process, no model, no spend.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { BENCHMARKS } from "../src/evals/benchmark-cases.ts"
import { type BenchmarkCase, benchmarkPrompt, gradeBenchmarkSolution } from "../src/evals/benchmarks.ts"
import { run } from "../src/util/proc.ts"

describe("audit #336: catalog counts match the README family split", () => {
  test("54 instances: 16 algorithms, 12 refactoring, 12 api-integration, 14 debugging", () => {
    const byCategory = new Map<string, number>()
    for (const item of BENCHMARKS) byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1)
    expect(BENCHMARKS.length).toBe(54)
    expect(byCategory.get("algorithms")).toBe(16)
    expect(byCategory.get("refactoring")).toBe(12)
    expect(byCategory.get("api-integration")).toBe(12)
    expect(byCategory.get("debugging")).toBe(14)
    // Four categories in source, not the five families #171's close comment claims.
    expect([...byCategory.keys()].sort()).toEqual(["algorithms", "api-integration", "debugging", "refactoring"])
  })
})

describe("audit #336: the model workspace never contains the oracle", () => {
  test("benchmarkPrompt ships only the seed files and names no expected value", () => {
    for (const testCase of BENCHMARKS) {
      const { prompt, files } = benchmarkPrompt(testCase)
      // Exactly the seed workspace: no added oracle/reference file.
      expect(Object.keys(files).sort()).toEqual(Object.keys(testCase.files).sort())
      expect(files).toEqual({ ...testCase.files })
      for (const key of Object.keys(files)) expect(key).not.toMatch(/oracle|reference|expected|baseline/i)
      // The reference solution text is nowhere in the prompt. (No parallel
      // claim holds for the seed files: refactoring seeds legitimately
      // contain working code — the oracle discriminates those via source
      // constraints, not via hiding the code — so files are pinned by the
      // byte-equality assertions above, not by substring checks.)
      const referenceEntry = testCase.reference[testCase.entry]
      if (referenceEntry !== undefined) expect(prompt).not.toContain(referenceEntry)
      // The prompt carries the task, not the oracle's expected values.
      for (const property of testCase.oracle.properties) {
        const rendered = JSON.stringify(property.expected)
        if (rendered !== undefined && rendered.length > 8) expect(prompt).not.toContain(rendered)
      }
    }
  })
})

describe("audit #336: the performance budget can flip a verdict", () => {
  const budgeted: BenchmarkCase = {
    id: "tiny-budget",
    category: "algorithms",
    difficulty: 1,
    description: "Add two numbers.",
    entry: "src/solution.ts",
    files: { "src/solution.ts": 'export function add(a: number, b: number): number {\n  throw new Error("stub")\n}\n' },
    oracle: {
      properties: [{ fn: "add", args: [2, 3], expected: 5 }],
      perfBudgetMs: 50,
    },
    reference: { "src/solution.ts": "export function add(a: number, b: number): number {\n  return a + b\n}\n" },
  }

  test("a slow but correct solution fails ONLY on the budget", async () => {
    const slow = {
      "src/solution.ts":
        "export function add(a: number, b: number): number {\n  const end = Date.now() + 250\n  while (Date.now() < end) {}\n  return a + b\n}\n",
    }
    const grade = await gradeBenchmarkSolution(budgeted, slow)
    expect(grade.pass).toBe(false)
    expect(grade.failures).toHaveLength(1)
    expect(grade.failures[0]).toMatch(/performance budget exceeded/)
  })
})

describe("audit #336: --model without credentials skips cleanly", () => {
  test("scripts/benchmarks.ts --model exits 0 with the skip notice (no spend, no block)", async () => {
    const root = path.resolve(import.meta.dir, "..", "..", "..")
    const { ES_EVAL_MODEL: _dropped, ...env } = process.env
    const result = await run(["bun", "scripts/benchmarks.ts", "--model"], {
      cwd: root,
      timeoutMs: 60_000,
      env: env as Record<string, string>,
    })
    expect(result.code).toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/skipping model runs/)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/ES_EVAL_MODEL is not set/)
  }, 90_000)
})
