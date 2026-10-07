// The gate engine. One entry point, many checks, one structured report:
// top-N findings (file:line:rule + fix hint) for the agent, the full list and
// every command log under .factory/runs/<run>/gates/<stamp>/ for humans.
//
// Fail-closed rules: untrusted command sets do not run (finding), missing
// tools are findings, OSV that cannot be consulted on a dependency change is
// UNVERIFIED (finding), control-file drift is a finding. Only signed,
// unexpired waivers remove findings.
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { stateDir as defaultStateDir, factoryLayout } from "../layout.ts"
import {
  type CheckReport,
  type CommandCheck,
  type GateFinding,
  type GateReport,
  type GatesConfig,
  GatesConfigSchema,
} from "../schema/gates.ts"
import { type AffectedTests, affectedTests, type GraphOptions } from "../structure/index.ts"
import { verifyControl } from "../trust/control.ts"
import { relativeTo } from "../trust/paths.ts"
import { SANDBOX_MISSING } from "../trust/sandbox.ts"
import { commandSetHash, isTrusted } from "../trust/store.ts"
import { matchAny } from "../util/glob.ts"
import { parseJsonc } from "../util/jsonc.ts"
import { bwrapAvailable, findExecutable, type RunResult, run, splitCommand } from "../util/proc.ts"
import { changedFiles, diffStats, git } from "../worktree/git.ts"
import { validateArtifacts } from "./artifacts.ts"
import { checkBudgets, isTestFile } from "./budgets.ts"
import { detectGates } from "./detect.ts"
import { parseOutput } from "./parsers.ts"
import { scanForSecrets } from "./secrets.ts"
import { DEPENDENCY_FILES, gitleaks, osvFindings } from "./security.ts"
import { isWaived, loadWaivers } from "./waivers.ts"

export interface RunGatesOptions {
  /** Project root: config, waivers, trust, control files and logs live here. */
  readonly root: string
  /** Where commands run (the phase worktree, or the root). */
  readonly dir?: string
  readonly scope: "touched" | "full"
  /** Files relative to `dir` (touched scope). */
  readonly touched?: readonly string[]
  /** Base commit for diff budgets and the full-scope change set. */
  readonly base?: string
  readonly phaseId?: string
  readonly runId?: string
  readonly config?: GatesConfig
  readonly stateDir?: string
  readonly signal?: AbortSignal
  readonly fetch?: typeof fetch
  /** Language-server diagnostics for touched files (the "lsp" gate). */
  readonly lsp?: { diagnostics(file: string, options?: { maxWaitMs?: number }): Promise<unknown> }
  /** Structural index options for touched-scope affected-test selection. */
  readonly structure?: GraphOptions
  /**
   * Gate commands run agent-written code (tests), so they run in the gate
   * sandbox: only `dir` writable, .factory/ and git config read-only, secrets
   * and credentials masked. "required" (factory runs) refuses without
   * bubblewrap; "preferred" (default; human and user runs) uses it when present.
   */
  readonly sandbox?: "required" | "preferred"
}

const TOOL_CONFIG = [
  "biome.json",
  "biome.jsonc",
  "**/tsconfig*.json",
  ".eslintrc*",
  "eslint.config.*",
  ".prettierrc*",
  "prettier.config.*",
  "ruff.toml",
  ".ruff.toml",
  "mypy.ini",
  "vitest.config.*",
  "jest.config.*",
  "bunfig.toml",
  "rustfmt.toml",
  "clippy.toml",
  ".golangci.y*ml",
  ".factory/gates.json",
]

export async function loadGatesConfig(
  root: string,
  dir = root,
): Promise<{ config: GatesConfig; problem?: GateFinding }> {
  const text = await readFile(factoryLayout(root).gates, "utf8").catch(() => undefined)
  if (text === undefined) return { config: await detectGates(dir) }
  const parsed = GatesConfigSchema.safeParse(
    (() => {
      try {
        return parseJsonc(text)
      } catch {
        return undefined
      }
    })(),
  )
  if (parsed.success) return { config: parsed.data }
  return {
    config: await detectGates(dir),
    problem: {
      file: ".factory/gates.json",
      rule: "schema/gates-config",
      severity: "error",
      message: "invalid gates.json; using detected checks",
      check: "config",
    },
  }
}

/** node_modules/.bin in the run dir, then the root, then PATH. */
function resolveBinary(argv0: string, dir: string, root: string): string {
  if (argv0.includes("/")) return argv0
  for (const base of [dir, root]) {
    const candidate = path.join(base, "node_modules", ".bin", argv0)
    if (existsSync(candidate)) return candidate
  }
  return argv0
}

function relatedTestArgs(
  check: CommandCheck,
  files: readonly string[],
  dir: string,
  affected?: AffectedTests,
): string[] | undefined {
  const code = files.filter((file) => /\.[cm]?[jt]sx?$|\.py$|\.go$/.test(file))
  // The import graph knows which tests (transitively) import the change set.
  // When it has an answer for this runner's language, prefer it; otherwise
  // fall back to runner-native selection (full suite still runs at phase end).
  const tests = affected?.tests ?? []
  const jsTests = tests.filter((file) => /\.[cm]?[jt]sx?$/.test(file))
  const pyTests = tests.filter((file) => file.endsWith(".py"))
  if (tests.length) {
    switch (check.related) {
      case "bun":
        // "./" makes bun treat each argument as a path, not a name filter.
        if (jsTests.length) return jsTests.map((file) => `./${file}`)
        break
      case "vitest":
        if (jsTests.length) return ["run", ...jsTests]
        break
      case "jest":
        if (jsTests.length) return ["--runTestsByPath", ...jsTests]
        break
      case "pytest":
        if (pyTests.length) return [...pyTests]
        break
      case "go": {
        // Go tests are package-scoped: run the packages of affected tests and
        // of every touched file (so a changed package always compiles).
        const dirs = new Set<string>()
        const go = [...tests.filter((file) => file.endsWith(".go")), ...code.filter((file) => file.endsWith(".go"))]
        for (const file of go) {
          const parent = path.posix.dirname(file)
          dirs.add(parent === "." ? "." : `./${parent}`)
        }
        if (dirs.size) return [...dirs]
        break
      }
      default:
        return undefined
    }
  }
  if (code.length === 0) return undefined
  const stem = (file: string) =>
    path.basename(file).replace(/\.(test|spec)?\.?[cm]?[jt]sx?$|\.py$|_test\.go$|\.go$/, "")
  switch (check.related) {
    case "bun":
      return [...new Set(code.map((file) => (isTestFile(file) ? file : stem(file))).filter(Boolean))]
    case "vitest":
      return ["related", "--run", ...code]
    case "jest":
      return ["--findRelatedTests", ...code, "--passWithNoTests"]
    case "pytest": {
      const tests = code.filter(isTestFile)
      for (const file of code.filter((item) => !isTestFile(item) && item.endsWith(".py")))
        for (const candidate of [
          `tests/test_${stem(file)}.py`,
          `test_${stem(file)}.py`,
          path.join(path.dirname(file), `test_${stem(file)}.py`),
        ])
          if (existsSync(path.join(dir, candidate))) tests.push(candidate)
      return tests.length ? [...new Set(tests)] : undefined
    }
    case "go":
      return [...new Set(code.filter((file) => file.endsWith(".go")).map((file) => `./${path.posix.dirname(file)}`))]
    default:
      return undefined
  }
}

const NO_TESTS = /No tests found|no tests ran|Tests need "\.test"|No test files found|no test files/i

async function runCommandCheck(
  check: CommandCheck,
  context: {
    dir: string
    root: string
    scope: "touched" | "full"
    files: readonly string[]
    logDir: string
    affected?: AffectedTests
    signal?: AbortSignal
    sandbox: "required" | "preferred"
    stateDir: string
  },
): Promise<{ report: CheckReport; findings: GateFinding[]; failedTests: string[] }> {
  const started = Date.now()
  let argv = splitCommand(check.command)
  const skip = (note: string) => ({
    report: { id: check.id, status: "skip" as const, durationMs: 0, findings: 0, note },
    findings: [],
    failedTests: [],
  })
  if (context.scope === "touched") {
    if (check.kind === "test") {
      const extra = relatedTestArgs(check, context.files, context.dir, context.affected)
      if (!extra) return skip("no related tests for the touched files (full suite runs at completion)")
      argv = check.related === "vitest" ? [argv[0]!, ...extra] : [...argv, ...extra]
    } else if (check.touchedArgs) {
      const targets = context.files.filter(
        (file) => !check.extensions.length || check.extensions.some((ext) => file.endsWith(ext)),
      )
      if (!targets.length) return skip("no touched files of this type")
      argv = [...argv, ...targets]
    }
  } else if (check.touchedArgs) argv = [...argv, "."]
  argv[0] = resolveBinary(argv[0]!, context.dir, context.root)
  const log = path.join(context.logDir, `${check.id}.log`)
  // Resolve the tool first: inside bwrap a missing binary would look like a failing command.
  const toolMissing = !argv[0]!.includes("/") && !findExecutable(argv[0]!)
  const sandboxed = !toolMissing && bwrapAvailable()
  if (!sandboxed && context.sandbox === "required") {
    await writeFile(log, `$ ${argv.join(" ")}\n${SANDBOX_MISSING}\n`)
    return {
      report: { id: check.id, status: "error", durationMs: 0, findings: 1, log, note: SANDBOX_MISSING },
      findings: [
        {
          file: ".",
          rule: "gates/sandbox-missing",
          severity: "error",
          message: `Did not run "${check.command}": ${SANDBOX_MISSING}`,
          fixHint: "Install bubblewrap, then run the gates again.",
          check: check.id,
        },
      ],
      failedTests: [],
    }
  }
  let result: RunResult
  try {
    if (toolMissing) throw new Error(`${argv[0]} is not installed (not found on PATH)`)
    result = await run(argv, {
      cwd: context.dir,
      timeoutMs: check.timeoutMs,
      maxOutputBytes: 5_000_000,
      signal: context.signal,
      passEnv: ["CARGO_TARGET_DIR", "GOFLAGS", "GOCACHE"],
      ...(sandboxed
        ? { sandbox: { kind: "gate" as const, root: context.root, writable: context.dir, stateDir: context.stateDir } }
        : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeFile(log, `$ ${argv.join(" ")}\n${message}\n`)
    return {
      report: { id: check.id, status: "error", durationMs: Date.now() - started, findings: 1, log, note: message },
      findings: [
        {
          file: ".",
          rule: "gates/tool-missing",
          severity: "error",
          message: `Could not run "${argv[0]}": ${message}`,
          fixHint: "Install the tool or adjust .factory/gates.json.",
          check: check.id,
        },
      ],
      failedTests: [],
    }
  }
  const output = `${result.stdout}\n${result.stderr}`
  await writeFile(
    log,
    `$ ${argv.join(" ")}\n# exit ${result.code}${result.timedOut ? " (timed out)" : ""}${result.truncated ? " (truncated)" : ""}\n${output}`,
  )
  if (check.kind === "test" && context.scope === "touched" && result.code !== 0 && NO_TESTS.test(output))
    return {
      report: {
        id: check.id,
        status: "skip",
        durationMs: result.durationMs,
        findings: 0,
        log,
        note: "no related tests matched",
      },
      findings: [],
      failedTests: [],
    }
  const parsed = parseOutput(check.parser, output, context.dir, check.id)
  let findings = parsed.findings
  if (context.scope === "touched" && (check.kind === "typecheck" || check.kind === "lint")) {
    const touched = new Set(context.files)
    findings = findings.filter((finding) => touched.has(finding.file))
  }
  const failed = result.code !== 0 || result.timedOut || findings.some((finding) => finding.severity === "error")
  if (failed && !findings.some((finding) => finding.severity === "error")) {
    const tail = output.trim().split("\n").slice(-8).join("\n")
    findings.push({
      file: ".",
      rule: result.timedOut ? `${check.id}/timeout` : `${check.id}/command-failed`,
      severity: "error",
      message: `${check.command} ${result.timedOut ? "timed out" : `exited ${result.code}`}${context.scope === "touched" && (check.kind === "typecheck" || check.kind === "lint") ? " (no findings in touched files; see log)" : ""}`,
      fixHint: `${tail.slice(0, 600)}\nFull log: ${log}`,
      check: check.id,
    })
  }
  return {
    report: {
      id: check.id,
      status: failed ? "fail" : "pass",
      durationMs: result.durationMs,
      findings: findings.length,
      log,
    },
    findings,
    failedTests: parsed.failedTests,
  }
}

export async function runGates(options: RunGatesOptions): Promise<GateReport> {
  const root = options.root
  const dir = options.dir ?? root
  const layout = factoryLayout(root)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const logDir = path.join(layout.run(options.runId ?? "adhoc"), "gates", `${stamp}-${options.scope}`)
  await mkdir(logDir, { recursive: true })
  const checks: CheckReport[] = []
  const findings: GateFinding[] = []
  const failedTests: string[] = []
  const timed = async (id: string, fn: () => Promise<GateFinding[] | undefined> | GateFinding[] | undefined) => {
    const started = Date.now()
    const result = await fn()
    if (result === undefined) {
      checks.push({ id, status: "skip", durationMs: 0, findings: 0 })
      return
    }
    findings.push(...result)
    checks.push({
      id,
      status: result.some((item) => item.severity === "error") ? "fail" : "pass",
      durationMs: Date.now() - started,
      findings: result.length,
    })
  }

  const loaded = options.config ? { config: options.config } : await loadGatesConfig(root, dir)
  const config = loaded.config
  if ("problem" in loaded && loaded.problem) findings.push(loaded.problem)

  // Change set (relative to dir), minus ignored paths.
  let files: string[]
  if (options.scope === "touched") {
    files = (options.touched ?? [])
      .map((file) => (path.isAbsolute(file) ? relativeTo(dir, file) : file.replace(/^\.\//, "")))
      .filter((file): file is string => file !== undefined && file !== ".")
  } else if (options.base) files = await changedFiles(dir, options.base)
  else files = (await git(dir, ["ls-files"], { allowFail: true })).stdout.split("\n").filter(Boolean)
  files = [...new Set(files)].filter((file) => !matchAny(file, config.ignore))
  const present = files.filter((file) => existsSync(path.join(dir, file)))

  await timed("integrity", async () => {
    const control = await verifyControl(root)
    return control.violations.map((violation) => ({
      file: ".factory",
      rule: "integrity/control-drift",
      severity: "error" as const,
      message: violation,
      check: "integrity",
    }))
  })
  if (options.phaseId)
    await timed("tool-config", () =>
      files
        .filter((file) => matchAny(file, TOOL_CONFIG))
        .map((file) => ({
          file,
          rule: "integrity/tool-config-changed",
          severity: "error" as const,
          message: "A factory phase changed lint/type/test/gate configuration",
          fixHint: "Tool configuration changes need a human waiver (`es waive integrity/tool-config-changed`).",
          check: "tool-config",
        })),
    )
  if (config.security.secrets)
    await timed("secrets", async () => {
      const out: GateFinding[] = []
      for (const file of present) {
        const text = await readFile(path.join(dir, file), "utf8").catch(() => "")
        if (text.length <= 2_000_000) out.push(...scanForSecrets(text, file))
      }
      return out
    })
  if (config.security.gitleaks === "auto") await timed("gitleaks", () => gitleaks(dir, present.slice(0, 200)))
  await timed("budgets", async () => {
    const justification = options.phaseId
      ? await readFile(layout.dependencies(options.phaseId), "utf8").catch(() => undefined)
      : undefined
    return checkBudgets({
      dir,
      files: present,
      budgets: config.budgets,
      ...(options.base ? { base: options.base, diff: await diffStats(dir, options.base) } : {}),
      ...(justification !== undefined ? { dependencyJustification: justification } : {}),
    })
  })
  if (options.scope === "full" || files.some((file) => file.startsWith(".factory/")))
    await timed("artifacts", () => validateArtifacts(root))
  if (config.security.osv !== "off" && files.some((file) => DEPENDENCY_FILES.has(path.basename(file))))
    await timed("osv", () =>
      osvFindings(dir, {
        mode: config.security.osv === "api" ? "api" : "auto",
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    )

  if (options.lsp && options.scope === "touched" && present.length)
    await timed("lsp", async () => {
      const out: GateFinding[] = []
      for (const file of present) {
        const result = await options.lsp!.diagnostics(path.join(dir, file), { maxWaitMs: 8_000 }).catch(() => undefined)
        if (!Array.isArray(result)) continue
        for (const item of result as Array<{
          severity?: number
          message: string
          code?: string | number
          source?: string
          range: { start: { line: number; character: number } }
        }>)
          if ((item.severity ?? 1) === 1)
            out.push({
              file,
              line: item.range.start.line + 1,
              column: item.range.start.character + 1,
              rule: `lsp/${item.source ?? "diagnostic"}${item.code !== undefined ? `-${item.code}` : ""}`,
              severity: "error",
              message: item.message,
              check: "lsp",
            })
      }
      return out
    })

  if (config.commands.length) {
    const { hash, lines } = await commandSetHash(dir, config.commands)
    if (!(await isTrusted(root, hash, options.stateDir))) {
      findings.push({
        file: ".factory/gates.json",
        rule: "trust/untrusted",
        severity: "error",
        message: "This project's gate commands are not trusted yet, so none were run.",
        fixHint: `A human must review and approve them: \`es trust\` (or /es-trust in the TUI). Commands:\n${lines.join("\n")}`,
        check: "trust",
      })
      checks.push({ id: "trust", status: "fail", durationMs: 0, findings: 1, note: "command set not trusted" })
    } else {
      // Touched scope: prefer the import graph for affected-test selection,
      // with runner-native selection as fallback (full suite at completion).
      let affected: AffectedTests | undefined
      if (
        options.scope === "touched" &&
        present.length &&
        config.commands.some((check) => check.kind === "test" && check.related !== "none")
      )
        affected = await affectedTests(dir, present, options.structure ?? {}).catch(() => undefined)
      for (const check of config.commands) {
        const outcome = await runCommandCheck(check, {
          dir,
          root,
          scope: options.scope,
          files: present,
          logDir,
          sandbox: options.sandbox ?? "preferred",
          stateDir: options.stateDir ?? defaultStateDir(),
          ...(affected ? { affected } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })
        checks.push(outcome.report)
        findings.push(...outcome.findings)
        failedTests.push(...outcome.failedTests)
      }
    }
  }

  const waivers = await loadWaivers(root, { ...(options.stateDir ? { stateDir: options.stateDir } : {}) })
  findings.push(...waivers.problems)
  const active = findings.filter((finding) => !isWaived(finding, waivers.active))
  const waived = findings.length - active.length
  active.sort((a, b) =>
    a.severity === b.severity
      ? a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)
      : a.severity === "error"
        ? -1
        : 1,
  )
  const errors = active.filter((finding) => finding.severity === "error").length
  const passed = errors === 0
  const summary = `${passed ? "Gates passed" : "Gates failed"}: ${errors} error(s), ${active.length - errors} warning(s), ${waived} waived · ${
    checks
      .filter((check) => check.status === "fail" || check.status === "error")
      .map((check) => check.id)
      .join(", ") || "all checks green"
  }`
  const report: GateReport = {
    passed,
    findings: active.slice(0, config.topN),
    totalFindings: active.length,
    waived,
    checks,
    summary,
    failedTests: [...new Set(failedTests)],
    testsFailed: checks.some(
      (check) =>
        config.commands.some((item) => item.id === check.id && item.kind === "test") &&
        (check.status === "fail" || check.status === "error"),
    ),
    logDir,
  }
  await writeFile(path.join(logDir, "summary.json"), JSON.stringify({ ...report, findings: active }, null, 2))
  return report
}

/** Render a report for an agent: summary plus top findings with fix hints. */
export function formatReport(report: GateReport): string {
  const lines = [report.summary]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity === "error" ? "✗" : "!"} ${finding.file}${finding.line ? `:${finding.line}` : ""}${finding.column ? `:${finding.column}` : ""} ${finding.rule}: ${finding.message}`,
    )
    if (finding.fixHint) lines.push(`    ↳ ${finding.fixHint.replaceAll("\n", "\n      ")}`)
  }
  if (report.totalFindings > report.findings.length)
    lines.push(`… ${report.totalFindings - report.findings.length} more in ${report.logDir}/summary.json`)
  return lines.join("\n")
}

/** Adapter for the factory: the engine as a GateRunner bound to a state dir. */
export function gateRunner(
  options: {
    stateDir?: string
    fetch?: typeof fetch
    lsp?: RunGatesOptions["lsp"]
    structure?: RunGatesOptions["structure"]
  } = {},
) {
  return (request: {
    root: string
    dir: string
    scope: "touched" | "full"
    touched?: readonly string[]
    base?: string
    phaseId?: string
    runId?: string
  }) =>
    runGates({
      ...request,
      // The factory's own gate runs execute the programmer's code: sandbox or refuse.
      sandbox: "required",
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.lsp ? { lsp: options.lsp } : {}),
      ...(options.structure ? { structure: options.structure } : {}),
    })
}
