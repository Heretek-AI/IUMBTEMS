// Seeded-violation proof for the mechanical gates (audit #185, bug #239).
//
// Where gates.test.ts proves shapes with the sandbox, this suite proves the
// missing arms without it: the gate sandbox cannot mount its home overlay on
// btrfs (pre-existing reds in gates.test.ts, e.g. :329), so command checks run
// with the bwrap probe pinned to "missing" (sandbox "preferred" then runs the
// real binaries directly). The sandbox dimension itself is covered by the
// sandbox tests; everything asserted here — the exact file:line:rule — is the
// real command output through the real engine.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import {
  commandSetHash,
  formatReport,
  GatesConfigSchema,
  loadGatesConfig,
  recordWaiver,
  runGates,
  trustProject,
} from "../src/index.ts"
import { resetBwrapProbe, run } from "../src/util/proc.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

const BIOME = path.resolve(import.meta.dir, "../../../node_modules/.bin/biome")
const TSC = path.resolve(import.meta.dir, "../../../node_modules/typescript/bin/tsc")

let fx: Fixture
const PASSPHRASE = "test-passphrase-1234"
let signer: HumanSigner
beforeEach(async () => {
  fx = await gitRepo("es-gates-seeded-")
  await sealHumanKey(PASSPHRASE, fx.state)
  signer = await unlockHumanKey(PASSPHRASE, fx.state)
})
afterEach(() => fx.cleanup())

const write = async (file: string, text: string) => {
  await mkdir(path.dirname(path.join(fx.root, file)), { recursive: true })
  await writeFile(path.join(fx.root, file), text)
}
const commit = async (message: string) => {
  await run(["git", "add", "-A"], { cwd: fx.root })
  await run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], { cwd: fx.root })
  return (await run(["git", "rev-parse", "HEAD"], { cwd: fx.root })).stdout.trim()
}
const gates = (options: Partial<Parameters<typeof runGates>[0]> = {}) =>
  runGates({ root: fx.root, scope: "touched", stateDir: fx.state, ...options })
const config = (commands: unknown[], extra: Record<string, unknown> = {}) =>
  GatesConfigSchema.parse({ commands, security: { gitleaks: "off", osv: "off" }, ...extra })
const trust = async (cfg: ReturnType<typeof config>) => {
  const { hash, lines } = await commandSetHash(fx.root, cfg.commands)
  await trustProject(fx.root, hash, lines, { stateDir: fx.state, signer })
}
/** Run command checks with the real binaries but no sandbox (see header). */
const unprobed = async <T>(fn: () => Promise<T>): Promise<T> => {
  resetBwrapProbe(false)
  try {
    return await fn()
  } finally {
    resetBwrapProbe()
  }
}

describe("seeded command gates: fail and pass arms", () => {
  test("format: an unformatted file fails with file:rule; a formatted file passes", async () => {
    await write("biome.json", "{}\n")
    await write("src/a.ts", "export const x=1\nif( x==2){debugger}\n")
    await write("src/ok.ts", "export const ok = 1;\n")
    const cfg = config(
      [
        {
          id: "format",
          kind: "format",
          command: `${BIOME} format --reporter=json`,
          parser: "biome",
          touchedArgs: true,
          extensions: [".ts"],
        },
      ],
      { budgets: { requireTestWithBehavior: false } },
    )
    await trust(cfg)

    const failed = await unprobed(() => gates({ touched: ["src/a.ts"], config: cfg }))
    const finding = failed.findings.find((item) => item.rule === "format/biome")
    expect(finding).toMatchObject({ file: "src/a.ts", severity: "error" })
    expect(finding?.line).toBeUndefined()
    expect(failed.checks.find((check) => check.id === "format")?.status).toBe("fail")
    expect(failed.findings.some((item) => item.file === "src/ok.ts")).toBe(false)
    expect(formatReport(failed)).toContain("✗ src/a.ts format/biome")

    const passed = await unprobed(() => gates({ touched: ["src/ok.ts"], config: cfg }))
    expect(passed.checks.find((check) => check.id === "format")?.status).toBe("pass")
    expect(passed.findings.some((item) => item.rule === "format/biome")).toBe(false)
  })

  test("typecheck: a type error fails with file:line:rule; clean code passes", async () => {
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }))
    await write("src/b.ts", 'export const n: number = "oops";\n')
    await write("src/ok.ts", "export const ok: number = 1;\n")
    const cfg = config(
      [{ id: "typecheck", kind: "typecheck", command: `${TSC} --noEmit -p tsconfig.json`, parser: "tsc" }],
      { budgets: { requireTestWithBehavior: false } },
    )
    await trust(cfg)

    const failed = await unprobed(() => gates({ touched: ["src/b.ts"], config: cfg }))
    expect(failed.findings.find((item) => item.rule === "typecheck/TS2322")).toMatchObject({
      file: "src/b.ts",
      line: 1,
      severity: "error",
    })
    expect(failed.checks.find((check) => check.id === "typecheck")?.status).toBe("fail")
    expect(failed.findings.some((item) => item.file === "src/ok.ts")).toBe(false)

    // The typecheck command is project-wide: the pass arm needs the error gone.
    await write("src/b.ts", "export const n: number = 1;\n")
    const passed = await unprobed(() => gates({ touched: ["src/ok.ts"], config: cfg }))
    expect(passed.checks.find((check) => check.id === "typecheck")?.status).toBe("pass")
    expect(passed.findings.some((item) => item.rule.startsWith("typecheck/"))).toBe(false)
  })

  test("lint: noDebugger fails with file:line:rule; clean code passes", async () => {
    await write("biome.json", "{}\n")
    await write("src/a.ts", "export const x = 1;\ndebugger;\n")
    await write("src/ok.ts", "export const ok = 1;\n")
    const cfg = config(
      [
        {
          id: "lint",
          kind: "lint",
          command: `${BIOME} lint --reporter=json`,
          parser: "biome",
          touchedArgs: true,
          extensions: [".ts"],
        },
      ],
      { budgets: { requireTestWithBehavior: false } },
    )
    await trust(cfg)

    const failed = await unprobed(() => gates({ touched: ["src/a.ts"], config: cfg }))
    expect(failed.findings.find((item) => item.rule === "lint/suspicious/noDebugger")).toMatchObject({
      file: "src/a.ts",
      line: 2,
      severity: "error",
    })

    const passed = await unprobed(() => gates({ touched: ["src/ok.ts"], config: cfg }))
    expect(passed.checks.find((check) => check.id === "lint")?.status).toBe("pass")
    expect(passed.findings.some((item) => item.rule.startsWith("lint/"))).toBe(false)
  })

  test("test engine: a failing test fails with file:rule; the fixed suite passes", async () => {
    await write(
      "test/x.test.ts",
      'import { expect, test } from "bun:test"\ntest("adds", () => expect(1 + 1).toBe(3))\n',
    )
    const cfg = config([{ id: "test", kind: "test", command: "bun test", parser: "bun-test" }], {
      budgets: { requireTestWithBehavior: false },
    })
    await trust(cfg)

    const red = await unprobed(() => gates({ scope: "full", config: cfg }))
    expect(red.passed).toBe(false)
    expect(red.testsFailed).toBe(true)
    expect(red.failedTests).toEqual(["test/x.test.ts"])
    const finding = red.findings.find((item) => item.file === "test/x.test.ts")
    expect(finding).toMatchObject({ file: "test/x.test.ts", rule: "test/failed", severity: "error" })
    expect(finding?.message).toContain("adds")

    await write(
      "test/x.test.ts",
      'import { expect, test } from "bun:test"\ntest("adds", () => expect(1 + 1).toBe(2))\n',
    )
    const green = await unprobed(() => gates({ scope: "full", config: cfg }))
    expect(green.checks.find((check) => check.id === "test")?.status).toBe("pass")
    expect(green.testsFailed).toBe(false)
  })
})

describe("affected-test selection: one leaf change selects only its dependents", () => {
  test("graph path selects transitive importers; the fallback keeps the stem heuristic", async () => {
    await write("src/leaf.ts", "export const leaf = () => 1\n")
    await write("src/other.ts", "export const other = () => 2\n")
    await write("test/leaf-a.test.ts", 'import { leaf } from "../src/leaf"\ntest("a", () => {})\n')
    await write("test/leaf-b.test.ts", 'import { leaf } from "../src/leaf"\ntest("b", () => {})\n')
    await write("test/other.test.ts", 'import { other } from "../src/other"\ntest("o", () => {})\n')
    await write("src/lone.ts", "export const lone = 1\n")
    await write("src/lone.test.ts", '// does not import lone\ntest("lone", () => {})\n')
    await write("record.ts", 'await Bun.write("record.json", JSON.stringify(process.argv.slice(2)))\n')
    const cfg = config(
      [{ id: "test", kind: "test", command: "bun run record.ts", parser: "generic", related: "bun" }],
      {
        budgets: { requireTestWithBehavior: false },
      },
    )
    await trust(cfg)

    const graph = await unprobed(() => gates({ touched: ["src/leaf.ts"], config: cfg, structure: { regexOnly: true } }))
    expect(graph.passed).toBe(true)
    expect(JSON.parse(await Bun.file(path.join(fx.root, "record.json")).text())).toEqual([
      "./test/leaf-a.test.ts",
      "./test/leaf-b.test.ts",
    ])

    const fallback = await unprobed(() =>
      gates({ touched: ["src/lone.ts"], config: cfg, structure: { regexOnly: true } }),
    )
    expect(fallback.passed).toBe(true)
    expect(JSON.parse(await Bun.file(path.join(fx.root, "record.json")).text())).toEqual(["lone"])
  })
})

describe("seeded budget gates: fail and pass arms", () => {
  test("diff-size: an oversized diff fails with file '.', then passes under a bigger budget", async () => {
    await write("src/small.ts", "export const small = 1\n")
    const base = await commit("base")
    await write("src/grown.ts", `${Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i}`).join("\n")}\n`)
    const tight = config([], { budgets: { maxDiffLines: 5, requireTestWithBehavior: false } })
    const failed = await gates({ scope: "full", base, config: tight })
    expect(failed.findings.find((item) => item.rule === "budget/diff-size")).toMatchObject({
      file: ".",
      severity: "error",
    })

    const roomy = config([], { budgets: { maxDiffLines: 10_000, requireTestWithBehavior: false } })
    const passed = await gates({ scope: "full", base, config: roomy })
    expect(passed.findings.some((item) => item.rule === "budget/diff-size")).toBe(false)
  })

  test("file-length, complexity and test-with-behavior: each fails, then passes with the fix", async () => {
    await write("src/big.ts", `${Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}`).join("\n")}\n`)
    await write(
      "src/branchy.ts",
      `export function decide(x: number) {\n${Array.from({ length: 8 }, (_, i) => `  if (x === ${i} && x > -1) return ${i}`).join("\n")}\n  return -1\n}\n`,
    )
    await write("src/solo.ts", "export const solo = 1\n")
    const strict = config([], { budgets: { maxFileLines: 20, maxComplexity: 10 } })
    const failed = await gates({ touched: ["src/big.ts", "src/branchy.ts", "src/solo.ts"], config: strict })
    expect(failed.findings.find((item) => item.rule === "budget/file-length")).toMatchObject({
      file: "src/big.ts",
      line: 20,
      severity: "error",
    })
    const complexity = failed.findings.find((item) => item.rule === "budget/complexity")
    expect(complexity).toMatchObject({ file: "src/branchy.ts", line: 1, severity: "error" })
    expect(complexity?.message).toContain("decide")
    expect(failed.findings.find((item) => item.rule === "budget/test-with-behavior")).toMatchObject({
      file: "src/big.ts",
      severity: "error",
    })

    await write("test/big.test.ts", 'import { v0 } from "../src/big"\ntest("v", () => {})\n')
    const lenient = config([], { budgets: { maxFileLines: 1_000, maxComplexity: 1_000 } })
    const passed = await gates({ touched: ["src/big.ts", "src/branchy.ts", "test/big.test.ts"], config: lenient })
    expect(passed.findings.some((item) => item.rule.startsWith("budget/"))).toBe(false)
  })

  test("tool-config: a non-config change with a phase passes the tool-config check", async () => {
    const base = await commit("base")
    await write("src/feature.ts", "export const feature = 1\n")
    const report = await gates({ scope: "full", base, phaseId: "p1", config: config([]) })
    expect(report.findings.some((item) => item.rule === "integrity/tool-config-changed")).toBe(false)
  })

  test("schema/gates-config: a valid gates.json loads with no problem", async () => {
    await write(".factory/gates.json", JSON.stringify({ version: 1, commands: [] }))
    const { problem } = await loadGatesConfig(fx.root)
    expect(problem).toBeUndefined()
  })
})

describe("gitleaks shape and waiver glob edges", () => {
  const withFakeGitleaks = async <T>(fn: () => Promise<T>): Promise<T> => {
    const fakebin = path.join(fx.state, "fakebin")
    await mkdir(fakebin, { recursive: true })
    await writeFile(
      path.join(fakebin, "gitleaks"),
      '#!/bin/sh\nprintf \'[{"File": "src/leaky.ts", "StartLine": 3, "RuleID": "github-pat", "Description": "GitHub PAT"}]\'\n',
      { mode: 0o755 },
    )
    const previous = process.env.PATH ?? ""
    process.env.PATH = `${fakebin}${path.delimiter}${previous}`
    try {
      return await fn()
    } finally {
      process.env.PATH = previous
    }
  }

  test("gitleaks findings carry file:line:rule", async () => {
    await write("src/any.ts", "export const any = 1\n")
    const cfg = GatesConfigSchema.parse({
      commands: [],
      budgets: { requireTestWithBehavior: false },
      security: { gitleaks: "auto", osv: "off" },
    })
    const report = await withFakeGitleaks(() => gates({ touched: ["src/any.ts"], config: cfg }))
    expect(report.findings.find((item) => item.rule === "security/gitleaks-github-pat")).toMatchObject({
      file: "src/leaky.ts",
      line: 3,
      severity: "error",
    })
  })

  test("a rule+files glob waiver hides only what both globs match", async () => {
    const token = (name: string) => `export const ${name} = "ghp_Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"\n`
    await write("src/a.ts", token("a"))
    await write("other/b.ts", token("b"))
    await write("test/keep.test.ts", 'test("k", () => {})\n')
    const touched = ["src/a.ts", "other/b.ts", "test/keep.test.ts"]
    const cfg = config([])

    const exposed = await gates({ touched, config: cfg })
    expect(
      exposed.findings
        .filter((item) => item.rule === "security/secret-github-token")
        .map((item) => item.file)
        .sort(),
    ).toEqual(["other/b.ts", "src/a.ts"])

    await recordWaiver(fx.root, {
      id: "src-secrets",
      rule: "security/*",
      files: "src/**",
      reason: "fixture secrets under test",
      expiresAt: new Date(Date.now() + 86_400_000),
      channel: "cli",
      signer,
    })
    const waived = await gates({ touched, config: cfg })
    expect(waived.findings.some((item) => item.file === "src/a.ts")).toBe(false)
    expect(waived.findings.find((item) => item.rule === "security/secret-github-token")).toMatchObject({
      file: "other/b.ts",
      line: 1,
    })
    expect(waived.waived).toBe(1)

    await recordWaiver(fx.root, {
      id: "unrelated",
      rule: "budget/*",
      files: "**",
      reason: "matches nothing here",
      expiresAt: new Date(Date.now() + 86_400_000),
      channel: "cli",
      signer,
    })
    const again = await gates({ touched, config: cfg })
    expect(again.waived).toBe(1)
    expect(again.findings.some((item) => item.file === "other/b.ts")).toBe(true)
  })

  test("an already-expired waiver is refused at grant time", async () => {
    await expect(
      recordWaiver(fx.root, {
        id: "stale",
        rule: "**",
        reason: "expired before grant",
        expiresAt: new Date(Date.now() - 1_000),
        channel: "cli",
        signer,
      }),
    ).rejects.toThrow()
  })
})
