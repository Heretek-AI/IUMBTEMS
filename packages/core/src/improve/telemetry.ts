// Read-only telemetry harvester over factory runs and eval results (#135).
// It aggregates what runs already record — factory state (phases, replans,
// halts, spend), gate summaries, audit records and the hash-chained audit
// log — plus eval aggregates, into one normalized, versioned dataset for the
// distiller (#136). It never writes to the harvested roots and never repairs
// a broken audit chain: a break is reported in `auditChain`.
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { verifyAuditChain } from "../audit/chain.ts"
import { FactoryStateSchema } from "../factory/state.ts"
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
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, count]) => ({ key, count }))
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

/** Gate findings across every gate summary under `.factory/runs/`, counted by rule. */
async function harvestGateRejections(root: string): Promise<GateRejection[]> {
  const runsDir = factoryLayout(root).runs
  const rules: string[] = []
  const summaries = async (dir: string): Promise<string[]> => {
    const found: string[] = []
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return found
    }
    for (const name of names.sort()) {
      const full = path.join(dir, name)
      if (name === "summary.json") found.push(full)
      else {
        try {
          if ((await stat(full)).isDirectory()) found.push(...(await summaries(full)))
        } catch {
          // Unreadable entries are skipped: telemetry reports what exists.
        }
      }
    }
    return found
  }
  for (const summary of await summaries(runsDir)) {
    const parsed = await readJson(summary)
    const findings = (parsed as { findings?: unknown } | undefined)?.findings
    if (!Array.isArray(findings)) continue
    for (const finding of findings) {
      const rule = (finding as { rule?: unknown } | null)?.rule
      if (typeof rule === "string" && rule) rules.push(rule)
    }
  }
  return countBy(rules).map(({ key, count }) => ({ rule: key, count }))
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
  const keys: string[] = []
  for (const id of ids.sort()) {
    const raw = await readJson(path.join(auditsDir, id, "records.json"))
    if (!Array.isArray(raw)) continue
    for (const entry of raw) {
      const parsed = AuditRecordSchema.safeParse(entry)
      if (!parsed.success) continue
      for (const finding of parsed.data.findings) keys.push(`${finding.kind}/${finding.severity}`)
    }
  }
  return countBy(keys).map(({ key, count }) => {
    const [kind, severity] = key.split("/")
    return { kind: kind!, severity: severity!, count }
  })
}

/**
 * Harvest one run root. Missing state is tolerated (an empty phase list, zero
 * spend, stage "unknown") so half-written runs still produce a record; a
 * broken audit chain is reported, never repaired.
 */
export async function harvestRun(root: string): Promise<RunTelemetry> {
  const layout = factoryLayout(root)
  const raw = await readJson(layout.state)
  const state =
    raw === undefined
      ? undefined
      : FactoryStateSchema.safeParse(raw).success
        ? FactoryStateSchema.parse(raw)
        : undefined
  const chain = await verifyAuditChain(root)
  const [gateRejections, auditFindings] = await Promise.all([harvestGateRejections(root), harvestAuditFindings(root)])
  return {
    id: path.basename(path.resolve(root)),
    mode: state?.mode ?? "unknown",
    stage: state?.stage ?? "unknown",
    ...(state?.halt ? { halt: { reason: state.halt.reason, from: state.halt.from } } : {}),
    spend: {
      usd: state?.spend.usd ?? 0,
      estimated: state?.spend.estimated ?? false,
      events: state?.spend.events ?? 0,
    },
    phases: (state?.phases ?? [])
      .map((phase) => ({ id: phase.id, status: phase.status, failures: phase.failures, replanned: phase.replanned }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    gateRejections,
    auditFindings,
    auditChain: {
      entries: chain.entries.length,
      valid: chain.valid,
      ...(chain.valid ? {} : { error: chain.error ?? "audit chain invalid" }),
    },
  }
}

/** One eval aggregate file (`{results: [{id, pass, failures, steps, ...}]}`), as `scripts/evals.ts` writes. */
function evalsFromAggregate(raw: unknown, model: string | undefined): EvalTelemetry[] {
  const results = (raw as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return []
  const out: EvalTelemetry[] = []
  for (const result of results) {
    const entry = result as Record<string, unknown>
    if (typeof entry.id !== "string" || typeof entry.pass !== "boolean") continue
    out.push({
      case: entry.id,
      pass: entry.pass,
      failures: Array.isArray(entry.failures)
        ? entry.failures.filter((item): item is string => typeof item === "string")
        : [],
      steps: typeof entry.steps === "number" && Number.isInteger(entry.steps) && entry.steps >= 0 ? entry.steps : 0,
      ...(typeof entry.model === "string" ? { model: entry.model } : model ? { model } : {}),
      ...(entry.modelLimited === true ? { modelLimited: true as const } : {}),
    })
  }
  return out
}

/** Harvest eval telemetry from result directories (aggregate `<stamp>.json` files). */
export async function harvestEvals(dir: string): Promise<EvalTelemetry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: EvalTelemetry[] = []
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue
    const raw = await readJson(path.join(dir, name))
    if (raw === undefined) continue
    const model =
      typeof (raw as { model?: unknown }).model === "string" ? ((raw as { model: string }).model as string) : undefined
    out.push(...evalsFromAggregate(raw, model))
  }
  return out.sort((a, b) => (a.case < b.case ? -1 : a.case > b.case ? 1 : 0))
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
    if (typeof node === "string") return key !== undefined && SECRET_KEY.test(key) ? SCRUBBED : scrubString(node)
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
  const runs: RunTelemetry[] = []
  for (const root of input.runs) runs.push(await harvestRun(root))
  runs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const evals: EvalTelemetry[] = []
  for (const dir of input.evals) evals.push(...(await harvestEvals(dir)))
  evals.sort((a, b) => (a.case < b.case ? -1 : a.case > b.case ? 1 : 0))
  return TelemetrySchema.parse(
    scrubSecrets(
      { version: TELEMETRY_VERSION, harvestedAt: options.harvestedAt ?? new Date().toISOString(), runs, evals },
      { ...(options.stateDir ? { stateDir: options.stateDir } : {}) },
    ),
  )
}
