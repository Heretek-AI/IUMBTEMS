// Code-audit findings: what the thesis/antithesis auditors record with
// es_audit_verdict. Every finding points at verbatim lines of the audited
// tree; the tool witnesses each one before a verdict is recorded.
import { z } from "zod"

export const AuditSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"])
export type AuditSeverity = z.infer<typeof AuditSeveritySchema>

export const AuditFindingSchema = z
  .object({
    /** invariant: a guarantee the thesis maps (holds or not); vulnerability: an exploitable defect; debt: a lesser problem. */
    kind: z.enum(["invariant", "vulnerability", "debt"]),
    title: z.string().min(3),
    severity: AuditSeveritySchema,
    cwe: z
      .string()
      .regex(/^CWE-\d+$/, "expected CWE-<number>")
      .optional(),
    /** POSIX path relative to the audited tree's root. */
    file: z.string().min(1),
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    /** Verbatim code from those lines (at least 12 characters). */
    excerpt: z.string().min(1),
    detail: z.string().min(8),
    remediation: z.string().optional(),
    /** Invariants only: does the code keep it? */
    holds: z.boolean().optional(),
  })
  .superRefine((finding, issue) => {
    if (finding.lines[0] > finding.lines[1])
      issue.addIssue({ code: "custom", path: ["lines"], message: "line range starts after it ends" })
    if (finding.kind === "vulnerability" && !finding.cwe)
      issue.addIssue({ code: "custom", path: ["cwe"], message: "a vulnerability needs its CWE id" })
    if (finding.kind === "vulnerability" && !finding.remediation)
      issue.addIssue({ code: "custom", path: ["remediation"], message: "a vulnerability needs a concrete remediation" })
    if (finding.kind === "invariant" && finding.holds === undefined)
      issue.addIssue({ code: "custom", path: ["holds"], message: "say whether the invariant holds" })
  })
export type AuditFinding = z.infer<typeof AuditFindingSchema>

/** One seat's verdict in one round, with its witnessed findings. */
export const AuditRecordSchema = z.object({
  audit: z.string(),
  round: z.number().int().positive(),
  seat: z.enum(["auditor-thesis", "auditor-antithesis"]),
  by: z.string(),
  verdict: z.enum(["pass", "fail"]),
  notes: z.string(),
  findings: z.array(AuditFindingSchema),
  at: z.string(),
})
export type AuditRecord = z.infer<typeof AuditRecordSchema>
