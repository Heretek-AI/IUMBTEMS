// Code-audit artifacts under .factory/audits/<id>/ (control files, written
// only here): records.json (every seat's verdict and findings, per round),
// dossier.json (the findings as witnessed location claims) and REPORT.md.
import { normalizeClaim } from "../claims/claim.ts"
import { buildDossier, writeDossier } from "../claims/dossier.ts"
import { explainDossierRank, rankDossiers } from "../claims/rank.ts"
import { type Audit, describeTarget } from "../factory/state.ts"
import { stateDir as defaultStateDir, factoryLayout } from "../layout.ts"
import { researchCache } from "../research/ops.ts"
import type { Dossier } from "../schema/claims.ts"
import { type AuditFinding, type AuditRecord, AuditRecordSchema } from "../schema/codeaudit.ts"
import { atomicWrite, readJson, withLock, writeJson } from "../util/fs.ts"
import { isDefect, pointer } from "./findings.ts"

export async function readAuditRecords(root: string, auditId: string): Promise<AuditRecord[]> {
  const file = factoryLayout(root).auditRecords(auditId)
  const raw = await readJson<unknown[]>(file)
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${file} is corrupt (expected an array)`)
  return raw.map((entry) => AuditRecordSchema.parse(entry))
}

export async function appendAuditRecord(root: string, record: AuditRecord): Promise<void> {
  const file = factoryLayout(root).auditRecords(record.audit)
  await withLock(file, async () => {
    const records = await readAuditRecords(root, record.audit)
    records.push(AuditRecordSchema.parse(record))
    await writeJson(file, records)
  })
}

/** The latest record per seat in a round. */
export function roundRecords(records: readonly AuditRecord[], round: number): AuditRecord[] {
  const latest = new Map<string, AuditRecord>()
  for (const record of records) if (record.round === round) latest.set(record.seat, record)
  return [...latest.values()].sort((a, b) => (a.seat < b.seat ? 1 : -1)) // thesis, then antithesis
}

export const findingStatement = (finding: AuditFinding) =>
  `${finding.kind}${finding.cwe ? ` ${finding.cwe}` : ""} (${finding.severity}): ${finding.title} — ${finding.detail}`

const SEVERITY = ["critical", "high", "medium", "low", "info"] as const

/** Write the round's dossier (findings as witnessed claims) and REPORT.md. */
export async function writeAuditArtifacts(
  root: string,
  audit: Audit,
  round: number,
  tree: { root: string },
  /** Engine-key dir for the sealed source cache (#98); defaults to the global state dir. */
  stateDir?: string,
): Promise<{ dossier: Dossier; report: string }> {
  const layout = factoryLayout(root)
  const records = roundRecords(await readAuditRecords(root, audit.id), round)
  const claims = records.flatMap((record) =>
    record.findings.map((finding) =>
      normalizeClaim({
        tag: "VERIFIED",
        statement: findingStatement(finding),
        location: { file: finding.file.replace(/^\.\//, ""), lines: finding.lines, excerpt: finding.excerpt },
        severity: finding.severity,
      }),
    ),
  )
  const dossier = await writeDossier(
    layout.auditDossier(audit.id),
    buildDossier({
      mode: "code-audit",
      subject: `${describeTarget(audit.target)} (round ${round})`,
      claims,
      verdicts: records.map((record) => ({
        by: record.by,
        verdict: record.verdict,
        at: record.at,
        notes: record.notes,
      })),
    }),
    { cache: researchCache(root, stateDir ?? defaultStateDir()), root: tree.root },
  )
  const report = renderAuditReport(audit, round, records)
  await atomicWrite(layout.auditReport(audit.id), report)
  return { dossier, report }
}

/** Re-render a round's report from its records (no disk witness), after the verdict settles the audit. */
export async function rewriteAuditReport(root: string, audit: Audit, round: number): Promise<void> {
  const records = roundRecords(await readAuditRecords(root, audit.id), round)
  await atomicWrite(factoryLayout(root).auditReport(audit.id), renderAuditReport(audit, round, records))
}

/** Deterministic markdown: verdicts, then findings by severity, file and line. */
export function renderAuditReport(audit: Audit, round: number, records: readonly AuditRecord[]): string {
  const seat = (name: AuditRecord["seat"]) => records.find((record) => record.seat === name)
  const findings = records
    .flatMap((record) => record.findings.map((finding) => ({ finding, seat: record.seat.replace("auditor-", "") })))
    .sort(
      (a, b) =>
        SEVERITY.indexOf(a.finding.severity) - SEVERITY.indexOf(b.finding.severity) ||
        (a.finding.file < b.finding.file ? -1 : a.finding.file > b.finding.file ? 1 : 0) ||
        a.finding.lines[0] - b.finding.lines[0],
    )
  const lines = [
    `# Code audit ${audit.id}: ${describeTarget(audit.target)} (round ${round})`,
    "",
    `Status: ${audit.round === round ? audit.status : "superseded"} · thesis: ${seat("auditor-thesis")?.verdict ?? "—"} · antithesis: ${seat("auditor-antithesis")?.verdict ?? "—"}${audit.tiebreak && audit.round === round ? ` · tiebreak: ${audit.tiebreak.verdict}` : ""}`,
    "",
    "Every finding below was witnessed against the audited tree: the file exists, the lines are in range and the excerpt is verbatim.",
    "",
    "## Findings",
    "",
  ]
  if (!findings.length) lines.push("No findings were recorded.", "")
  else {
    lines.push("| Severity | Kind | CWE | Location | Finding | Seat |", "| --- | --- | --- | --- | --- | --- |")
    for (const { finding, seat: who } of findings)
      lines.push(
        `| ${finding.severity} | ${finding.kind}${finding.kind === "invariant" ? (finding.holds ? " (holds)" : " (broken)") : ""} | ${finding.cwe ?? ""} | \`${pointer(finding)}\` | ${finding.title.replaceAll("|", "\\|")} | ${who} |`,
      )
    lines.push("")
    for (const { finding, seat: who } of findings) {
      lines.push(
        `### ${finding.title}`,
        "",
        `\`${pointer(finding)}\` · ${finding.severity}${finding.cwe ? ` · ${finding.cwe}` : ""} · ${who}`,
        "",
        "```",
        finding.excerpt,
        "```",
        "",
        finding.detail,
        "",
      )
      if (finding.remediation) lines.push(`**Remediation:** ${finding.remediation}`, "")
    }
  }
  lines.push("## Verdict notes", "")
  for (const record of records)
    lines.push(`- **${record.seat.replace("auditor-", "")}** (${record.verdict}): ${record.notes || "—"}`)
  return `${lines.join("\n").trimEnd()}\n`
}

/** The two seats' findings for a round, ranked as rival dossiers (shown to the manager at a tiebreak). */
export async function auditRankView(root: string, auditId: string, round: number): Promise<string[]> {
  const records = roundRecords(await readAuditRecords(root, auditId), round)
  const dossiers = records.map((record) =>
    buildDossier({
      mode: "code-audit",
      subject: `${record.seat.replace("auditor-", "")} (${record.verdict})`,
      claims: record.findings.map((finding) => ({
        ...normalizeClaim({
          tag: "VERIFIED",
          statement: findingStatement(finding),
          location: { file: finding.file, lines: finding.lines, excerpt: finding.excerpt },
          severity: finding.severity,
        }),
        witness: { ok: true, checkedAt: record.at },
      })),
    }),
  )
  const defects = (record: AuditRecord) =>
    record.findings.filter(isDefect).map((finding) => `${finding.cwe ?? finding.kind} ${pointer(finding)}`)
  return [
    ...rankDossiers(dossiers).map(explainDossierRank),
    ...records.map(
      (record) =>
        `${record.seat.replace("auditor-", "")}: ${record.verdict}, ${record.findings.length} finding(s)${defects(record).length ? `; defects: ${defects(record).join(", ")}` : ""}`,
    ),
  ]
}
