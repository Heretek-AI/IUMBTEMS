import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  commandSetHash,
  complexity,
  detectGates,
  GatesConfigSchema,
  loadGatesConfig,
  parseOutput,
  recordWaiver,
  runGates,
  trustProject,
} from "../src/index.ts"
import { run } from "../src/util/proc.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

const BIOME = path.resolve(import.meta.dir, "../../../node_modules/.bin/biome")
const FAKE_TOKEN = `ghp_${"Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"}`

let fx: Fixture
beforeEach(async () => {
  fx = await gitRepo("es-gates-")
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
  await trustProject(fx.root, hash, lines, { stateDir: fx.state })
}

describe("detection", () => {
  test("a bun + biome + TypeScript project gets check-mode commands only", async () => {
    await write("package.json", JSON.stringify({ devDependencies: { "@biomejs/biome": "2", typescript: "5" } }))
    await write("bun.lock", "{}")
    await write("tsconfig.json", "{}")
    const detected = await detectGates(fx.root)
    expect(detected.commands.map((item) => [item.id, item.command])).toEqual([
      ["format", "biome format --reporter=json"],
      ["lint", "biome lint --reporter=json"],
      ["typecheck", "tsc --noEmit -p tsconfig.json"],
      ["test", "bun test"],
    ])
    expect(detected.commands.some((item) => item.command.includes("--write"))).toBe(false)
  })

  test("no tsconfig means no typecheck; python and go projects get their own checks", async () => {
    await write("package.json", JSON.stringify({ devDependencies: { vitest: "3" } }))
    await write("pyproject.toml", "[tool.ruff]\n")
    await write("go.mod", "module x\n")
    const ids = (await detectGates(fx.root)).commands.map((item) => item.id)
    expect(ids).toEqual(["test", "py-format", "py-lint", "py-test", "go-format", "go-lint", "go-test"])
  })
})

describe("trust", () => {
  test("untrusted commands never run; trusting the exact set enables them; changing it revokes trust", async () => {
    const cfg = config([{ id: "probe", kind: "test", command: "touch RAN" }])
    const untrusted = await gates({ scope: "full", config: cfg })
    expect(untrusted.passed).toBe(false)
    expect(untrusted.findings[0]?.rule).toBe("trust/untrusted")
    expect(await Bun.file(path.join(fx.root, "RAN")).exists()).toBe(false)

    await trust(cfg)
    const trusted = await gates({ scope: "full", config: cfg })
    expect(trusted.checks.find((check) => check.id === "probe")?.status).toBe("pass")
    expect(await Bun.file(path.join(fx.root, "RAN")).exists()).toBe(true)

    const changed = config([{ id: "probe", kind: "test", command: "touch RAN2" }])
    expect((await gates({ scope: "full", config: changed })).findings[0]?.rule).toBe("trust/untrusted")
  })

  test("a package script reachable from a command is part of the trusted hash", async () => {
    await write("package.json", JSON.stringify({ scripts: { typecheck: "tsc" } }))
    const cfg = config([{ id: "typecheck", kind: "typecheck", command: "npm run --silent typecheck" }])
    const before = await commandSetHash(fx.root, cfg.commands)
    await write("package.json", JSON.stringify({ scripts: { typecheck: "true" } }))
    expect((await commandSetHash(fx.root, cfg.commands)).hash).not.toBe(before.hash)
  })
})

describe("built-in checks", () => {
  test("secrets are errors; only signed, unexpired waivers remove them", async () => {
    await write("src/config.ts", `export const token = "${FAKE_TOKEN}"\n`)
    const report = await gates({ touched: ["src/config.ts"], config: config([]) })
    const secret = report.findings.find((finding) => finding.rule === "security/secret-github-token")
    expect(secret).toMatchObject({ file: "src/config.ts", line: 1, severity: "error" })

    await write(
      ".factory/waivers/forged.json",
      JSON.stringify({
        version: 1,
        id: "forged",
        rule: "security/*",
        files: "**",
        reason: "trust me please",
        approvedBy: "x",
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        channel: "cli",
        auditHead: null,
        mac: "0".repeat(64),
      }),
    )
    const forged = await gates({ touched: ["src/config.ts"], config: config([]) })
    expect(forged.findings.some((finding) => finding.rule === "security/secret-github-token")).toBe(true)
    expect(forged.findings.some((finding) => finding.rule === "waiver/invalid")).toBe(true)

    await recordWaiver(fx.root, {
      id: "fixture-token",
      rule: "security/secret-github-token",
      files: "src/config.ts",
      reason: "fixture value, not a real token",
      expiresAt: new Date(Date.now() + 86_400_000),
      channel: "cli",
      stateDir: fx.state,
    })
    const waived = await gates({ touched: ["src/config.ts"], config: config([]) })
    expect(waived.findings.some((finding) => finding.rule === "security/secret-github-token")).toBe(false)
    expect(waived.waived).toBeGreaterThan(0)
  })

  test("budgets: behaviour change without a test change, file length, complexity", async () => {
    await write("src/big.ts", Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}`).join("\n"))
    await write(
      "src/branchy.ts",
      `export function decide(x: number) {\n${Array.from({ length: 6 }, (_, i) => `  if (x === ${i} && x > -1) return ${i}`).join("\n")}\n  return -1\n}\n`,
    )
    const report = await gates({
      touched: ["src/big.ts", "src/branchy.ts"],
      config: config([], { budgets: { maxFileLines: 20, maxComplexity: 10 } }),
    })
    const rules = report.findings.map((finding) => finding.rule)
    expect(rules).toContain("budget/test-with-behavior")
    expect(rules).toContain("budget/file-length")
    expect(report.findings.find((finding) => finding.rule === "budget/complexity")?.message).toContain("decide")
  })

  test("a new dependency needs a justification line in the phase DEPENDENCIES.md", async () => {
    await write("package.json", JSON.stringify({ dependencies: {} }))
    const base = await commit("base")
    await write("package.json", JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }))
    await write("test/a.test.ts", "")
    const missing = await gates({ scope: "full", base, phaseId: "p1", config: config([]) })
    expect(missing.findings.find((finding) => finding.rule === "budget/dependency-justification")?.message).toContain(
      "left-pad",
    )
    await write(".factory/specs/p1/DEPENDENCIES.md", "- `left-pad`: MIT, needed for padding, maintained\n")
    const justified = await gates({ scope: "full", base, phaseId: "p1", config: config([]) })
    expect(justified.findings.some((finding) => finding.rule === "budget/dependency-justification")).toBe(false)
  })

  test("a factory phase that edits tool configuration is flagged", async () => {
    const base = await commit("base")
    await write("biome.json", '{"linter":{"enabled":false}}')
    const report = await gates({ scope: "full", base, phaseId: "p1", config: config([]) })
    expect(
      report.findings.some(
        (finding) => finding.rule === "integrity/tool-config-changed" && finding.file === "biome.json",
      ),
    ).toBe(true)
  })

  test("OSV: a vulnerable lockfile entry is an error; an unreachable API is UNVERIFIED (fail closed)", async () => {
    await write("requirements.txt", "requests==2.0.0\n")
    const cfg = config([], { security: { gitleaks: "off", osv: "api" } })
    const vulnerable = async () => new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-test" }] }] }))
    const report = await gates({ touched: ["requirements.txt"], config: cfg, fetch: vulnerable as any })
    expect(report.findings.find((finding) => finding.rule === "security/vuln-GHSA-test")?.message).toContain(
      "requests@2.0.0",
    )
    const offline = async () => {
      throw new Error("network down")
    }
    const unverified = await gates({ touched: ["requirements.txt"], config: cfg, fetch: offline as any })
    expect(unverified.findings.some((finding) => finding.rule === "security/osv-unverified")).toBe(true)
  })
})

describe("command checks", () => {
  test("biome lint findings come back as file:line:rule, scoped to touched files, with logs on disk", async () => {
    await write("biome.json", "{}")
    await write("src/a.ts", "export const x = 1\nif (x == 2) { debugger }\n")
    await write("src/b.ts", "debugger\n")
    const cfg = config([
      {
        id: "lint",
        kind: "lint",
        command: `${BIOME} lint --reporter=json`,
        parser: "biome",
        touchedArgs: true,
        extensions: [".ts"],
      },
    ])
    await trust(cfg)
    const report = await gates({ touched: ["src/a.ts"], config: cfg })
    const debuggerFinding = report.findings.find((finding) => finding.rule === "lint/suspicious/noDebugger")
    expect(debuggerFinding).toMatchObject({ file: "src/a.ts", line: 2, severity: "error" })
    expect(report.findings.some((finding) => finding.file === "src/b.ts")).toBe(false)
    const log = report.checks.find((check) => check.id === "lint")?.log
    expect(await Bun.file(log!).text()).toContain("noDebugger")
    expect(await Bun.file(path.join(report.logDir, "summary.json")).exists()).toBe(true)
  })

  test("a missing tool fails closed", async () => {
    const cfg = config([{ id: "lint", kind: "lint", command: "definitely-not-installed-xyz" }])
    await trust(cfg)
    const report = await gates({ scope: "full", config: cfg })
    expect(report.passed).toBe(false)
    expect(report.findings[0]?.rule).toBe("gates/tool-missing")
  })

  test("invalid gates.json fails closed and falls back to detection", async () => {
    await write(".factory/gates.json", '{"commands": "nope"}')
    const { problem } = await loadGatesConfig(fx.root)
    expect(problem?.rule).toBe("schema/gates-config")
  })
})

describe("parsers", () => {
  test("tsc, bun test and pytest output", () => {
    const tsc = parseOutput(
      "tsc",
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "/r",
      "typecheck",
    )
    expect(tsc.findings[0]).toMatchObject({ file: "src/a.ts", line: 3, column: 7, rule: "typecheck/TS2322" })
    const bun = parseOutput(
      "bun-test",
      "test/math.test.ts:\n2 | x\nerror: expect(received).toBe(expected)\n      at <anonymous> (/r/test/math.test.ts:2:34)\n(fail) adds [0.28ms]\n",
      "/r",
      "test",
    )
    expect(bun.findings[0]).toMatchObject({ file: "test/math.test.ts", line: 2, message: "Test failed: adds" })
    expect(bun.failedTests).toEqual(["test/math.test.ts"])
    const py = parseOutput("pytest", "FAILED tests/test_a.py::test_x - AssertionError: boom", "/r", "py-test")
    expect(py.findings[0]?.file).toBe("tests/test_a.py")
  })

  test("complexity counts decisions per function, including one-liners and arrows", () => {
    const scores = complexity(
      "a.ts",
      "const tiny = (x) => x ? 1 : 2\nfunction one() { return 1 }\nfunction many(a, b) {\n  if (a && b) {\n    for (const x of a) if (x) return x\n  }\n  return a || b\n}\n",
    )
    expect(scores.find((item) => item.name === "one")?.score).toBe(1)
    expect(scores.find((item) => item.name === "tiny")?.score).toBe(2)
    expect(scores.find((item) => item.name === "many")?.score).toBe(6)
  })
})
