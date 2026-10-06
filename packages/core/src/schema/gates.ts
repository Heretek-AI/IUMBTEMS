import { z } from "zod"

export const GateFindingSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  rule: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  fixHint: z.string().optional(),
  /** Check that produced the finding (e.g. "lint", "secrets"). */
  check: z.string().optional(),
})
export type GateFinding = z.infer<typeof GateFindingSchema>

export const ParserIdSchema = z.enum([
  "tsc",
  "biome",
  "eslint",
  "prettier",
  "ruff",
  "ruff-format",
  "mypy",
  "cargo",
  "gofmt",
  "go-vet",
  "bun-test",
  "vitest",
  "jest",
  "pytest",
  "go-test",
  "cargo-test",
  "generic",
])
export type ParserId = z.infer<typeof ParserIdSchema>

export const RelatedTestsSchema = z.enum(["bun", "vitest", "jest", "pytest", "go", "none"])
export type RelatedTests = z.infer<typeof RelatedTestsSchema>

export const CommandCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.enum(["format", "lint", "typecheck", "test"]),
  /** argv string, run without a shell in the target directory. */
  command: z.string().min(1),
  parser: ParserIdSchema.default("generic"),
  /** Append touched files (filtered by `extensions`) when the gate scope is "touched". */
  touchedArgs: z.boolean().default(false),
  extensions: z.array(z.string()).default([]),
  /** Runner-native related-test selection for touched scope (test checks only). */
  related: RelatedTestsSchema.default("none"),
  timeoutMs: z.number().int().positive().default(300_000),
})
export type CommandCheck = z.infer<typeof CommandCheckSchema>

export const GateBudgetsSchema = z.object({
  maxDiffLines: z.number().int().positive().default(800),
  maxFileLines: z.number().int().positive().default(800),
  /** Max decision points in one function (approximate cyclomatic complexity). */
  maxComplexity: z.number().int().positive().default(15),
  requireDepJustification: z.boolean().default(true),
  /** A diff that changes source must also change a test. */
  requireTestWithBehavior: z.boolean().default(true),
})
export type GateBudgets = z.infer<typeof GateBudgetsSchema>

export const GateSecuritySchema = z.object({
  secrets: z.boolean().default(true),
  gitleaks: z.enum(["auto", "off"]).default("auto"),
  /** "auto": osv-scanner when installed, else the OSV API; "off" disables. */
  osv: z.enum(["auto", "api", "off"]).default("auto"),
})
export type GateSecurity = z.infer<typeof GateSecuritySchema>

export const GatesConfigSchema = z.object({
  version: z.literal(1).default(1),
  commands: z.array(CommandCheckSchema).default([]),
  budgets: GateBudgetsSchema.default(GateBudgetsSchema.parse({})),
  security: GateSecuritySchema.default(GateSecuritySchema.parse({})),
  /** Max findings returned to the agent (the full list is in the run log). */
  topN: z.number().int().positive().default(20),
  /** Glob patterns excluded from built-in scans (secrets, budgets). */
  ignore: z.array(z.string()).default(["**/node_modules/**", "**/dist/**", "**/*.lock", "**/*.min.js"]),
})
export type GatesConfig = z.infer<typeof GatesConfigSchema>

export const CheckStatusSchema = z.enum(["pass", "fail", "skip", "error"])
export type CheckStatus = z.infer<typeof CheckStatusSchema>

export interface CheckReport {
  readonly id: string
  readonly status: CheckStatus
  readonly durationMs: number
  readonly findings: number
  readonly log?: string
  readonly note?: string
}

export interface GateReport {
  readonly passed: boolean
  /** Top-N active findings, errors first. */
  readonly findings: readonly GateFinding[]
  readonly totalFindings: number
  readonly waived: number
  readonly checks: readonly CheckReport[]
  readonly summary: string
  readonly failedTests: readonly string[]
  /** A test command failed (even when no test file could be attributed). */
  readonly testsFailed: boolean
  readonly logDir: string
}
