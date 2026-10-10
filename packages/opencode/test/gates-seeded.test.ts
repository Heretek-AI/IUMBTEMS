// Seeded-violation proof for the mechanical gates through the real
// `es_gates_run` tool on the testkit host (audit #185 §2): a fixture repo per
// gate with a seeded violation, driven from the programmer seat, asserting the
// exact file:line:rule.
//
// Command checks (format/lint/typecheck/test binaries) are covered at the
// engine level in packages/core/test/gates-seeded.test.ts: the gate sandbox
// cannot mount its home overlay on btrfs, so sandboxed commands fail in this
// environment. Every gate here runs with `commands: []`, so no trust ceremony
// is needed and the sandbox is never engaged; what is asserted is the real
// tool output of the real gate engine.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  approveStage,
  Factory,
  gateRunner,
  type HumanSigner,
  rebaseline,
  recordWaiver,
  researchSourcesDir,
  SourceCache,
  sealHumanKey,
  stringifyFrontmatter,
  unlockHumanKey,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const TYPESCRIPT = path.resolve(import.meta.dir, "../../../node_modules/typescript")
const TOKEN = `ghp_${"Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"}`
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

/** Drive es_gates_run from the programmer seat; return the report text. */
const gatesText = async (h: Harness, args: Record<string, unknown>) => {
  const { tools } = await h.run(call("es_gates_run", args), { agent: "es-programmer" })
  return { status: tools[0]?.status ?? "missing", text: tools[0]?.text ?? "" }
}

/** The single report line carrying `rule`; the caller asserts file:line on it. */
const lineWith = (text: string, rule: string) => text.split("\n").find((line) => line.includes(rule)) ?? ""

describe("seeded built-in gates via es_gates_run (programmer seat)", () => {
  let h: Harness
  let state: string
  const setGates = (config: Record<string, unknown>) =>
    write(h.directory, ".factory/gates.json", JSON.stringify(config))

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-gates-seeded-state-"))
    await sealHumanKey("test-passphrase-1234", state)
    await unlockHumanKey("test-passphrase-1234", state)
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: {
        "README.md": "# seeded gates\n",
        ".gitignore": "node_modules/\n",
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noEmit: true },
          include: ["src"],
        }),
        "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      },
    })
    await mkdir(path.join(h.directory, "node_modules/.bin"), { recursive: true })
    await symlink(TYPESCRIPT, path.join(h.directory, "node_modules/typescript"), "dir")
    await symlink(path.join(TYPESCRIPT, "bin/tsc"), path.join(h.directory, "node_modules/.bin/tsc"))
    const factory = new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
    await factory.provisionRun("tester", 10)
  }, 120_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("a hardcoded token fails with src/config.ts:1 security/secret-github-token", async () => {
    await setGates({
      commands: [],
      budgets: { requireTestWithBehavior: false },
      security: { gitleaks: "off", osv: "off" },
    })
    await write(h.directory, "src/config.ts", `export const token = "${TOKEN}";\n`)
    await write(h.directory, "test/keep.test.ts", 'test("k", () => {});\n')
    const { status, text } = await gatesText(h, { files: ["src/config.ts", "test/keep.test.ts"] })
    expect(status).toBe("completed")
    expect(text).toContain("Gates failed")
    const line = lineWith(text, "security/secret-github-token")
    expect(line).toContain("src/config.ts:1")
  }, 60_000)

  test("a clean tree passes the same gates", async () => {
    await write(h.directory, "src/config.ts", "export const configured = true;\n")
    await write(h.directory, "test/keep.test.ts", "export const keeper = 1;\n")
    const { text } = await gatesText(h, { files: ["src/config.ts", "test/keep.test.ts"] })
    expect(text).toContain("Gates passed")
    expect(text).toContain("0 error(s)")
    expect(text).not.toContain("security/secret-github-token")
  }, 60_000)

  test("an oversized module fails with src/big.ts:20 budget/file-length", async () => {
    await setGates({
      commands: [],
      budgets: { maxFileLines: 20, requireTestWithBehavior: false },
      security: { gitleaks: "off", osv: "off" },
    })
    await write(
      h.directory,
      "src/big.ts",
      `${Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`,
    )
    const { text } = await gatesText(h, { files: ["src/big.ts", "test/keep.test.ts"] })
    const line = lineWith(text, "budget/file-length")
    expect(line).toContain("src/big.ts:20")

    await setGates({ commands: [], security: { gitleaks: "off", osv: "off" } })
    const { text: clean } = await gatesText(h, { files: ["src/big.ts", "test/keep.test.ts"] })
    expect(clean).not.toContain("budget/file-length")
  }, 60_000)

  test("a branchy function fails with src/branchy.ts:1 budget/complexity", async () => {
    await setGates({
      commands: [],
      budgets: { maxComplexity: 10, requireTestWithBehavior: false },
      security: { gitleaks: "off", osv: "off" },
    })
    await write(
      h.directory,
      "src/branchy.ts",
      `export function decide(x: number): number {\n${Array.from({ length: 8 }, (_, i) => `  if (x === ${i} && x > -1) return ${i};`).join("\n")}\n  return -1;\n}\n`,
    )
    const { text } = await gatesText(h, { files: ["src/branchy.ts", "test/keep.test.ts"] })
    const line = lineWith(text, "budget/complexity")
    expect(line).toContain("src/branchy.ts:1")
    expect(line).toContain("decide")
  }, 60_000)

  test("a behaviour change without a test fails with budget/test-with-behavior", async () => {
    await setGates({ commands: [], security: { gitleaks: "off", osv: "off" } })
    await write(h.directory, "src/solo.ts", "export const solo = 1;\n")
    const { text } = await gatesText(h, { files: ["src/solo.ts"] })
    const line = lineWith(text, "budget/test-with-behavior")
    expect(line).toContain("src/solo.ts")

    await write(h.directory, "test/solo.test.ts", 'test("s", () => {});\n')
    const { text: clean } = await gatesText(h, { files: ["src/solo.ts", "test/solo.test.ts"] })
    expect(clean).not.toContain("budget/test-with-behavior")
  }, 60_000)

  test("a type error fails with src/main.ts:2 lsp/ts-2322", async () => {
    await setGates({
      commands: [],
      budgets: { requireTestWithBehavior: false },
      security: { gitleaks: "off", osv: "off" },
    })
    await write(h.directory, "src/main.ts", 'import { add } from "./math.js";\nexport const bad: string = add(1, 2);\n')
    const { text } = await gatesText(h, { files: ["src/main.ts", "test/keep.test.ts"] })
    const line = lineWith(text, "lsp/")
    expect(line).toContain("src/main.ts:2")
    expect(line).toContain("lsp/ts-2322")
  }, 120_000)

  test("a gitleaks report becomes file:line:rule", async () => {
    const fakebin = path.join(state, "fakebin")
    await mkdir(fakebin, { recursive: true })
    await writeFile(
      path.join(fakebin, "gitleaks"),
      '#!/bin/sh\nprintf \'[{"File": "src/leaky.ts", "StartLine": 3, "RuleID": "github-pat", "Description": "GitHub PAT"}]\'\n',
      { mode: 0o755 },
    )
    const previous = process.env.PATH ?? ""
    process.env.PATH = `${fakebin}${path.delimiter}${previous}`
    try {
      await setGates({
        commands: [],
        budgets: { requireTestWithBehavior: false },
        security: { gitleaks: "auto", osv: "off" },
      })
      await write(h.directory, "src/any.ts", "export const any = 1;\n")
      const { text } = await gatesText(h, { files: ["src/any.ts", "test/keep.test.ts"] })
      const line = lineWith(text, "security/gitleaks-github-pat")
      expect(line).toContain("src/leaky.ts:3")
    } finally {
      process.env.PATH = previous
    }
  }, 60_000)

  test("a rule+files glob waiver hides only what both globs match", async () => {
    await setGates({
      commands: [],
      budgets: { requireTestWithBehavior: false },
      security: { gitleaks: "off", osv: "off" },
    })
    const signer = await unlockHumanKey("test-passphrase-1234", state)
    await write(h.directory, "src/config.ts", `export const token = "${TOKEN}";\n`)
    await write(h.directory, "other/leak.ts", `export const leak = "${TOKEN}";\n`)
    await recordWaiver(h.directory, {
      id: "src-secrets",
      rule: "security/*",
      files: "src/**",
      reason: "fixture secrets under test",
      expiresAt: new Date(Date.now() + 86_400_000),
      channel: "cli",
      signer,
    })
    const { text } = await gatesText(h, { files: ["src/config.ts", "other/leak.ts", "test/keep.test.ts"] })
    expect(text).not.toContain("src/config.ts:1 security/secret-github-token")
    const line = lineWith(text, "security/secret-github-token")
    expect(line).toContain("other/leak.ts:1")
    expect(text).toContain("1 waived")
  }, 60_000)
})

describe("seeded build gates via es_gates_run (programmer seat, phase worktree)", () => {
  let h: Harness
  let state: string
  let signer: HumanSigner
  let worktree: string

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-gates-build-state-"))
    await sealHumanKey("test-passphrase-1234", state)
    signer = await unlockHumanKey("test-passphrase-1234", state)
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: {
        "README.md": "# seeded build gates\n",
        ".gitignore": "node_modules/\n",
        "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }),
      },
    })
    const factory = new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
    await factory.provisionRun("tester", 10)
    await factory.writeFrontier("grill", {
      version: "1.1",
      idea: "a greeting module",
      spendCeiling: { currency: "USD", maxAmount: 5 },
      settled: true,
      nodes: [{ id: "api", question: "API shape?", answer: "greet(name): string", status: "settled" }],
    })
    await approveStage(h.directory, {
      stage: "frontier",
      channel: "cli",
      approvedBy: "tester",
      signer,
      stateDir: state,
    })
    const cache = new SourceCache(researchSourcesDir(h.directory), state)
    const source = await cache.put({
      url: "https://example.test/greet",
      text: "A greeting module exports greet(name) and returns a string.",
      provider: "fetch",
    })
    await write(
      h.directory,
      ".factory/research/REPORT.md",
      `# Research\n\n- greet returns a string [VERIFIED: sha256:${source.meta.sha256} "exports greet(name) and returns a string"]\n`,
    )
    await factory.completeResearch("factory")
    await write(
      h.directory,
      ".factory/roadmap.json",
      JSON.stringify({ version: 1, title: "Greeting", phases: [{ id: "alpha", title: "Phase alpha" }] }, null, 2),
    )
    await write(
      h.directory,
      ".factory/specs/alpha/GOAL.md",
      stringifyFrontmatter(
        {
          phase: "alpha",
          title: "Phase alpha",
          acceptance: [{ kind: "file", id: "impl", description: "implementation exists", path: "src/alpha.ts" }],
        },
        "Implement alpha as a vertical slice.\n",
      ),
    )
    await approveStage(h.directory, { stage: "spec", channel: "cli", approvedBy: "tester", signer, stateDir: state })
    await factory.startBuild("factory")
    worktree = (await factory.activeWorktree())!
    await write(
      h.directory,
      ".factory/gates.json",
      JSON.stringify({
        commands: [],
        budgets: { maxDiffLines: 10, requireTestWithBehavior: false },
        security: { gitleaks: "off", osv: "off" },
      }),
    )
    await rebaseline(h.directory, "test-setup")
  }, 180_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("an oversized diff fails with budget/diff-size", async () => {
    await write(
      worktree,
      "src/grown.ts",
      `${Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`,
    )
    const { status, text } = await gatesText(h, { files: [path.join(worktree, "src/grown.ts")] })
    expect(status).toBe("completed")
    expect(lineWith(text, "budget/diff-size")).toContain("✗ . budget/diff-size")
  }, 120_000)

  test("a new dependency without justification fails with budget/dependency-justification", async () => {
    const pkg = JSON.parse(await readFile(path.join(worktree, "package.json"), "utf8"))
    await write(worktree, "package.json", JSON.stringify({ ...pkg, dependencies: { "left-pad": "1.3.0" } }, null, 2))
    const { text } = await gatesText(h, { files: [path.join(worktree, "package.json")] })
    const line = lineWith(text, "budget/dependency-justification")
    expect(line).toContain("package.json")
    expect(line).toContain("left-pad")
  }, 120_000)

  test("a factory phase that edits tool configuration is flagged", async () => {
    await write(worktree, "biome.json", '{"linter":{"enabled":false}}\n')
    const { text } = await gatesText(h, { files: [path.join(worktree, "biome.json")] })
    const line = lineWith(text, "integrity/tool-config-changed")
    expect(line).toContain("biome.json")
  }, 120_000)

  test("a malformed spec and an ungrounded claim fail artifact validation", async () => {
    const goal = path.join(h.directory, ".factory/specs/alpha/GOAL.md")
    const report = path.join(h.directory, ".factory/research/REPORT.md")
    const beforeGoal = await readFile(goal, "utf8")
    const beforeReport = await readFile(report, "utf8")
    const reportLines = beforeReport.split("\n").length
    try {
      await writeFile(goal, beforeGoal.replace("phase: alpha", "phase: beta"))
      await writeFile(
        report,
        `${beforeReport}- The flux capacitor already shipped [VERIFIED: sha256:${"0".repeat(64)} "flux"]\n`,
      )
      const { text } = await gatesText(h, { scope: "full" })
      const goalLine = lineWith(text, "schema/goal")
      expect(goalLine).toContain(".factory/specs/alpha/GOAL.md")
      const claimLine = lineWith(text, "research/ungrounded")
      expect(claimLine).toContain(".factory/research/REPORT.md")
      expect(claimLine).toContain(`:${reportLines}`)
    } finally {
      await writeFile(goal, beforeGoal)
      await writeFile(report, beforeReport)
    }
  }, 120_000)

  test("control drift halts the run and is recorded as integrity/control-drift", async () => {
    await writeFile(
      path.join(h.directory, ".factory/gates.json"),
      `${await readFile(path.join(h.directory, ".factory/gates.json"), "utf8")}\n// drifted by test\n`,
    )
    const { status, text } = await gatesText(h, { files: [path.join(worktree, "src/grown.ts")] })
    expect(status).toBe("error")
    expect(text).toMatch(/halt/i)
    expect(text).toContain("control")
    const runs = path.join(h.directory, ".factory/runs")
    const runIds = await readdir(runs)
    const summaries: string[] = []
    for (const runId of runIds) {
      const gates = path.join(runs, runId, "gates")
      for (const stamp of await readdir(gates).catch(() => [] as string[]))
        summaries.push(path.join(gates, stamp, "summary.json"))
    }
    expect(summaries.length).toBeGreaterThan(0)
    let witnessed = false
    for (const summary of summaries) {
      const findings = JSON.parse(await readFile(summary, "utf8")).findings as Array<{
        file: string
        rule: string
      }>
      if (findings.some((item) => item.file === ".factory" && item.rule === "integrity/control-drift")) witnessed = true
    }
    expect(witnessed).toBe(true)
  }, 120_000)
})
