// Harness-neutral code-audit tools. es_audit_open (factory seat) opens or
// re-opens an audit of the active phase or a path; es_audit_verdict (the
// auditor seats) witnesses every finding against the audited tree before the
// verdict reaches the state machine, then writes the round's dossier and report.
import { seatOf } from "../agents/registry.ts"
import { FactoryError } from "../factory/machine.ts"
import { type AuditTarget, describeTarget } from "../factory/state.ts"
import { factoryLayout } from "../layout.ts"
import type { EsToolDef } from "../ops/tools.ts"
import { type OpsContext, ToolRefusal } from "../ops/tools.ts"
import { AuditFindingSchema } from "../schema/codeaudit.ts"
import { relativeTo } from "../trust/paths.ts"
import { verdictProblem, witnessFindings } from "./findings.ts"
import { appendAuditRecord, rewriteAuditReport, writeAuditArtifacts } from "./store.ts"

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const FINDING_INPUT = object(
  {
    kind: { type: "string", enum: ["invariant", "vulnerability", "debt"] },
    title: { type: "string" },
    severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
    cwe: { type: "string", description: "CWE-<number>; required for a vulnerability" },
    file: { type: "string", description: "Path relative to the audited tree's root" },
    lines: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description: "[start, end], 1-based, inclusive",
    },
    excerpt: { type: "string", description: "Verbatim code from those lines (at least 12 characters)" },
    detail: {
      type: "string",
      description: "What is wrong (or what the invariant guarantees); for a vulnerability, the exploit sequence",
    },
    remediation: { type: "string", description: "The concrete change; required for a vulnerability" },
    holds: { type: "boolean", description: "Invariants only: does the code keep it?" },
  },
  ["kind", "title", "severity", "file", "lines", "excerpt", "detail"],
)

/** "alpha" (an existing phase id) is a phase target; anything else is a path. */
export function parseAuditTarget(raw: string, phases: readonly string[]): AuditTarget {
  const target = raw.trim().replace(/^phase:/, "")
  if (raw.trim().startsWith("phase:") || phases.includes(target)) return { kind: "phase", phase: target }
  return { kind: "path", path: raw.trim().replace(/^path:/, "") }
}

export function codeAuditTools(ops: OpsContext): EsToolDef[] {
  const { factory, root } = ops
  return [
    {
      name: "es_audit_open",
      description:
        "Factory only: open (or re-open for a new round) a code audit of the active phase (its id) or a path in the project, at any stage. Then launch es-auditor-thesis and es-auditor-antithesis with the audit id. Audits block until they pass.",
      input: object(
        {
          target: { type: "string", description: 'The active phase id (or "phase:<id>"), or a path in the project' },
        },
        ["target"],
      ),
      execute: async ({ target }, context) => {
        const state = await factory.read()
        const parsed = parseAuditTarget(
          String(target),
          (state?.phases ?? []).map((phase) => phase.id),
        )
        const { audit } = await factory.openAudit(context.agent, parsed)
        const tree = await factory.auditTree(audit.id).catch(() => undefined)
        const dir = tree ? (relativeTo(root, tree.root) ?? tree.root) : "."
        return [
          `Opened ${audit.id} (round ${audit.round}) on ${describeTarget(audit.target)}.`,
          `Launch es-auditor-thesis and es-auditor-antithesis in parallel with: audit "${audit.id}", target ${describeTarget(audit.target)}, read under ${dir}${audit.target.kind === "path" ? ` (findings must point inside ${audit.target.path})` : ""}.`,
          audit.target.kind === "phase"
            ? "Phase audits take verdicts once the phase is in QA (its committed head)."
            : "It blocks the next stage transition until it passes.",
        ].join("\n")
      },
    },
    {
      name: "es_audit_verdict",
      description:
        "Auditor seats only: record your verdict for an audit round. Every finding must cite file, lines [start,end] and a verbatim excerpt of those lines; any hallucinated reference refuses the whole verdict. fail needs at least one witnessed defect (a vulnerability with its CWE, or an invariant that does not hold).",
      input: object(
        {
          audit: { type: "string", description: "The audit id (audit-NN)" },
          verdict: { type: "string", enum: ["pass", "fail"] },
          findings: { type: "array", items: FINDING_INPUT },
          notes: { type: "string" },
        },
        ["audit", "verdict", "findings", "notes"],
      ),
      execute: async ({ audit: auditId, verdict, findings, notes }, context) => {
        const seat = seatOf(context.agent)
        if (seat !== "auditor-thesis" && seat !== "auditor-antithesis")
          throw new ToolRefusal("Only the auditor seats may record audit verdicts.")
        const parsed = AuditFindingSchema.array().safeParse(findings ?? [])
        if (!parsed.success)
          throw new ToolRefusal(
            `Malformed findings: ${parsed.error.issues.map((issue) => `findings.${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
          )
        const tree = await factory.auditTree(String(auditId)).catch((error: Error) => {
          throw new ToolRefusal(error.message)
        })
        const refusal = (error: unknown): never => {
          throw error instanceof FactoryError ? new ToolRefusal(error.message) : error
        }
        const round = (await factory.checkAuditVerdict(context.agent, tree.audit.id).catch(refusal)).round
        const bad = await witnessFindings(tree.root, tree.scope, parsed.data)
        if (bad.length)
          throw new ToolRefusal(
            `Refused: ${bad.length} finding(s) do not point at real code, so nothing was recorded. Fix each reference and call again.\n${bad
              .map((item) => `- ${item.pointer}: ${item.reason}`)
              .join("\n")}`,
          )
        const problem = verdictProblem(verdict, parsed.data, seat)
        if (problem) throw new ToolRefusal(problem)
        // Evidence first, while the audited tree still exists: a passing phase
        // audit merges the phase and removes its worktree.
        await appendAuditRecord(root, {
          audit: tree.audit.id,
          round,
          seat,
          by: context.agent,
          verdict,
          notes: String(notes),
          findings: parsed.data,
          at: new Date().toISOString(),
        })
        await writeAuditArtifacts(root, tree.audit, round, tree)
        const recorded = await factory.auditVerdict(context.agent, tree.audit.id, verdict, String(notes)).catch(refusal)
        await rewriteAuditReport(root, recorded.audit, round)
        const status =
          recorded.audit.round !== recorded.round
            ? `the round settled as a fail and the phase went back to the programmer (audit re-opened as round ${recorded.audit.round})`
            : recorded.audit.status === "open"
              ? recorded.audit.thesis && recorded.audit.antithesis
                ? "the auditors disagree: the manager breaks the tie (es_tiebreak with audit)"
                : "waiting for the other auditor"
              : `the audit is ${recorded.audit.status}`
        return `Recorded ${verdict} for ${tree.audit.id} round ${recorded.round} with ${parsed.data.length} witnessed finding(s); ${status}. Report: ${relativeTo(root, factoryLayout(root).auditReport(tree.audit.id))}`
      },
    },
  ]
}
