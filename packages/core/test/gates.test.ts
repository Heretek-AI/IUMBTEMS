import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import {
  checkBudgets,
  commandSetHash,
  complexity,
  detectGates,
  formatReport,
  type GateReport,
  GatesConfigSchema,
  gitleaks,
  installed,
  isTrusted,
  loadGatesConfig,
  parseOutput,
  recordWaiver,
  runGates,
  trustProject,
  validateArtifacts,
} from "../src/index.ts"
import { canonicalPath } from "../src/trust/paths.ts"
import { bwrapAvailable, resetBwrapProbe, run } from "../src/util/proc.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

const BIOME = path.resolve(import.meta.dir, "../../../node_modules/.bin/biome")
const FAKE_TOKEN = `ghp_${"Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"}`

let fx: Fixture
const PASSPHRASE = "test-passphrase-1234"
let signer: HumanSigner
beforeEach(async () => {
  fx = await gitRepo("es-gates-")
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

describe("the gate sandbox (#51)", () => {
  // Gate commands are trusted, but what they run (tests) is agent-written.
  const probe = (key: string) =>
    [
      `cat ${key} > leak.txt 2>/dev/null`,
      "mkdir -p .factory/research/sources && echo forged > .factory/research/sources/forged.md",
      "git config core.hooksPath /tmp/evil-hooks",
      "echo ran > ran.txt",
      "true",
    ].join("; ")

  test.skipIf(!bwrapAvailable())(
    "agent-written test code cannot read the key, forge evidence or retarget git",
    async () => {
      const key = path.join(fx.state, "key")
      await writeFile(key, "SECRET-SIGNING-KEY\n")
      await mkdir(path.join(fx.root, ".factory"), { recursive: true })
      await write("probe.sh", `${probe(key)}\n`)
      const cfg = config([{ id: "probe", kind: "test", command: "sh probe.sh" }])
      await trust(cfg)
      const report = await gates({ scope: "full", config: cfg, sandbox: "required" })
      expect(report.checks.find((check) => check.id === "probe")?.status).toBe("pass")
      expect(await Bun.file(path.join(fx.root, "ran.txt")).text()).toBe("ran\n")
      expect(await Bun.file(path.join(fx.root, "leak.txt")).text()).not.toContain("SECRET-SIGNING-KEY")
      expect(await Bun.file(path.join(fx.root, ".factory/research/sources/forged.md")).exists()).toBe(false)
      expect(await Bun.file(path.join(fx.root, ".git/config")).text()).not.toContain("hooksPath")
    },
  )

  test("a required sandbox refuses to run when bubblewrap is missing", async () => {
    const cfg = config([{ id: "probe", kind: "test", command: "touch RAN" }])
    await trust(cfg)
    resetBwrapProbe(false)
    try {
      const report = await gates({ scope: "full", config: cfg, sandbox: "required" })
      expect(report.findings.map((finding) => finding.rule)).toContain("gates/sandbox-missing")
      expect(await Bun.file(path.join(fx.root, "RAN")).exists()).toBe(false)
    } finally {
      resetBwrapProbe()
    }
  })

  test("a missing tool is reported as missing, not as a sandbox problem", async () => {
    const cfg = config([{ id: "probe", kind: "test", command: "definitely-not-installed-xyz" }])
    await trust(cfg)
    const report = await gates({ scope: "full", config: cfg, sandbox: "required" })
    expect(report.findings.map((finding) => finding.rule)).toContain("gates/tool-missing")
    expect(report.findings.map((finding) => finding.rule)).not.toContain("gates/sandbox-missing")
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

  test("a forged trust entry is not trust: isTrusted verifies the human signature (#221.3)", async () => {
    const cfg = config([{ id: "probe", kind: "test", command: "touch RAN" }])
    const wanted = config([{ id: "probe", kind: "test", command: "touch FORGED" }])
    const { hash } = await commandSetHash(fx.root, cfg.commands)
    const forgedHash = (await commandSetHash(fx.root, wanted.commands)).hash
    await trust(cfg)
    expect(await isTrusted(fx.root, hash, fx.state)).toBe(true)

    const file = path.join(fx.state, "trust.json")
    const genuine = await readFile(file, "utf8")
    const store = JSON.parse(genuine) as { projects: Record<string, { gates: Record<string, any> }> }
    const project = Object.keys(store.projects)[0]!
    const entry = store.projects[project]!.gates
    const plant = (projects: Record<string, unknown>) => writeFile(file, JSON.stringify({ version: 3, projects }))

    // A second human key: a real Ed25519 signature, but not this machine's.
    const foreign = await mkdtemp(path.join(tmpdir(), "es-gates-foreign-"))
    await sealHumanKey(PASSPHRASE, foreign)
    const foreignSigner = await unlockHumanKey(PASSPHRASE, foreign)
    const retargeted = {
      hash: forgedHash,
      // The real display lines for the forged set (#217: the full normalized
      // check, not just `id: command`), so the forgery shapes match production.
      lines: (await commandSetHash(fx.root, wanted.commands)).lines,
      approvedBy: "x",
      approvedAt: entry.approvedAt,
    }
    const forgeries: Record<string, Record<string, unknown>> = {
      // The genuine signature replayed over another command set.
      "replayed signature": { [project]: { gates: { ...entry, hash: forgedHash, lines: retargeted.lines } } },
      "made-up signature": {
        [project]: {
          gates: { ...retargeted, signature: { alg: "ed25519", keyId: entry.signature.keyId, sig: "AAAA" } },
        },
      },
      "no signature": { [project]: { gates: retargeted } },
      "foreign key": {
        [project]: {
          gates: {
            ...retargeted,
            signature: foreignSigner.sign({ trust: 1, project, kind: "gates", ...retargeted }),
          },
        },
      },
    }
    try {
      for (const [name, projects] of Object.entries(forgeries)) {
        await plant(projects)
        expect([name, await isTrusted(fx.root, forgedHash, fx.state)]).toEqual([name, false])
        const report = await gates({ scope: "full", config: wanted })
        expect([name, report.findings[0]?.rule]).toEqual([name, "trust/untrusted"])
        expect(await Bun.file(path.join(fx.root, "FORGED")).exists()).toBe(false)
      }

      // The signature binds the project and the kind: the genuine entry moved
      // to another project, or presented as hook trust, verifies for neither.
      const other = await gitRepo("es-gates-other-")
      try {
        const otherProject = canonicalPath(other.root)
        expect(project).toBe(canonicalPath(fx.root))
        await plant({ [project]: { gates: entry, hooks: entry }, [otherProject]: { gates: entry } })
        expect(await isTrusted(other.root, hash, fx.state)).toBe(false)
        expect(await isTrusted(fx.root, hash, fx.state, "hooks")).toBe(false)
        // Control: in the same planted file, the untouched entry still verifies.
        expect(await isTrusted(fx.root, hash, fx.state)).toBe(true)
      } finally {
        await other.cleanup()
      }
    } finally {
      await rm(foreign, { recursive: true, force: true })
    }
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
      signer,
    })
    const waived = await gates({ touched: ["src/config.ts"], config: config([]) })
    expect(waived.findings.some((finding) => finding.rule === "security/secret-github-token")).toBe(false)
    expect(waived.waived).toBeGreaterThan(0)
  })

  test("an expired signed waiver planted at gate time waives nothing (#221.1)", async () => {
    await write("src/config.ts", `export const token = "${FAKE_TOKEN}"\n`)
    // recordWaiver refuses a past expiry, so the record is hand-aged: the
    // same fields it signs, under the real human key, one day apart.
    const plant = async (expiresAt: Date) => {
      const unsigned = {
        version: 2 as const,
        id: "aged-token",
        rule: "security/secret-github-token",
        files: "src/config.ts",
        reason: "fixture value, not a real token",
        approvedBy: "tester",
        approvedAt: new Date(expiresAt.getTime() - 30 * 86_400_000).toISOString(),
        expiresAt: expiresAt.toISOString(),
        channel: "cli" as const,
        auditHead: null,
      }
      await write(".factory/waivers/aged-token.json", JSON.stringify({ ...unsigned, signature: signer.sign(unsigned) }))
      return gates({ touched: ["src/config.ts"], config: config([]) })
    }

    const expired = await plant(new Date(Date.now() - 86_400_000))
    // The signature verifies, so this is not the forged path: no waiver/invalid.
    expect(expired.findings.some((finding) => finding.rule === "waiver/invalid")).toBe(false)
    expect(expired.findings.some((finding) => finding.rule === "security/secret-github-token")).toBe(true)
    expect(expired.waived).toBe(0)
    expect(expired.passed).toBe(false)

    // Control: the identical record with a live expiry does waive, so the
    // refusal above is the expiry and nothing else about the planted file.
    const live = await plant(new Date(Date.now() + 86_400_000))
    expect(live.findings.some((finding) => finding.rule === "security/secret-github-token")).toBe(false)
    expect(live.waived).toBe(1)
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

  test("touched scope prefers the import graph for tests, and falls back to the runner heuristic", async () => {
    await write("src/util.ts", "export const helper = () => 1\n")
    await write("test/imports-util.test.ts", 'import { helper } from "../src/util"\n')
    await write("src/lone.ts", "export const lone = 1\n")
    await write("src/lone.test.ts", "// does not import lone\n")
    // A helper under test/ imports the change too; it is traversed, never run.
    await write("test/helpers.ts", 'export { helper } from "../src/util"\n')
    await write("test/uses-helper.test.ts", 'import { helper } from "./helpers"\n')
    await write("record.ts", 'await Bun.write("record.json", JSON.stringify(process.argv.slice(2)))\n')
    const cfg = config(
      [{ id: "test", kind: "test", command: "bun run record.ts", parser: "generic", related: "bun" }],
      {
        budgets: { requireTestWithBehavior: false },
      },
    )
    await trust(cfg)

    const graphRun = await gates({ touched: ["src/util.ts"], config: cfg, structure: { regexOnly: true } })
    expect(graphRun.passed).toBe(true)
    // The test that imports the change (the graph's answer), not the "util" stem.
    expect(JSON.parse(await Bun.file(path.join(fx.root, "record.json")).text())).toEqual([
      "./test/imports-util.test.ts",
      "./test/uses-helper.test.ts",
    ])

    const fallback = await gates({ touched: ["src/lone.ts"], config: cfg, structure: { regexOnly: true } })
    expect(fallback.passed).toBe(true)
    // No test imports it, so the runner-native stem heuristic still applies.
    expect(JSON.parse(await Bun.file(path.join(fx.root, "record.json")).text())).toEqual(["lone"])
  })

  test("polyglot repos: each runner only receives tests of its own language", async () => {
    await write("src/util.ts", "export const helper = () => 1\n")
    await write("test/imports-util.test.ts", 'import { helper } from "../src/util"\n')
    await write("pkg/core.py", "def thing():\n    return 1\n")
    await write("pkg/test_core.py", "from core import thing\n")
    await write("record.ts", 'await Bun.write("record.json", JSON.stringify(process.argv.slice(2)))\n')
    const cfg = config(
      [{ id: "py-test", kind: "test", command: "bun run record.ts", parser: "generic", related: "pytest" }],
      { budgets: { requireTestWithBehavior: false } },
    )
    await trust(cfg)
    const report = await gates({
      touched: ["src/util.ts", "pkg/core.py"],
      config: cfg,
      structure: { regexOnly: true },
    })
    expect(report.passed).toBe(true)
    expect(JSON.parse(await Bun.file(path.join(fx.root, "record.json")).text())).toEqual(["pkg/test_core.py"])
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
    // Paths with parentheses (Next.js route groups) and the --pretty format.
    const grouped = parseOutput(
      "tsc",
      "app/(auth)/page.tsx(12,5): error TS2304: Cannot find name 'x'.\napp/(shop)/[id]/page.tsx:4:1 - warning TS6133: 'y' is declared but never read.",
      "/r",
      "typecheck",
    )
    expect(grouped.findings).toMatchObject([
      { file: "app/(auth)/page.tsx", line: 12, column: 5, rule: "typecheck/TS2304", message: "Cannot find name 'x'." },
      { file: "app/(shop)/[id]/page.tsx", line: 4, column: 1, severity: "warning", rule: "typecheck/TS6133" },
    ])
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

  test("mypy, jest and go test output", () => {
    const mypy = parseOutput(
      "mypy",
      "src/a.py:3:5: error: Incompatible types in assignment [assignment]\nsrc/b.py:7: warning: unused 'type: ignore' comment\nFound 2 errors",
      "/r",
      "py-type",
    )
    expect(mypy.findings).toEqual([
      {
        file: "src/a.py",
        line: 3,
        column: 5,
        rule: "mypy/assignment",
        severity: "error",
        message: "Incompatible types in assignment",
        check: "py-type",
      },
      {
        file: "src/b.py",
        line: 7,
        rule: "mypy/error",
        severity: "warning",
        message: "unused 'type: ignore' comment",
        check: "py-type",
      },
    ])
    const jest = parseOutput("jest", "FAIL src/a.test.ts\n  ● math › adds\n\n    expect(received)", "/r", "test")
    expect(jest.findings.map((finding) => [finding.file, finding.message])).toEqual([
      ["src/a.test.ts", "Test file has failures"],
      ["src/a.test.ts", "Test failed: math › adds"],
    ])
    const go = parseOutput(
      "go-test",
      "--- FAIL: TestAdd (0.00s)\n    pkg/math_test.go:12: got 1, want 2\nFAIL",
      "/r",
      "go-test",
    )
    expect(go.findings[0]?.message).toBe("Test failed: TestAdd")
    expect(go.failedTests).toEqual(["pkg/math_test.go"])
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

  test("complexity finds TS methods and arrows with return types and nested parens", () => {
    const scores = complexity(
      "a.ts",
      [
        "class A {",
        "  method(x: number): string {",
        "    if (x) { return 'a' }",
        "    return 'b'",
        "  }",
        "  private async load(a = f(), b: Map<string, number>): Promise<void> {",
        "    if (a && b) return",
        "  }",
        "}",
        "const typed = (x: number): string => {",
        "  return x ? 'y' : 'n'",
        "}",
        "export function plain(a: string): number {",
        "  return a ? 1 : 0",
        "}",
        "expect(foo).toBe(1)",
      ].join("\n"),
    )
    expect(scores.map((item) => item.name).sort()).toEqual(["load", "method", "plain", "typed"])
    expect(scores.find((item) => item.name === "method")?.score).toBe(2)
    expect(scores.find((item) => item.name === "load")?.score).toBe(3)
    expect(scores.find((item) => item.name === "typed")?.score).toBe(2)
  })
})

describe("built-in secret scan cache (#239)", () => {
  test("a rescan re-reads only changed files: hits are counted, edits re-read, no count cap", async () => {
    const { clearSecretScanCache, scanFileForSecrets, secretScanStats } = await import("../src/index.ts")
    clearSecretScanCache()
    await write("src/a.ts", `export const token = "${FAKE_TOKEN}"\n`)
    await write("src/b.ts", "export const b = 1\n")
    const first = await scanFileForSecrets(fx.root, "src/a.ts")
    expect(first.some((finding) => finding.rule === "security/secret-github-token")).toBe(true)
    expect(await scanFileForSecrets(fx.root, "src/b.ts")).toEqual([])
    // Unchanged files are cache hits: identical findings, hits counted.
    const before = secretScanStats()
    expect(await scanFileForSecrets(fx.root, "src/a.ts")).toEqual(first)
    expect(await scanFileForSecrets(fx.root, "src/b.ts")).toEqual([])
    expect(secretScanStats().hits).toBe(before.hits + 2)
    // An edit re-reads: the finding disappears after the secret is removed.
    await write("src/a.ts", 'export const token = "rotated"\n')
    expect(await scanFileForSecrets(fx.root, "src/a.ts")).toEqual([])
  })
})

describe("proof gaps (#239)", () => {
  test("format is a failing arm, not detection-only: unformatted files fail, formatted files pass", async () => {
    await write("biome.json", "{}")
    await write("src/a.ts", "export const x=1\n")
    const cfg = config([
      {
        id: "format",
        kind: "format",
        command: `${BIOME} format --reporter=json`,
        parser: "biome",
        touchedArgs: true,
        extensions: [".ts"],
      },
    ])
    await trust(cfg)
    // The engine arm, not the sandbox: pin bwrap away so the command runs
    // directly (containers without overlayfs cannot sandbox; see #239).
    resetBwrapProbe(false)
    try {
      const red = await gates({ touched: ["src/a.ts"], config: cfg })
      expect(red.checks.find((check) => check.id === "format")?.status).toBe("fail")
      expect(red.findings.find((finding) => finding.rule === "format/biome")).toMatchObject({
        file: "src/a.ts",
        severity: "error",
      })
      await write("src/a.ts", "export const x = 1;\n")
      const green = await gates({ touched: ["src/a.ts"], config: cfg })
      expect(green.findings.some((finding) => finding.rule === "format/biome")).toBe(false)
    } finally {
      resetBwrapProbe()
    }
  })

  test("typecheck runs at gate level: errors fail, clean files pass, present tools are not missing", async () => {
    const TSC = path.resolve(import.meta.dir, "../../../node_modules/.bin/tsc")
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }))
    await write("src/a.ts", 'export const x: number = "nope"\n')
    const cfg = config([
      { id: "typecheck", kind: "typecheck", command: `${TSC} --noEmit -p tsconfig.json`, parser: "tsc" },
    ])
    await trust(cfg)
    resetBwrapProbe(false)
    try {
      const red = await gates({ touched: ["src/a.ts"], config: cfg })
      expect(red.checks.find((check) => check.id === "typecheck")?.status).toBe("fail")
      expect(red.findings.some((finding) => finding.file === "src/a.ts" && finding.check === "typecheck")).toBe(true)
      await write("src/a.ts", "export const x: number = 1\n")
      const green = await gates({ touched: ["src/a.ts"], config: cfg })
      expect(green.checks.find((check) => check.id === "typecheck")?.status).toBe("pass")
      expect(green.findings.some((finding) => finding.rule === "gates/tool-missing")).toBe(false)
      expect(green.findings.some((finding) => finding.rule === "gates/sandbox-missing")).toBe(false)
    } finally {
      resetBwrapProbe()
    }
  })

  test("a failing test command fails the gate (fail arm, not pass-only)", async () => {
    const cfg = config([{ id: "test", kind: "test", command: "bun -e 'process.exit(1)'", parser: "generic" }])
    await trust(cfg)
    resetBwrapProbe(false)
    try {
      const report = await gates({ scope: "full", config: cfg })
      expect(report.checks.find((check) => check.id === "test")?.status).toBe("fail")
      expect(report.testsFailed).toBe(true)
      expect(report.findings.some((finding) => finding.rule === "test/command-failed")).toBe(true)
    } finally {
      resetBwrapProbe()
    }
  })

  test("budget pass arms: small, simple, tested changes are quiet; diff-size has both arms", async () => {
    await write("src/a.ts", "export const a = 1\n")
    await write("src/a.test.ts", 'import { a } from "./a"\n')
    const quiet = await gates({
      touched: ["src/a.ts", "src/a.test.ts"],
      config: config([], { budgets: { maxFileLines: 20, maxComplexity: 10 } }),
    })
    for (const rule of ["budget/file-length", "budget/complexity", "budget/test-with-behavior"])
      expect([rule, quiet.findings.some((finding) => finding.rule === rule)]).toEqual([rule, false])
    const budgets = {
      maxFileLines: 800,
      maxComplexity: 15,
      maxDiffLines: 10,
      requireDepJustification: false,
      requireTestWithBehavior: false,
    }
    const over = await checkBudgets({ dir: fx.root, files: [], budgets, diff: { added: 6, removed: 5 } })
    expect(over.find((finding) => finding.rule === "budget/diff-size")?.severity).toBe("error")
    const under = await checkBudgets({ dir: fx.root, files: [], budgets, diff: { added: 5, removed: 5 } })
    expect(under.some((finding) => finding.rule === "budget/diff-size")).toBe(false)
  })

  test("a phase that touches only source passes tool-config (pass arm)", async () => {
    const base = await commit("base")
    await write("src/a.ts", "export const a = 1\n")
    const report = await gates({ scope: "full", base, phaseId: "p1", config: config([]) })
    expect(report.findings.some((finding) => finding.rule === "integrity/tool-config-changed")).toBe(false)
  })

  test("a valid gates.json loads with no problem (pass arm)", async () => {
    await write(".factory/gates.json", JSON.stringify({ commands: [] }))
    const { config: loaded, problem } = await loadGatesConfig(fx.root)
    expect(problem).toBeUndefined()
    expect(loaded.commands).toEqual([])
  })

  test("artifact validation flags a malformed frontier and passes when artifacts are absent", async () => {
    expect(await validateArtifacts(fx.root, fx.state)).toEqual([])
    await write(".factory/frontier.json", "{}")
    const findings = await validateArtifacts(fx.root, fx.state)
    expect(findings.find((finding) => finding.rule === "schema/frontier")?.file).toBe(".factory/frontier.json")
  })

  test("formatReport renders the summary, the findings and the overflow pointer", () => {
    const report: GateReport = {
      passed: false,
      findings: [
        {
          file: "src/a.ts",
          line: 2,
          rule: "lint/suspicious/noDebugger",
          severity: "error",
          message: "No debugger",
          check: "lint",
        },
      ],
      totalFindings: 3,
      waived: 0,
      checks: [{ id: "lint", status: "fail", durationMs: 1, findings: 3 }],
      summary: "Gates failed: 3 error(s)",
      failedTests: [],
      testsFailed: false,
      logDir: "/tmp/logs",
    }
    const text = formatReport(report)
    expect(text).toContain("Gates failed: 3 error(s)")
    expect(text).toContain("src/a.ts:2 lint/suspicious/noDebugger")
    expect(text).toContain("… 2 more in /tmp/logs/summary.json")
  })

  test("the lsp gate reports error diagnostics and passes on clean files", async () => {
    await write("src/a.ts", "export const a = 1\n")
    const red = await gates({
      touched: ["src/a.ts"],
      config: config([]),
      lsp: {
        diagnostics: async () => [
          { severity: 1, message: "boom", source: "ts", range: { start: { line: 0, character: 0 } } },
        ],
      },
    })
    expect(red.findings.find((finding) => finding.rule === "lsp/ts")).toMatchObject({ file: "src/a.ts", line: 1 })
    const green = await gates({
      touched: ["src/a.ts"],
      config: config([]),
      lsp: { diagnostics: async () => [] },
    })
    expect(green.findings.some((finding) => finding.check === "lsp")).toBe(false)
  })

  test("gitleaks: empty input is a skip; without the binary it never runs", async () => {
    expect(await gitleaks(fx.root, [])).toBeUndefined()
    if (!installed("gitleaks")) expect(await gitleaks(fx.root, ["README.md"])).toBeUndefined()
  })

  test("control drift is an integrity/control-drift gate finding, not just a halt", async () => {
    const { rebaseline } = await import("../src/trust/index.ts")
    await rebaseline(fx.root, "human:tester")
    await write(".factory/gates.json", '{"commands":[]}\n')
    const report = await gates({ scope: "full", config: config([]) })
    expect(report.findings.find((finding) => finding.rule === "integrity/control-drift")).toMatchObject({
      file: ".factory",
      severity: "error",
      check: "integrity",
    })
  })
})
