// AST mutation gate (#169): tautological tests must fail closed.
//
// A tautological test passes on buggy code because it expects the buggy
// behaviour. The mutation gate injects subtle AST mutants (negated
// conditions, mutated arithmetic, stripped calls) into touched code and runs
// the touched suite against each mutant. A suite that lets mutants survive
// has a low kill rate and the phase is rejected (kill rate < 80%).
import { describe, expect, test } from "bun:test"
import {
  evaluateMutations,
  generateMutants,
  MUTATION_KILL_THRESHOLD,
  type Mutant,
  mutantCacheKey,
  mutationFindings,
  runMutationGate,
} from "../src/gates/mutation.ts"

const killed = (mutants: readonly Mutant[], ids: readonly string[]) => {
  const set = new Set(ids)
  return mutants.map((mutant) => ({ mutant, killed: set.has(mutant.id) }))
}

describe("generateMutants", () => {
  test("negates conditions", () => {
    const mutants = generateMutants("src/a.ts", "export const ok = (a: number, b: number) => a === b && c !== d\n")
    expect(mutants.some((mutant) => mutant.kind === "condition")).toBe(true)
    expect(mutants.length).toBeGreaterThan(0)
  })

  test("mutates arithmetic", () => {
    const mutants = generateMutants("src/a.ts", "export const add = (a: number, b: number) => a + b\n")
    const arithmetic = mutants.filter((mutant) => mutant.kind === "arithmetic")
    expect(arithmetic.length).toBeGreaterThan(0)
    expect(arithmetic[0]!.mutated).toContain("a - b")
  })

  test("strips function calls", () => {
    const mutants = generateMutants("src/a.ts", "export function run() {\n  notify(user)\n  return done()\n}\n")
    expect(mutants.some((mutant) => mutant.kind === "call")).toBe(true)
  })

  test("each mutant carries its file, line and a changed source", () => {
    const source = "export const add = (a: number, b: number) => a + b\n"
    for (const mutant of generateMutants("src/a.ts", source)) {
      expect(mutant.file).toBe("src/a.ts")
      expect(mutant.line).toBeGreaterThanOrEqual(1)
      expect(mutant.mutated).not.toBe(source)
      expect(mutant.description.length).toBeGreaterThan(0)
    }
  })

  test("caps mutants per file", () => {
    const source = `${"export const x1 = a + b\n".repeat(40)}`
    expect(generateMutants("src/a.ts", source, 5).length).toBeLessThanOrEqual(5)
  })
})

describe("evaluateMutations", () => {
  test("kill rate is killed / total and the 80% threshold decides", () => {
    expect(MUTATION_KILL_THRESHOLD).toBe(0.8)
    const mutants = generateMutants("src/a.ts", "export const add = (a: number, b: number) => a + b\n")
    expect(mutants.length).toBeGreaterThan(0)
    const all = evaluateMutations(
      killed(
        mutants,
        mutants.map((mutant) => mutant.id),
      ),
      MUTATION_KILL_THRESHOLD,
    )
    expect(all.killRate).toBe(1)
    expect(all.passed).toBe(true)
    const none = evaluateMutations(killed(mutants, []), MUTATION_KILL_THRESHOLD)
    expect(none.killRate).toBe(0)
    expect(none.passed).toBe(false)
  })

  test("a tautological suite (zero kills) fails closed with an error finding", () => {
    const mutants = generateMutants("src/a.ts", "export const add = (a: number, b: number) => a + b\n")
    const report = evaluateMutations(killed(mutants, []), MUTATION_KILL_THRESHOLD)
    const findings = mutationFindings({ ...report, threshold: MUTATION_KILL_THRESHOLD }, ["src/a.ts"])
    expect(report.passed).toBe(false)
    expect(findings.some((finding) => finding.severity === "error" && finding.rule === "mutation/kill-rate")).toBe(true)
  })

  test("a strong suite at/above threshold passes with no error findings", () => {
    const mutants = generateMutants("src/a.ts", "export const add = (a: number, b: number) => a + b\n")
    const keep = mutants.slice(0, Math.ceil(mutants.length * MUTATION_KILL_THRESHOLD))
    const report = evaluateMutations(
      killed(
        mutants,
        keep.map((mutant) => mutant.id),
      ),
      MUTATION_KILL_THRESHOLD,
    )
    const findings = mutationFindings({ ...report, threshold: MUTATION_KILL_THRESHOLD }, ["src/a.ts"])
    expect(report.passed).toBe(true)
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([])
  })
})

describe("runMutationGate", () => {
  test("a tautological suite is rejected: the runner never observes a kill", async () => {
    const files = { "src/sum.ts": "export function sum(a: number, b: number): number {\n  return a + b\n}\n" }
    const report = await runMutationGate({
      files: Object.keys(files),
      readFile: async (file) => files[file as keyof typeof files],
      // Tautological: the suite asserts nothing real, so every mutant survives.
      runTests: async () => ({ killed: false }),
    })
    expect(report.total).toBeGreaterThan(0)
    expect(report.killRate).toBe(0)
    expect(report.passed).toBe(false)
  })

  test("a strong suite kills every mutant and passes", async () => {
    const files = { "src/sum.ts": "export function sum(a: number, b: number): number {\n  return a + b\n}\n" }
    const report = await runMutationGate({
      files: Object.keys(files),
      readFile: async (file) => files[file as keyof typeof files],
      runTests: async () => ({ killed: true }),
    })
    expect(report.passed).toBe(true)
    expect(report.killRate).toBe(1)
  })

  test("results are cached: unchanged files do not rerun the suite", async () => {
    const files = { "src/sum.ts": "export function sum(a: number, b: number): number {\n  return a + b\n}\n" }
    let runs = 0
    const options = {
      files: Object.keys(files),
      readFile: async (file: string) => files[file as keyof typeof files],
      runTests: async () => {
        runs++
        return { killed: true }
      },
    }
    const first = await runMutationGate(options)
    const firstRuns = runs
    expect(firstRuns).toBeGreaterThan(0)
    const second = await runMutationGate({ ...options, cache: first.cache })
    expect(second.cached).toContain("src/sum.ts")
    expect(runs).toBe(firstRuns)
    expect(second.killRate).toBe(first.killRate)
  })

  test("mutantCacheKey changes when the file content changes", () => {
    expect(mutantCacheKey("src/a.ts", "a + b")).not.toBe(mutantCacheKey("src/a.ts", "a - b"))
    expect(mutantCacheKey("src/a.ts", "same")).toBe(mutantCacheKey("src/a.ts", "same"))
  })

  test("changing a test file invalidates the cache: the suite reruns", async () => {
    let suite = "strong"
    let runs = 0
    const options = {
      files: ["src/sum.ts"],
      readFile: async (file: string) =>
        file === "src/sum.ts" ? "export function sum(a: number, b: number): number {\n  return a + b\n}\n" : suite,
      runTests: async () => {
        runs++
        return { killed: true }
      },
      testFiles: ["test/sum.test.ts"],
    }
    const first = await runMutationGate(options)
    expect(runs).toBeGreaterThan(0)
    // Same tests: cached, no rerun.
    await runMutationGate({ ...options, cache: first.cache })
    expect(runs).toBe(first.cache["src/sum.ts"]!.total)
    // Weakened tests: the fingerprint changes, so the suite reruns.
    suite = "weakened"
    const third = await runMutationGate({ ...options, cache: first.cache })
    expect(third.cached).not.toContain("src/sum.ts")
    expect(runs).toBeGreaterThan(first.cache["src/sum.ts"]!.total)
  })
})
