// Read-only telemetry harvester over factory runs and eval results (#135).
// It aggregates what runs already record — factory state (phases, replans,
// halts, spend), gate summaries, audit records and the hash-chained audit
// log — plus eval aggregates, into one normalized, versioned dataset for the
// distiller (#136). It never writes to the harvested roots and never repairs
// a broken audit chain: a break is reported in `auditChain`.
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { verifyAuditChain } from "../audit/chain.ts"
import { type FactoryState, FactoryStateSchema } from "../factory/state.ts"
import { stateDir as defaultStateDir, factoryLayout } from "../layout.ts"
import type { AuditEntry } from "../schema/audit.ts"
import { AuditRecordSchema } from "../schema/codeaudit.ts"
import {
  type AuditFindingCount,
  type ChainTrailEntry,
  type EvalTelemetry,
  type FailureEntry,
  type GateRejection,
  type RunStateSeal,
  type RunTelemetry,
  TELEMETRY_VERSION,
  type Telemetry,
  TelemetrySchema,
} from "../schema/improve.ts"
import type { SidecarProblem } from "../trust/sidecar.ts"
import { verifyEngineFile } from "../trust/sidecar.ts"
import { compareStrings } from "../util/compare.ts"
import { exists } from "../util/fs.ts"

/** A harvested run root plus its evals dir: everything here is read-only. */
export interface HarvestInput {
  /** Project roots whose `.factory/` trees are harvested (run id = base name). */
  readonly runs: readonly string[]
  /** Eval result directories (`evals/results/<stamp>.json` aggregates). */
  readonly evals: readonly string[]
}

const countBy = (keys: readonly string[]): Array<{ key: string; count: number }> => {
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  const entries = [...counts.entries()]
  entries.sort(([a], [b]) => compareStrings(a, b))
  return entries.map(([key, count]) => ({ key, count }))
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

/** Every gate summary under `.factory/runs/`, deepest first in stable order. */
async function gateSummaries(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const ordered = [...entries]
  ordered.sort(compareStrings)
  const found: string[] = []
  const subdirs: string[] = []
  for (const name of ordered) {
    if (name === "summary.json") found.push(path.join(dir, name))
    else subdirs.push(name)
  }
  const nested = await Promise.all(
    subdirs.map(async (name) => {
      const full = path.join(dir, name)
      const info = await stat(full).catch(() => undefined)
      if (info?.isDirectory() !== true) return []
      return gateSummaries(full)
    }),
  )
  for (const group of nested) found.push(...group)
  return found
}

interface GateFinding {
  readonly rule: string
  readonly message?: string
  readonly file?: string
  readonly line?: number
}

/** Every finding with a rule in one gate summary, in file order. */
const findingsFromSummary = (parsed: unknown): GateFinding[] => {
  if (typeof parsed !== "object" || parsed === null) return []
  const findings = (parsed as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return []
  const out: GateFinding[] = []
  for (const finding of findings) {
    if (typeof finding !== "object" || finding === null) continue
    const record = finding as { rule?: unknown; message?: unknown; file?: unknown; line?: unknown }
    if (typeof record.rule !== "string" || !record.rule) continue
    const entry: { rule: string; message?: string; file?: string; line?: number } = { rule: record.rule }
    if (typeof record.message === "string" && record.message) entry.message = record.message
    if (typeof record.file === "string" && record.file) entry.file = record.file
    if (typeof record.line === "number" && Number.isInteger(record.line)) entry.line = record.line
    out.push(entry)
  }
  return out
}

/** Human reason for a gate finding: its message plus the file location. */
const gateReason = (finding: GateFinding): string => {
  const where = finding.file ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""})` : ""
  return `${finding.message ?? finding.rule}${where}`
}

/** Gate findings across every gate summary under `.factory/runs/`, counted by rule. */
async function harvestGateRejections(root: string): Promise<{ rejections: GateRejection[]; findings: GateFinding[] }> {
  const summaries = await gateSummaries(factoryLayout(root).runs)
  const parsed = await Promise.all(summaries.map((file) => readJson(file)))
  const counts = new Map<string, { count: number; logs: Set<string> }>()
  const findings: GateFinding[] = []
  for (let index = 0; index < summaries.length; index++) {
    const rel = path.relative(root, summaries[index]!)
    for (const finding of findingsFromSummary(parsed[index])) {
      findings.push(finding)
      let entry = counts.get(finding.rule)
      if (!entry) {
        entry = { count: 0, logs: new Set() }
        counts.set(finding.rule, entry)
      }
      entry.count += 1
      entry.logs.add(rel)
    }
  }
  return {
    rejections: countBy([...counts.keys()]).map(({ key }) => {
      const entry = counts.get(key)!
      const logs = [...entry.logs]
      logs.sort(compareStrings)
      return { rule: key, count: entry.count, logs }
    }),
    findings,
  }
}

interface HarvestedAuditFinding {
  readonly seat: string
  readonly kind: string
  readonly severity: string
  readonly reason: string
}

/** Every witnessed finding in one audit records file, with its seat. */
function findingsFromRecords(raw: unknown): HarvestedAuditFinding[] {
  if (!Array.isArray(raw)) return []
  const out: HarvestedAuditFinding[] = []
  for (const entry of raw) {
    const parsed = AuditRecordSchema.safeParse(entry)
    if (!parsed.success) continue
    for (const finding of parsed.data.findings)
      out.push({
        seat: parsed.data.seat,
        kind: finding.kind,
        severity: finding.severity,
        reason: finding.detail || finding.excerpt || finding.title,
      })
  }
  return out
}

/** Code-audit records under `.factory/audits/`, counted by finding kind and severity. */
async function harvestAuditFindings(
  root: string,
): Promise<{ counts: AuditFindingCount[]; findings: HarvestedAuditFinding[] }> {
  const auditsDir = factoryLayout(root).audits
  let ids: string[]
  try {
    ids = await readdir(auditsDir)
  } catch {
    return { counts: [], findings: [] }
  }
  const ordered = [...ids]
  ordered.sort(compareStrings)
  const raws = await Promise.all(ordered.map((id) => readJson(path.join(auditsDir, id, "records.json"))))
  const sources = new Map<string, Set<string>>()
  const findings: HarvestedAuditFinding[] = []
  for (let index = 0; index < ordered.length; index++) {
    const rel = path.relative(root, path.join(auditsDir, ordered[index]!, "records.json"))
    for (const finding of findingsFromRecords(raws[index])) {
      findings.push(finding)
      const key = `${finding.kind}/${finding.severity}`
      let set = sources.get(key)
      if (!set) {
        set = new Set()
        sources.set(key, set)
      }
      set.add(rel)
    }
  }
  const tallies = new Map<string, number>()
  for (const finding of findings) {
    const key = `${finding.kind}/${finding.severity}`
    tallies.set(key, (tallies.get(key) ?? 0) + 1)
  }
  const orderedKeys = [...tallies.keys()]
  orderedKeys.sort(compareStrings)
  const counts = orderedKeys.map((key) => {
    const slash = key.indexOf("/")
    const list = [...sources.get(key)!]
    list.sort(compareStrings)
    return { kind: key.slice(0, slash), severity: key.slice(slash + 1), count: tallies.get(key)!, sources: list }
  })
  return { counts, findings }
}

/** Why the run-state seal does not hold, in the machine's words (short form). */
const sealMessage = (problem: SidecarProblem): string =>
  problem === "missing sidecar"
    ? "run state has no sidecar seal: it was not written by this engine; a human re-signs it with `es reseal --sign` after review"
    : problem === "signature mismatch"
      ? "run state sidecar mismatch: edited outside the engine; a human re-signs it with `es reseal --sign` after review"
      : "engine key unavailable here: the run state seal cannot be verified from this shell"

/**
 * The run state through the same sealed reader the factory machine uses
 * (S3.2, #135): a missing or forged seal is reported, and the run's
 * state-derived content is not trusted. Gate summaries, audit records and
 * the audit chain are harvested independently (they are not engine-sealed).
 */
async function readRunState(
  root: string,
  stateDir?: string,
): Promise<{ state: FactoryState | undefined; seal: RunStateSeal }> {
  const file = factoryLayout(root).state
  const raw = await readJson(file)
  if (raw === undefined) {
    if (!(await exists(file)))
      return { state: undefined, seal: { valid: false, error: "missing state file: no run was recorded here" } }
    const problem = await verifyEngineFile(file, stateDir ?? defaultStateDir())
    if (problem) return { state: undefined, seal: { valid: false, error: sealMessage(problem) } }
    return { state: undefined, seal: { valid: true } }
  }
  const problem = await verifyEngineFile(file, stateDir ?? defaultStateDir())
  if (problem) return { state: undefined, seal: { valid: false, error: sealMessage(problem) } }
  const parsed = FactoryStateSchema.safeParse(raw)
  if (!parsed.success) return { state: undefined, seal: { valid: true } }
  return { state: parsed.data, seal: { valid: true } }
}

/** The audit-chain trail: sequence, hash and action per entry, for evidence links. */
const trailOf = (entries: readonly AuditEntry[]): ChainTrailEntry[] =>
  entries.map((entry) => {
    const phase = typeof entry.payload.phase === "string" && entry.payload.phase ? entry.payload.phase : undefined
    const reason = typeof entry.payload.reason === "string" && entry.payload.reason ? entry.payload.reason : undefined
    return {
      seq: entry.seq,
      hash: entry.hash,
      action: entry.action,
      ...(phase ? { phase } : {}),
      ...(reason ? { reason } : {}),
    }
  })

/** A chain actor (`agent:<seat>`, `system`, …) as a seat name. */
const actorSeat = (actor: string): string => (actor.startsWith("agent:") ? actor.slice("agent:".length) : actor)

/**
 * Per-phase failure entries (S3.4): chain `qa.fail` / `phase.replan` events
 * land on their named phase; run-level gate and audit findings land on every
 * failed, replanning or replanned phase (a green run's warnings are not
 * failures). Deterministic: chain order, then summary order, then records.
 */
function phaseFailures(
  state: FactoryState,
  entries: readonly AuditEntry[],
  gate: readonly GateFinding[],
  audit: readonly HarvestedAuditFinding[],
): Map<string, FailureEntry[]> {
  const byPhase = new Map<string, FailureEntry[]>(state.phases.map((phase) => [phase.id, []]))
  for (const entry of entries) {
    const payload = entry.payload
    const phase = typeof payload.phase === "string" ? payload.phase : undefined
    if (!phase || !byPhase.has(phase)) continue
    if (entry.action === "qa.fail") {
      const reason = typeof payload.reason === "string" && payload.reason ? payload.reason : "qa failed"
      byPhase.get(phase)!.push({ seat: actorSeat(entry.actor), kind: "qa", reason })
    } else if (entry.action === "phase.replan") {
      const attempt = typeof payload.attempt === "number" ? `replan attempt ${payload.attempt}` : "replanned"
      const reason = typeof payload.reason === "string" && payload.reason ? payload.reason : attempt
      byPhase.get(phase)!.push({ seat: actorSeat(entry.actor), kind: "replan", reason })
    }
  }
  const failed = state.phases
    .filter((phase) => phase.status === "failed" || phase.status === "replanning" || phase.replanned)
    .map((phase) => phase.id)
  if (failed.length > 0) {
    for (const finding of gate)
      for (const id of failed) byPhase.get(id)!.push({ kind: "gate", rule: finding.rule, reason: gateReason(finding) })
    for (const finding of audit)
      for (const id of failed)
        byPhase.get(id)!.push({
          seat: finding.seat,
          kind: "audit",
          category: `${finding.kind}/${finding.severity}`,
          reason: finding.reason,
        })
  }
  return byPhase
}

const phaseTelemetry = (
  state: FactoryState | undefined,
  entries: readonly AuditEntry[],
  gate: readonly GateFinding[],
  audit: readonly HarvestedAuditFinding[],
) => {
  if (!state) return []
  const failures = phaseFailures(state, entries, gate, audit)
  const phases = state.phases.map((phase) => ({
    id: phase.id,
    status: phase.status,
    attempts: phase.status === "pending" ? 0 : phase.failures + 1,
    replans: (phase.replanned ? 1 : 0) + phase.history.filter((event) => event.event.includes("replan")).length,
    failures: failures.get(phase.id) ?? [],
  }))
  phases.sort((a, b) => compareStrings(a.id, b.id))
  return phases
}

/**
 * Harvest one run root. Missing state is tolerated (an empty phase list, zero
 * spend, stage "unknown") so half-written runs still produce a record; an
 * unsealed state is reported in `seal` and its content is not trusted; a
 * broken audit chain is reported, never repaired.
 */
export async function harvestRun(root: string, options: { stateDir?: string } = {}): Promise<RunTelemetry> {
  const { state, seal } = await readRunState(root, options.stateDir)
  const chain = await verifyAuditChain(root)
  const [{ rejections: gateRejections, findings: gateFindings }, { counts: auditFindings, findings: harvestedAudit }] =
    await Promise.all([harvestGateRejections(root), harvestAuditFindings(root)])
  const halt = state?.halt
  return {
    id: path.basename(path.resolve(root)),
    mode: state?.mode ?? "unknown",
    stage: state?.stage ?? "unknown",
    ...(halt ? { halt: { reason: halt.reason, from: halt.from } } : {}),
    spend: {
      usd: state?.spend.usd ?? 0,
      estimated: state?.spend.estimated ?? false,
      events: state?.spend.events ?? 0,
    },
    phases: phaseTelemetry(state, chain.entries, gateFindings, harvestedAudit),
    gateRejections,
    auditFindings,
    auditChain: {
      entries: chain.entries.length,
      valid: chain.valid,
      ...(chain.valid ? {} : { error: chain.error ?? "audit chain invalid" }),
      trail: trailOf(chain.entries),
    },
    seal,
  }
}

const stepsOf = (entry: Record<string, unknown>): number => {
  if (typeof entry.steps !== "number") return 0
  if (!Number.isInteger(entry.steps)) return 0
  if (entry.steps < 0) return 0
  return entry.steps
}

const modelOf = (entry: Record<string, unknown>, fallback: string | undefined): string | undefined => {
  if (typeof entry.model === "string") return entry.model
  return fallback
}

const failuresOf = (entry: Record<string, unknown>): string[] => {
  if (!Array.isArray(entry.failures)) return []
  return entry.failures.filter((item): item is string => typeof item === "string")
}

/** One eval aggregate entry, or undefined when it is not a result row. */
function toEvalEntry(result: unknown, model: string | undefined, source: string): EvalTelemetry | undefined {
  if (typeof result !== "object" || result === null) return undefined
  const entry = result as Record<string, unknown>
  if (typeof entry.id !== "string") return undefined
  if (typeof entry.pass !== "boolean") return undefined
  const telemetry: EvalTelemetry = {
    case: entry.id,
    pass: entry.pass,
    failures: failuresOf(entry),
    steps: stepsOf(entry),
    source,
  }
  const resolved = modelOf(entry, model)
  if (resolved !== undefined) telemetry.model = resolved
  if (entry.modelLimited === true) telemetry.modelLimited = true
  return telemetry
}

/** One eval aggregate file (`{results: [{id, pass, failures, steps, ...}]}`), as `scripts/evals.ts` writes. */
function evalsFromAggregate(raw: unknown, model: string | undefined, source: string): EvalTelemetry[] {
  if (typeof raw !== "object" || raw === null) return []
  const results = (raw as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const out: EvalTelemetry[] = []
  for (const result of results) {
    const entry = toEvalEntry(result, model, source)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

const aggregateModel = (raw: unknown): string | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const model = (raw as { model?: unknown }).model
  if (typeof model === "string") return model
  return undefined
}

/** Harvest eval telemetry from result directories (aggregate `<stamp>.json` files). */
export async function harvestEvals(dir: string): Promise<EvalTelemetry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const ordered = [...names]
  ordered.sort(compareStrings)
  const files = ordered.filter((name) => name.endsWith(".json"))
  const raws = await Promise.all(files.map((name) => readJson(path.join(dir, name))))
  const out: EvalTelemetry[] = []
  for (let index = 0; index < files.length; index++) {
    const raw = raws[index]
    if (raw === undefined) continue
    out.push(...evalsFromAggregate(raw, aggregateModel(raw), files[index]!))
  }
  out.sort((a, b) => compareStrings(a.case, b.case))
  return out
}

// ------------------------------------------------------------------ scrub
//
// Telemetry stays local (#135: no network upload), but it must still carry
// no secrets: env-like values are replaced, and paths under Epistemic Swarm's
// private state dir are collapsed to `<state-dir>`.

const SECRET_KEY =
  /(token|secret|passwd|password|api[-_]?key|auth|credential|private[-_]?key|passphrase|session[-_]?key)/i
const SCRUBBED = "[redacted]"

/**
 * `NAME=value` / `NAME: value` whose NAME matches SECRET_KEY: only the value
 * is replaced, so `GITHUB_TOKEN=ghp_abc` keeps its shape as
 * `GITHUB_TOKEN=[redacted]` (S3.1, #135).
 */
const SECRET_PAIR = new RegExp(
  `([A-Za-z0-9_.-]*${SECRET_KEY.source}[A-Za-z0-9_.-]*\\s*[:=]\\s*)(['"]?)([^\\s'";,]+)`,
  "gi",
)

/** `Bearer <token>`: the scheme stays, the credential goes. */
const BEARER_TOKEN = /\b([Bb][Ee][Aa][Rr][Ee][Rr]\s+)[A-Za-z0-9\-._~+/=]+/g

/** Known token shapes standing bare in prose. */
const TOKEN_SHAPE =
  /\b(?:github_pat_[A-Za-z0-9_]+|sk-ant-[A-Za-z0-9_-]+|gho_[A-Za-z0-9]+|ghs_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+|sk-[A-Za-z0-9]+|xox[abprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16})\b/g

/** PEM private-key blocks, whole. */
const PEM_BLOCK = /-----BEGIN [^-]*PRIVATE KEY[^-]*-----[\s\S]*?-----END [^-]*PRIVATE KEY[^-]*-----/g

/** Replace secret-looking values and private-state-dir paths, preserving shape. */
export function scrubSecrets<T>(value: T, options: { stateDir?: string } = {}): T {
  const dir = options.stateDir ?? defaultStateDir()
  const scrubString = (text: string): string => {
    // Bearer first: `Authorization: Bearer <tok>` would otherwise match the
    // pair rule on `Authorization` and leave the credential behind.
    let out = text.replace(PEM_BLOCK, SCRUBBED)
    out = out.replace(BEARER_TOKEN, `$1${SCRUBBED}`)
    out = out.replace(SECRET_PAIR, `$1$2${SCRUBBED}`)
    out = out.replace(TOKEN_SHAPE, SCRUBBED)
    return dir && out.includes(dir) ? out.split(dir).join("<state-dir>") : out
  }
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === "string") {
      if (key !== undefined && SECRET_KEY.test(key)) return SCRUBBED
      return scrubString(node)
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, key))
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {}
      for (const [child, item] of Object.entries(node as Record<string, unknown>)) out[child] = walk(item, child)
      return out
    }
    return node
  }
  return walk(value) as T
}

/** Harvest every run and eval dir into one validated, scrubbed dataset. */
export async function harvestTelemetry(
  input: HarvestInput,
  options: { stateDir?: string; harvestedAt?: string } = {},
): Promise<Telemetry> {
  const harvested = await Promise.all(
    input.runs.map((root) => harvestRun(root, { ...(options.stateDir ? { stateDir: options.stateDir } : {}) })),
  )
  harvested.sort((a, b) => compareStrings(a.id, b.id))
  const evalGroups = await Promise.all(input.evals.map((dir) => harvestEvals(dir)))
  const evals: EvalTelemetry[] = []
  for (const group of evalGroups) evals.push(...group)
  evals.sort((a, b) => compareStrings(a.case, b.case))
  return TelemetrySchema.parse(
    scrubSecrets(
      {
        version: TELEMETRY_VERSION,
        harvestedAt: options.harvestedAt ?? new Date().toISOString(),
        runs: harvested,
        evals,
      },
      { ...(options.stateDir ? { stateDir: options.stateDir } : {}) },
    ),
  )
}
