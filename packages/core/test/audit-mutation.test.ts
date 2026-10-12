// Audit proofs for the AST mutation gate (#334, built in #169).
//
// Two behaviours the existing suites do not pin:
//  1. An interrupted (aborted) engine run restores every mutated source
//     byte-for-byte — the `try/finally` in `applyMutantAndRun` (engine.ts)
//     covers timeouts, runner errors AND signal aborts.
//  2. A suite that hangs on a mutant counts as a KILL (the timed-out check
//     reports `fail`, and `fail` kills the mutant) — not as a runner error.
// Plus: the zero-mutant case fails closed (kill rate 0, `mutation/kill-rate`
// error), which the claim explicitly promises.
import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { evaluateMutations, MUTATION_KILL_THRESHOLD, mutationFindings } from "../src/gates/mutation.ts"
import { commandSetHash, GatesConfigSchema, runGates, trustProject } from "../src/index.ts"
import type { Fixture } from "./helpers.ts"
import { gitRepo } from "./helpers.ts"

const SOURCE = "export function sum(a: number, b: number): number {\n  return a + b\n}\n"
const STRONG =
  'import { expect, test } from "bun:test"\nimport { sum } from "../src/sum.ts"\ntest("adds", () => expect(sum(2, 3)).toBe(5))\n'
// Hangs far past any gate timeout below: from the gate's perspective the
// suite never finishes on any source, mutant or not.
const HANGING = 'import { test } from "bun:test"\ntest("hangs", async () => {\n  await Bun.sleep(30_000)\n})\n'

async function mutationFixture(
  suite: string,
  overrides: { timeoutMs?: number; maxMutants?: number } = {},
): Promise<{ fx: Fixture; config: ReturnType<typeof mutationConfig> }> {
  const fx = await gitRepo("es-audit-mutation-")
  await sealHumanKey("test-passphrase-1234", fx.state)
  const signer = await unlockHumanKey("test-passphrase-1234", fx.state)
  await mkdir(path.join(fx.root, "src"), { recursive: true })
  await mkdir(path.join(fx.root, "test"), { recursive: true })
  await writeFile(path.join(fx.root, "src/sum.ts"), SOURCE)
  await writeFile(path.join(fx.root, "test/sum.test.ts"), suite)
  const config = mutationConfig(overrides)
  const { hash, lines } = await commandSetHash(fx.root, config.commands)
  await trustProject(fx.root, hash, lines, { stateDir: fx.state, signer })
  return { fx, config }
}

const mutationConfig = (overrides: { timeoutMs?: number; maxMutants?: number } = {}) =>
  GatesConfigSchema.parse({
    commands: [
      {
        id: "test",
        kind: "test",
        command: "bun test",
        parser: "bun-test",
        related: "bun",
        ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      },
    ],
    security: { gitleaks: "off", osv: "off" },
    mutation: { enabled: true, threshold: 0.8, maxMutants: overrides.maxMutants ?? 10 },
  })

describe("audit #334: source restoration under interruption", () => {
  test("an aborted mutation run leaves the working tree byte-identical", async () => {
    const { fx, config } = await mutationFixture(STRONG, { maxMutants: 5 })
    const controller = new AbortController()
    // Abort mid-run: the first mutant's suite is still in flight. Every
    // in-flight and later run resolves (abort kills the child; `close`
    // still resolves), and each `finally` restores the source.
    const timer = setTimeout(() => controller.abort(), 300)
    try {
      const report = await runGates({
        root: fx.root,
        scope: "touched",
        touched: ["src/sum.ts", "test/sum.test.ts"],
        config,
        stateDir: fx.state,
        signal: controller.signal,
      })
      expect(report).toBeDefined()
      expect(await readFile(path.join(fx.root, "src/sum.ts"), "utf8")).toBe(SOURCE)
    } finally {
      clearTimeout(timer)
      await fx.cleanup()
    }
  }, 60_000)
})

describe("audit #334: hanging suites kill, not error", () => {
  test("a suite that hangs on every mutant counts each mutant as killed", async () => {
    const { fx, config } = await mutationFixture(HANGING, { timeoutMs: 800, maxMutants: 2 })
    try {
      const report = await runGates({
        root: fx.root,
        scope: "touched",
        touched: ["src/sum.ts", "test/sum.test.ts"],
        config,
        stateDir: fx.state,
      })
      // The base suite times out, so the gates fail overall — but the
      // mutation check itself passes: every timed-out mutant run reports
      // `fail`, and `fail` kills the mutant (no `mutation/runner-error`).
      expect(report.findings.some((finding) => finding.rule === "test/timeout")).toBe(true)
      expect(report.checks.find((check) => check.id === "mutation")?.status).toBe("pass")
      expect(report.findings.filter((finding) => finding.rule === "mutation/runner-error")).toEqual([])
      expect(await readFile(path.join(fx.root, "src/sum.ts"), "utf8")).toBe(SOURCE)
    } finally {
      await fx.cleanup()
    }
  }, 120_000)
})

describe("audit #334: zero mutants fail closed", () => {
  test("no mutants means kill rate 0 and a mutation/kill-rate error, never a vacuous pass", () => {
    expect(MUTATION_KILL_THRESHOLD).toBe(0.8)
    const report = evaluateMutations([], MUTATION_KILL_THRESHOLD)
    expect(report.total).toBe(0)
    expect(report.killRate).toBe(0)
    expect(report.passed).toBe(false)
    const findings = mutationFindings({ ...report, threshold: MUTATION_KILL_THRESHOLD }, ["src/a.ts"])
    expect(findings.some((finding) => finding.severity === "error" && finding.rule === "mutation/kill-rate")).toBe(true)
    expect(findings[0]!.message).toMatch(/no mutants/)
  })
})
