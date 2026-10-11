// Engine integration for the mutation gate (#169): real `bun test` suites
// run against real mutants in a fixture repo.
import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { commandSetHash, GatesConfigSchema, runGates, trustProject } from "../src/index.ts"
import type { Fixture } from "./helpers.ts"
import { gitRepo } from "./helpers.ts"

const SOURCE = "export function sum(a: number, b: number): number {\n  return a + b\n}\n"
// Tautological: asserts the function against itself, so every mutant survives.
const TAUTOLOGICAL =
  'import { expect, test } from "bun:test"\nimport { sum } from "../src/sum.ts"\ntest("adds", () => expect(sum(2, 3)).toBe(sum(2, 3)))\n'
// Strong: pins real behaviour, so the arithmetic mutant is killed.
const STRONG =
  'import { expect, test } from "bun:test"\nimport { sum } from "../src/sum.ts"\ntest("adds", () => expect(sum(2, 3)).toBe(5))\n'

async function mutationFixture(suite: string): Promise<{ fx: Fixture; config: ReturnType<typeof mutationConfig> }> {
  const fx = await gitRepo("es-mutation-")
  await sealHumanKey("test-passphrase-1234", fx.state)
  const signer = await unlockHumanKey("test-passphrase-1234", fx.state)
  await mkdir(path.join(fx.root, "src"), { recursive: true })
  await mkdir(path.join(fx.root, "test"), { recursive: true })
  await writeFile(path.join(fx.root, "src/sum.ts"), SOURCE)
  await writeFile(path.join(fx.root, "test/sum.test.ts"), suite)
  const config = mutationConfig()
  const { hash, lines } = await commandSetHash(fx.root, config.commands)
  await trustProject(fx.root, hash, lines, { stateDir: fx.state, signer })
  return { fx, config }
}

const mutationConfig = () =>
  GatesConfigSchema.parse({
    commands: [{ id: "test", kind: "test", command: "bun test", parser: "bun-test", related: "bun" }],
    security: { gitleaks: "off", osv: "off" },
    mutation: { enabled: true, threshold: 0.8, maxMutants: 10 },
  })

describe("mutation gate in the engine", () => {
  test("a tautological suite is rejected with a mutation/kill-rate error", async () => {
    const { fx, config } = await mutationFixture(TAUTOLOGICAL)
    try {
      const report = await runGates({
        root: fx.root,
        scope: "touched",
        touched: ["src/sum.ts", "test/sum.test.ts"],
        config,
        stateDir: fx.state,
      })
      expect(report.passed).toBe(false)
      expect(report.checks.find((check) => check.id === "mutation")?.status).toBe("fail")
      expect(report.findings.some((finding) => finding.rule === "mutation/kill-rate")).toBe(true)
      // Mutants never leak: the source is restored after every mutant run.
      expect(await readFile(path.join(fx.root, "src/sum.ts"), "utf8")).toBe(SOURCE)
    } finally {
      await fx.cleanup()
    }
  })

  test("a strong suite kills its mutants and passes", async () => {
    const { fx, config } = await mutationFixture(STRONG)
    try {
      const report = await runGates({
        root: fx.root,
        scope: "touched",
        touched: ["src/sum.ts", "test/sum.test.ts"],
        config,
        stateDir: fx.state,
      })
      expect(report.findings.filter((finding) => finding.rule.startsWith("mutation/"))).toEqual([])
      expect(report.passed).toBe(true)
    } finally {
      await fx.cleanup()
    }
  })

  test("the mutation cache persists in the state dir", async () => {
    const { fx, config } = await mutationFixture(STRONG)
    try {
      await runGates({
        root: fx.root,
        scope: "touched",
        touched: ["src/sum.ts", "test/sum.test.ts"],
        config,
        stateDir: fx.state,
      })
      const cached = JSON.parse(await readFile(path.join(fx.state, "mutation-cache.json"), "utf8")) as Record<
        string,
        { hash: string; killed: string[]; total: number }
      >
      expect(Object.keys(cached)).toContain("src/sum.ts")
      expect(cached["src/sum.ts"]!.total).toBeGreaterThan(0)
    } finally {
      await fx.cleanup()
    }
  })

  test("the gate stays off unless enabled", async () => {
    const { fx } = await mutationFixture(TAUTOLOGICAL)
    try {
      const config = GatesConfigSchema.parse({
        commands: [{ id: "test", kind: "test", command: "bun test", parser: "bun-test", related: "bun" }],
        security: { gitleaks: "off", osv: "off" },
      })
      expect(config.mutation.enabled).toBe(false)
      const report = await runGates({
        root: fx.root,
        scope: "touched",
        touched: ["src/sum.ts", "test/sum.test.ts"],
        config,
        stateDir: fx.state,
      })
      expect(report.checks.some((check) => check.id === "mutation")).toBe(false)
    } finally {
      await fx.cleanup()
    }
  })
})
