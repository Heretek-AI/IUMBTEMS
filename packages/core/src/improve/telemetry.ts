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
import { AuditRecordSchema } from "../schema/codeaudit.ts"
import {
  type AuditFindingCount,
  type EvalTelemetry,
  type GateRejection,
  type RunTelemetry,
  TELEMETRY_VERSION,
  type Telemetry,
  TelemetrySchema,
} from "../schema/improve.ts"
import { compareStrings } from "../util/compare.ts"

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

const rulesFromSummary = (parsed: unknown): string[] => {
  if (typeof parsed !== "object" || parsed === null) return []
  const findings = (parsed as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return []
  const rules: string[] = []
  for (const finding of findings) {
    if (typeof finding !== "object" || finding === null) continue
    const rule = (finding as { rule?: unknown }).rule
    if (typeof rule === "string" && rule) rules.push(rule)
  }
  return rules
}

/** Gate findings across every gate summary under `.factory/runs/`, counted by rule. */
async function harvestGateRejections(root: string): Promise<GateRejection[]> {
  const summaries = await gateSummaries(factoryLayout(root).runs)
  const parsed = await Promise.all(summaries.map((file) => readJson(file)))
  const rules: string[] = []
  for (const summary of parsed) rules.push(...rulesFromSummary(summary))
  return countBy(rules).map(({ key, count }) => ({ rule: key, count }))
}

/** Finding keys (`kind/severity`) from one audit records file. */
function keysFromRecords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const keys: string[] = []
  for (const entry of raw) {
    const parsed = AuditRecordSchema.safeParse(entry)
    if (!parsed.success) continue
    for (const finding of parsed.data.findings) keys.push(`${finding.kind}/${finding.severity}`)
  }
  return keys
}

/** Code-audit records under `.factory/audits/`, counted by finding kind and severity. */
async function harvestAuditFindings(root: string): Promise<AuditFindingCount[]> {
  const auditsDir = factoryLayout(root).audits
  let ids: string[]
  try {
    ids = await readdir(auditsDir)
  } catch {
    return []
  }
  const ordered = [...ids]
  ordered.sort(compareStrings)
  const raws = await Promise.all(ordered.map((id) => readJson(path.join(auditsDir, id, "records.json"))))
  const keys: string[] = []
  for (const raw of raws) keys.push(...keysFromRecords(raw))
  return countBy(keys).map(({ key, count }) => {
    const slash = key.indexOf("/")
    return { kind: key.slice(0, slash), severity: key.slice(slash + 1), count }
  })
}

/** The run state when it parses, tolerating missing or half-written runs. */
async function readRunState(root: string): Promise<FactoryState | undefined> {
  const raw = await readJson(factoryLayout(root).state)
  if (raw === undefined) return undefined
  const parsed = FactoryStateSchema.safeParse(raw)
  if (!parsed.success) return undefined
  return parsed.data
}

const phaseTelemetry = (state: FactoryState | undefined) => {
  const phases = (state?.phases ?? []).map((phase) => ({
    id: phase.id,
    status: phase.status,
    failures: phase.failures,
    replanned: phase.replanned,
  }))
  phases.sort((a, b) => compareStrings(a.id, b.id))
  return phases
}

/**
 * Harvest one run root. Missing state is tolerated (an empty phase list, zero
 * spend, stage "unknown") so half-written runs still produce a record; a
 * broken audit chain is reported, never repaired.
 */
export async function harvestRun(root: string): Promise<RunTelemetry> {
  const state = await readRunState(root)
  const chain = await verifyAuditChain(root)
  const [gateRejections, auditFindings] = await Promise.all([harvestGateRejections(root), harvestAuditFindings(root)])
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
    phases: phaseTelemetry(state),
    gateRejections,
    auditFindings,
    auditChain: {
      entries: chain.entries.length,
      valid: chain.valid,
      ...(chain.valid ? {} : { error: chain.error ?? "audit chain invalid" }),
    },
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
function toEvalEntry(result: unknown, model: string | undefined): EvalTelemetry | undefined {
  if (typeof result !== "object" || result === null) return undefined
  const entry = result as Record<string, unknown>
  if (typeof entry.id !== "string") return undefined
  if (typeof entry.pass !== "boolean") return undefined
  const telemetry: EvalTelemetry = {
    case: entry.id,
    pass: entry.pass,
    failures: failuresOf(entry),
    steps: stepsOf(entry),
  }
  const resolved = modelOf(entry, model)
  if (resolved !== undefined) telemetry.model = resolved
  if (entry.modelLimited === true) telemetry.modelLimited = true
  return telemetry
}

/** One eval aggregate file (`{results: [{id, pass, failures, steps, ...}]}`), as `scripts/evals.ts` writes. */
function evalsFromAggregate(raw: unknown, model: string | undefined): EvalTelemetry[] {
  if (typeof raw !== "object" || raw === null) return []
  const results = (raw as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const out: EvalTelemetry[] = []
  for (const result of results) {
    const entry = toEvalEntry(result, model)
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
  for (const raw of raws) {
    if (raw === undefined) continue
    out.push(...evalsFromAggregate(raw, aggregateModel(raw)))
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

/** Replace secret-looking values and private-state-dir paths, preserving shape. */
export function scrubSecrets<T>(value: T, options: { stateDir?: string } = {}): T {
  const dir = options.stateDir ?? defaultStateDir()
  const scrubString = (text: string): string => (dir && text.includes(dir) ? text.split(dir).join("<state-dir>") : text)
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
  const harvested = await Promise.all(input.runs.map((root) => harvestRun(root)))
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
