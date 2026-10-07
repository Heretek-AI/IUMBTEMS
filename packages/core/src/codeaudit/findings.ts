// The line-pointer law: every audit finding names a file, a line range and a
// verbatim excerpt of the audited tree, and is witnessed against the bytes on
// disk before any verdict is recorded. Legacy only ever checked quotes against
// the agent's own cache, so a hallucinated line could pass; here it cannot.
import { checkLocation } from "../claims/witness.ts"
import type { AuditFinding } from "../schema/codeaudit.ts"

export const pointer = (finding: Pick<AuditFinding, "file" | "lines">) =>
  `${finding.file}#L${finding.lines[0]}-L${finding.lines[1]}`

const insideScope = (file: string, scope: string) =>
  scope === "." || file === scope || file.startsWith(`${scope.replace(/\/$/, "")}/`)

/** Every finding that does not point at real code, with why. Empty means all witnessed. */
export async function witnessFindings(
  root: string,
  scope: string,
  findings: readonly AuditFinding[],
): Promise<Array<{ pointer: string; reason: string }>> {
  const failures: Array<{ pointer: string; reason: string }> = []
  for (const finding of findings) {
    const file = finding.file.replace(/^\.\//, "")
    if (/^\.git(\/|$)/.test(file)) {
      failures.push({ pointer: pointer(finding), reason: "git internals are not audited code" })
      continue
    }
    if (!insideScope(file, scope)) {
      failures.push({ pointer: pointer(finding), reason: `outside the audit target (${scope})` })
      continue
    }
    const check = await checkLocation(root, { file, lines: finding.lines, excerpt: finding.excerpt })
    if (!check.ok) failures.push({ pointer: pointer(finding), reason: check.reason })
  }
  return failures
}

/** A finding that makes the code unsound: a vulnerability, or an invariant that does not hold. */
export const isDefect = (finding: AuditFinding) =>
  finding.kind === "vulnerability" || (finding.kind === "invariant" && finding.holds === false)

/** Why this verdict does not fit its findings (undefined when it does). */
export function verdictProblem(verdict: "pass" | "fail", findings: readonly AuditFinding[]): string | undefined {
  const defects = findings.filter(isDefect)
  if (verdict === "fail" && defects.length === 0)
    return "A fail needs at least one witnessed defect: a vulnerability (with its CWE) or an invariant that does not hold."
  if (verdict === "pass" && defects.length > 0)
    return `A pass cannot carry defects (${defects.map(pointer).join(", ")}); record fail, or drop findings that are not real.`
  return undefined
}
