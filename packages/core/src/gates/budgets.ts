import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { GateFinding } from "../schema/gates.ts"

export interface BudgetOptions {
  readonly maxFileLines?: number
  readonly maxDiffLines?: number
  readonly requireDepJustification?: boolean
  readonly phaseId?: string
  readonly diffStats?: { added: number; removed: number }
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "poetry.lock",
  "requirements.txt",
])

export async function checkBudgets(
  rootDir: string,
  files: readonly string[],
  options: BudgetOptions = {},
): Promise<GateFinding[]> {
  const findings: GateFinding[] = []
  const maxFileLines = options.maxFileLines ?? 800
  const maxDiffLines = options.maxDiffLines ?? 500
  const requireDepJustification = options.requireDepJustification ?? true

  // 1. Check max file lines
  for (const relPath of files) {
    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(rootDir, relPath)
    try {
      const content = await readFile(fullPath, "utf8")
      const lineCount = content.split("\n").length
      if (lineCount > maxFileLines) {
        findings.push({
          file: relPath,
          line: maxFileLines,
          rule: "budget/file-length",
          severity: "error",
          message: `File exceeds maximum length budget (${lineCount} > ${maxFileLines} lines)`,
          fixHint: "Decompose into smaller focused modules or helper files.",
        })
      }
    } catch {
      // file might be deleted or binary, skip
    }
  }

  // 2. Check diff budget
  if (options.diffStats) {
    const totalDiff = options.diffStats.added + options.diffStats.removed
    if (totalDiff > maxDiffLines) {
      findings.push({
        file: "diff",
        rule: "budget/diff-size",
        severity: "error",
        message: `Phase diff exceeds budget (${totalDiff} lines changed > max ${maxDiffLines})`,
        fixHint: "Split the phase into smaller vertical slices.",
      })
    }
  }

  // 3. Check dependency justification
  if (requireDepJustification) {
    const touchesDepManifest = files.some((f) => {
      const base = path.basename(f)
      return MANIFEST_NAMES.has(base)
    })

    if (touchesDepManifest) {
      const phaseId = options.phaseId ?? "active"
      const justificationPath = path.join(rootDir, ".factory", "specs", phaseId, "DEPENDENCIES.md")
      let justificationExists = false
      try {
        const s = await stat(justificationPath)
        justificationExists = s.isFile()
      } catch {
        justificationExists = false
      }

      if (!justificationExists) {
        findings.push({
          file: files.find((f) => MANIFEST_NAMES.has(path.basename(f))) ?? "package.json",
          rule: "budget/dependency-justification",
          severity: "error",
          message:
            "Dependency manifest modified without recorded justification in .factory/specs/<phase>/DEPENDENCIES.md",
          fixHint: `Create .factory/specs/${phaseId}/DEPENDENCIES.md explaining rationale, license, and security evaluation.`,
        })
      }
    }
  }

  return findings
}
