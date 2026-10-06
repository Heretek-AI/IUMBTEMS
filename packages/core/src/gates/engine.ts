import { mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { type GateFinding, type GateResult, type GatesConfig, GatesConfigSchema } from "../schema/gates.ts"
import { isWaiverActive, type Waiver, WaiverSchema } from "../schema/waiver.ts"
import { atomicWrite } from "../util/fs.ts"
import { matchGlob } from "../util/glob.ts"
import { parseJsonc } from "../util/jsonc.ts"
import { runCommand } from "../util/proc.ts"
import { checkBudgets } from "./budgets.ts"
import { detectProjectGates } from "./detector.ts"
import { scanForSecrets } from "./secrets.ts"

export interface GateEngineOptions {
  readonly touchedFiles?: readonly string[]
  readonly phaseId?: string
  readonly config?: GatesConfig
  readonly diffStats?: { added: number; removed: number }
  readonly skipExecution?: boolean // For dry-run or testing
}

export async function loadGatesConfig(rootDir: string): Promise<GatesConfig> {
  const configFile = path.join(rootDir, ".factory", "gates.json")
  try {
    const raw = await readFile(configFile, "utf8")
    return GatesConfigSchema.parse(parseJsonc(raw))
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return detectProjectGates(rootDir)
    }
    throw err
  }
}

export async function loadActiveWaivers(rootDir: string): Promise<Waiver[]> {
  const waiversDir = path.join(rootDir, ".factory", "waivers")
  const waivers: Waiver[] = []
  try {
    const files = await readdir(waiversDir)
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      try {
        const raw = await readFile(path.join(waiversDir, f), "utf8")
        const parsed = WaiverSchema.parse(JSON.parse(raw))
        if (isWaiverActive(parsed)) {
          waivers.push(parsed)
        }
      } catch {
        // Skip malformed waiver files
      }
    }
  } catch {
    // No waivers directory
  }
  return waivers
}

export async function runGates(rootDir: string, options: GateEngineOptions = {}): Promise<GateResult> {
  const config = options.config ?? (await loadGatesConfig(rootDir))
  const waivers = await loadActiveWaivers(rootDir)
  const touchedFiles = options.touchedFiles ?? []

  const rawFindings: GateFinding[] = []

  // 1. Secrets scan on touched files
  if (config.security.secrets) {
    for (const file of touchedFiles) {
      const fullPath = path.isAbsolute(file) ? file : path.join(rootDir, file)
      try {
        const content = await readFile(fullPath, "utf8")
        rawFindings.push(...scanForSecrets(content, file))
      } catch {
        // file unreadable or deleted
      }
    }
  }

  // 2. Budget checks
  const budgetFindings = await checkBudgets(rootDir, touchedFiles, {
    maxDiffLines: config.budgets.maxDiffLines,
    maxFileLines: config.budgets.maxFileLines,
    requireDepJustification: config.budgets.requireDepJustification,
    phaseId: options.phaseId,
    diffStats: options.diffStats,
  })
  rawFindings.push(...budgetFindings)

  // 3. Command executions (if not skipExecution)
  if (!options.skipExecution) {
    // Lint command
    if (config.commands.lint?.command) {
      const res = await runCommand(config.commands.lint.command, {
        cwd: rootDir,
        timeoutMs: 60000,
      })
      if (res.code !== 0) {
        rawFindings.push({
          file: "workspace",
          rule: "lint/check",
          severity: "error",
          message: `Lint command failed with exit code ${res.code}`,
          fixHint: (res.stderr || res.stdout).slice(0, 300),
        })
      }
    }

    // Typecheck command
    if (config.commands.typecheck?.command) {
      const res = await runCommand(config.commands.typecheck.command, {
        cwd: rootDir,
        timeoutMs: 60000,
      })
      if (res.code !== 0) {
        rawFindings.push({
          file: "workspace",
          rule: "typecheck/check",
          severity: "error",
          message: `Typecheck command failed with exit code ${res.code}`,
          fixHint: (res.stderr || res.stdout).slice(0, 300),
        })
      }
    }

    // Test command
    if (config.commands.test?.command) {
      const res = await runCommand(config.commands.test.command, {
        cwd: rootDir,
        timeoutMs: 90000,
      })
      if (res.code !== 0) {
        rawFindings.push({
          file: "workspace",
          rule: "test/runner",
          severity: "error",
          message: `Tests failed with exit code ${res.code}`,
          fixHint: (res.stderr || res.stdout).slice(0, 300),
        })
      }
    }
  }

  // Filter against active waivers
  let waiverCount = 0
  const activeFindings: GateFinding[] = []

  for (const finding of rawFindings) {
    const isWaived = waivers.some((w) => {
      const ruleMatches = w.rule === finding.rule || w.rule === "*"
      const fileMatches = matchGlob(finding.file, w.filePattern)
      return ruleMatches && fileMatches
    })

    if (isWaived) {
      waiverCount++
    } else {
      activeFindings.push(finding)
    }
  }

  // Top-N format (up to 10 findings)
  const topFindings = activeFindings.slice(0, 10)
  const passed = activeFindings.every((f) => f.severity !== "error")

  const summary = passed
    ? `Gates passed (${activeFindings.length} warnings, ${waiverCount} waived)`
    : `Gates failed: ${activeFindings.filter((f) => f.severity === "error").length} errors, ${activeFindings.filter((f) => f.severity === "warning").length} warnings (${waiverCount} waived)`

  // Write runtime findings
  const runtimeDir = path.join(rootDir, ".factory", "runtime")
  await mkdir(runtimeDir, { recursive: true })
  await atomicWrite(
    path.join(runtimeDir, "gate-findings.json"),
    JSON.stringify({ passed, findings: activeFindings, waiverCount, summary }, null, 2),
  )

  return {
    passed,
    findings: topFindings,
    waiverCount,
    summary,
  }
}
