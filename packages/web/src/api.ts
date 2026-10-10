// Bus client (#129, ticket #130 builds the dashboard on it): reads go over
// the same `POST /fleet/rpc` the CLI uses, authenticated by the session
// cookie the ticket exchange set (same-origin fetch carries it; no token
// ever touches client state). Strict-schema responses only. The single
// mutating call is the approval submit (#131, ADR 0002 option b): the
// passphrase travels only over loopback, bound to a single-use ticket.
import type {
  ApproveTicket,
  ConfigDrift,
  ConfigPlan,
  ConfigView,
  EvidenceClaimSummary,
  EvidenceQuote,
  FleetSnapshot,
  TaskLiveness,
} from "@heretek-ai/es-fleet"

export type { ConfigDrift, ConfigPlan, ConfigView, EvidenceClaimSummary, EvidenceQuote, TaskLiveness }

/** Approval stages the browser can preview and submit (fleet ApproveTicket). */
export type ApproveStage = ApproveTicket["stage"]

/** Fail-closed stage check for fleet snapshot rows (typed `string` upstream). */
export const isApproveStage = (raw: unknown): raw is ApproveStage => raw === "frontier" || raw === "spec"

/** Claim tag vocabulary, shared by the evidence filters and layout. */
export type Tag = "VERIFIED" | "INFERRED" | "HYPOTHESIS" | "NEGATIVE_KNOWLEDGE"

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    /** Extra machine-readable fields the server sent (remaining, retryAfterSec). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "RpcError"
  }
}

const SnapshotTask = (raw: unknown): FleetSnapshot["tasks"][number] | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const task = raw as Record<string, unknown>
  if (typeof task.id !== "string" || typeof task.title !== "string" || typeof task.status !== "string") return undefined
  if (typeof task.ceilingUSD !== "number" || typeof task.spendUsd !== "number") return undefined
  if (!Array.isArray(task.deps) || task.deps.some((dep) => typeof dep !== "string")) return undefined
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ceilingUSD: task.ceilingUSD,
    spendUsd: task.spendUsd,
    deps: [...(task.deps as string[])],
    ...(typeof task.reason === "string" ? { reason: task.reason } : {}),
  }
}

/** Validate an untrusted `fleet.status` payload into a FleetSnapshot. */
export function parseStatus(raw: unknown): FleetSnapshot {
  if (typeof raw !== "object" || raw === null) throw new RpcError(-32603, "fleet.status returned no snapshot")
  const root = raw as Record<string, unknown>
  const daemon = root.daemon as Record<string, unknown> | undefined
  const tasks = Array.isArray(root.tasks) ? root.tasks : undefined
  const pending = Array.isArray(root.pending) ? root.pending : undefined
  if (
    typeof daemon !== "object" ||
    daemon === null ||
    typeof daemon.running !== "boolean" ||
    (typeof daemon.pid !== "number" && daemon.pid !== null) ||
    (typeof daemon.maxUsd !== "number" && daemon.maxUsd !== null) ||
    typeof daemon.concurrency !== "number" ||
    tasks === undefined ||
    typeof root.spendUsd !== "number" ||
    pending === undefined
  )
    throw new RpcError(-32603, "fleet.status returned a malformed snapshot")
  const cleanTasks: FleetSnapshot["tasks"][number][] = []
  for (const entry of tasks) {
    const task = SnapshotTask(entry)
    if (!task) throw new RpcError(-32603, "fleet.status returned a malformed task")
    cleanTasks.push(task)
  }
  const cleanPending: { taskId: string; reason: string; stage: ApproveStage }[] = []
  for (const entry of pending) {
    const item = entry as Record<string, unknown>
    if (typeof item?.taskId !== "string" || typeof item?.reason !== "string" || !isApproveStage(item?.stage))
      throw new RpcError(-32603, "fleet.status returned a malformed pending entry")
    cleanPending.push({ taskId: item.taskId, reason: item.reason, stage: item.stage })
  }
  return {
    daemon: {
      running: daemon.running,
      pid: daemon.pid as number | null,
      maxUsd: daemon.maxUsd as number | null,
      concurrency: daemon.concurrency,
    },
    tasks: cleanTasks,
    spendUsd: root.spendUsd,
    pending: cleanPending,
  }
}

/** One JSON-RPC call against the daemon bus (same-origin, cookie-authenticated). */
export async function rpc<T>(method: string, params: Record<string, unknown>, base = ""): Promise<T> {
  const response = await fetch(`${base}/fleet/rpc`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  })
  if (response.status === 401) throw new RpcError(401, "not signed in: open the one-time URL from `es-fleet web`")
  if (response.status === 403) throw new RpcError(403, "refused: the UI must be opened on loopback")
  if (!response.ok) throw new RpcError(response.status, `bus returned HTTP ${response.status}`)
  const envelope = (await response.json()) as { result?: unknown; error?: { code?: unknown; message?: unknown } }
  if (envelope.error !== undefined)
    throw new RpcError(
      typeof envelope.error.code === "number" ? envelope.error.code : -32603,
      typeof envelope.error.message === "string" ? envelope.error.message : "bus error",
    )
  return envelope.result as T
}

/**
 * One call against the browser-approval endpoints (same-origin; the
 * session cookie and CSRF token ride along). Server refusals carry
 * machine-readable details (remaining attempts, retry delay).
 */
async function approveCall(
  target: "/fleet/approve/preview" | "/fleet/approve",
  payload: Record<string, unknown>,
  csrf: string,
  base = "",
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${target}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(csrf ? { "x-csrf": csrf } : {}) },
    body: JSON.stringify(payload),
  })
  if (response.status === 401) throw new RpcError(401, "not signed in: open the one-time URL from `es-fleet web`")
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (!response.ok) {
    const message =
      typeof body?.error === "string" ? body.error : `the daemon refused the call (HTTP ${response.status})`
    const { error: _dropped, ...details } = body ?? {}
    void _dropped
    throw new RpcError(response.status, message, details)
  }
  if (!body || typeof body !== "object") throw new RpcError(-32603, "the daemon returned no approval payload")
  return body
}

/** Fleet overview for the hello page (#130 grows this into the dashboard). */
export async function fetchStatus(base = ""): Promise<FleetSnapshot> {
  return parseStatus(await rpc<unknown>("fleet.status", {}, base))
}

/** One task for the detail page (#130). */
export async function fetchTask(id: string, base = ""): Promise<FleetSnapshot["tasks"][number]> {
  const result = await rpc<{ task?: unknown }>("fleet.task", { id }, base)
  const task = SnapshotTask(result.task)
  if (!task) throw new RpcError(-32603, `the daemon returned no task ${id}`)
  return task
}

export interface ApproveFile {
  readonly path: string
  readonly sha256: string
}

export interface ApprovePreview {
  readonly ticket: string
  readonly csrf: string
  readonly subjectHash: string
  readonly summary: string[]
  readonly files: readonly ApproveFile[]
  readonly spendCeilingUSD?: number
  readonly pending: boolean
}

export interface ApproveResult {
  readonly ok: boolean
  readonly stage: string
  readonly alreadyApproved: boolean
  readonly factoryStage: string | null
}

const str = (raw: unknown, what: string): string => {
  if (typeof raw !== "string" || raw.length === 0) throw new RpcError(-32603, `the daemon returned no ${what}`)
  return raw
}

const strArray = (raw: unknown, what: string): string[] => {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string"))
    throw new RpcError(-32603, `the daemon returned no ${what}`)
  return [...raw]
}

/** One task's run liveness for the detail page (#130, `fleet.task.liveness`). */
export async function fetchTaskLiveness(id: string, base = ""): Promise<TaskLiveness> {
  const result = await rpc<unknown>("fleet.task.liveness", { id }, base)
  if (typeof result !== "object" || result === null) throw new RpcError(-32603, "the daemon returned no task liveness")
  const seen = result as Record<string, unknown>
  if (typeof seen.headline !== "string" || typeof seen.stage !== "string" || !Array.isArray(seen.seats))
    throw new RpcError(-32603, "the daemon returned no task liveness")
  return {
    taskId: str(seen.taskId, "task liveness"),
    stage: seen.stage,
    headline: seen.headline,
    seats: strArray(seen.seats, "task liveness"),
    ...(typeof seen.runId === "string" ? { runId: seen.runId } : {}),
    ...(typeof seen.research === "string" ? { research: seen.research } : {}),
    ...(typeof seen.lastActivityAt === "string" ? { lastActivityAt: seen.lastActivityAt } : {}),
  }
}

/** Preview a frontier or spec approval: subject, hash and single-use ticket (#131). */
export async function fetchApprovePreview(runId: string, stage: ApproveStage, base = ""): Promise<ApprovePreview> {
  const body = await approveCall("/fleet/approve/preview", { runId, stage }, "", base)
  if (!Array.isArray(body.files)) throw new RpcError(-32603, "the daemon returned no approval preview")
  const files: ApproveFile[] = []
  for (const entry of body.files) {
    if (typeof entry !== "object" || entry === null)
      throw new RpcError(-32603, "the daemon returned no approval preview")
    const file = entry as Record<string, unknown>
    files.push({ path: str(file.path, "approval preview"), sha256: str(file.sha256, "approval preview") })
  }
  return {
    ticket: str(body.ticket, "approval preview"),
    csrf: str(body.csrf, "approval preview"),
    subjectHash: str(body.subjectHash, "approval preview"),
    summary: strArray(body.summary, "approval preview"),
    files,
    ...(typeof body.spendCeilingUSD === "number" ? { spendCeilingUSD: body.spendCeilingUSD } : {}),
    pending: body.pending === true,
  }
}

/** Submit the passphrase for a previewed ticket (#131, ADR 0002 option b). */
export async function submitApproval(
  ticket: string,
  csrf: string,
  passphrase: string,
  base = "",
): Promise<ApproveResult> {
  const body = await approveCall("/fleet/approve", { ticket, passphrase }, csrf, base)
  return {
    ok: body.ok === true,
    stage: typeof body.stage === "string" ? body.stage : "",
    alreadyApproved: body.alreadyApproved === true,
    factoryStage: typeof body.factoryStage === "string" ? body.factoryStage : null,
  }
}

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)

const malformed = (): never => {
  throw new RpcError(-32603, "the daemon returned a malformed config view")
}

const strings = (raw: unknown): string[] => {
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) return [...raw]
  return malformed()
}

const recordOrNull = (raw: unknown): Record<string, unknown> | null => {
  if (raw === null) return null
  if (isRecord(raw)) return raw
  return malformed()
}

const hashOrNull = (raw: unknown): string | null => {
  if (raw === null || typeof raw === "string") return raw
  return malformed()
}

/** Current project config, gates, hashes and drift (#132, preview-only). */
export async function fetchConfigView(base = ""): Promise<ConfigView> {
  const result = await rpc<unknown>("fleet.config.get", {}, base)
  if (!isRecord(result)) throw new RpcError(-32603, "the daemon returned a malformed config view")
  const drift = result.drift
  if (!isRecord(drift) || typeof drift.clean !== "boolean" || typeof drift.hasBaseline !== "boolean")
    throw new RpcError(-32603, "the daemon returned a malformed config view")
  return {
    config: recordOrNull(result.config),
    configHash: hashOrNull(result.configHash),
    gates: recordOrNull(result.gates),
    gatesHash: hashOrNull(result.gatesHash),
    drift: { clean: drift.clean, violations: strings(drift.violations), hasBaseline: drift.hasBaseline },
    forbidden: strings(result.forbidden),
  }
}

/** Validate proposed file content and preview the exact diff (#132). */
export async function previewConfigPlan(file: "config" | "gates", content: unknown, base = ""): Promise<ConfigPlan> {
  const result = await rpc<unknown>("fleet.config.plan", { file, content }, base)
  if (!isRecord(result) || typeof result.ok !== "boolean")
    throw new RpcError(-32603, "the daemon returned no config plan")
  return {
    ok: result.ok,
    errors: strings(result.errors),
    oldHash: typeof result.oldHash === "string" || result.oldHash === null ? result.oldHash : null,
    newHash: typeof result.newHash === "string" || result.newHash === null ? result.newHash : null,
    changedKeys: strings(result.changedKeys),
    commands: strings(result.commands),
  }
}

/** Claim list narrowing for a run (#133): the tag is the closed Tag vocabulary. */
export interface EvidenceFilter {
  readonly tag?: Tag
  readonly status?: string
  readonly tier?: string
  readonly text?: string
}

/** One quote with its verified source ranges (fleet EvidenceQuote). */
export type EvidenceQuoteRange = EvidenceQuote["ranges"][number]

/** One claim in full: same row shape as the fleet claim summary. */
export type EvidenceClaim = EvidenceClaimSummary

export interface EvidenceRetraction {
  readonly source: string
  readonly event: string
  readonly at: string
  readonly note: string
  readonly by: string
}

export interface EvidenceClaimDetail {
  readonly claim: EvidenceClaim
  readonly quotes: readonly EvidenceQuote[]
  readonly retractions: readonly EvidenceRetraction[]
  readonly events: ReadonlyArray<{ claim: string; from: string; to: string; reason: string; at: string }>
  readonly rankExplanation: string
  readonly files: readonly string[]
}

export interface EvidenceSource {
  readonly meta: {
    readonly sha256: string
    readonly url: string
    readonly title?: string
    readonly retrieved: string
    readonly provider: string
    readonly bytes: number
    readonly tier?: string
  }
  readonly seal: string
  readonly text: string
  readonly truncated: boolean
}

export interface EvidenceExport {
  readonly format: string
  readonly body: string
  readonly truncated: boolean
}

const optStr = (raw: unknown): string | undefined => (typeof raw === "string" ? raw : undefined)

const reqRec = (raw: unknown, what: string): Record<string, unknown> => {
  if (!isRecord(raw)) throw new RpcError(-32603, `the daemon returned no ${what}`)
  return raw
}

/** Claim list for a run, narrowed by tag/status/tier/text (#133). */
export async function fetchEvidenceClaims(
  runId: string,
  filter: EvidenceFilter = {},
  base = "",
): Promise<{ claims: EvidenceClaimSummary[]; truncated: boolean }> {
  const params: Record<string, unknown> = { runId }
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") clean[key] = value
  if (Object.keys(clean).length) params.filter = clean
  const result = await rpc<{ claims?: unknown; truncated?: unknown }>("evidence.claims", params, base)
  if (!Array.isArray(result.claims)) throw new RpcError(-32603, "the daemon returned no evidence claims")
  return {
    claims: result.claims.map((entry) => {
      const claim = reqRec(entry, "evidence claim")
      const tier = optStr(claim.tier)
      return {
        id: str(claim.id, "evidence claim"),
        tag: str(claim.tag, "evidence claim"),
        status: str(claim.status, "evidence claim"),
        statement: str(claim.statement, "evidence claim"),
        sourceSha: claim.sourceSha === null ? null : str(claim.sourceSha, "evidence claim"),
        ...(tier !== undefined ? { tier } : {}),
      }
    }),
    truncated: result.truncated === true,
  }
}

/** One claim with quotes, retractions, events and rank (#133). */
export async function fetchEvidenceClaim(runId: string, id: string, base = ""): Promise<EvidenceClaimDetail> {
  const result = await rpc<unknown>("evidence.claim", { runId, id }, base)
  const root = reqRec(result, "evidence claim")
  const claim = reqRec(root.claim, "evidence claim")
  const tier = optStr(claim.tier)
  const source = claim.source === undefined ? undefined : reqRec(claim.source, "evidence claim")
  const sourceSha = source === undefined ? null : str(source.sha256, "evidence claim")
  if (
    !Array.isArray(root.quotes) ||
    !Array.isArray(root.retractions) ||
    !Array.isArray(root.events) ||
    !Array.isArray(root.files)
  )
    throw new RpcError(-32603, "the daemon returned no evidence claim")
  return {
    claim: {
      id: str(claim.id, "evidence claim"),
      tag: str(claim.tag, "evidence claim"),
      status: str(claim.status, "evidence claim"),
      statement: str(claim.statement, "evidence claim"),
      sourceSha,
      ...(tier !== undefined ? { tier } : {}),
    },
    quotes: root.quotes.map((entry) => {
      const quote = reqRec(entry, "evidence quote")
      if (!Array.isArray(quote.ranges)) throw new RpcError(-32603, "the daemon returned no evidence quote")
      return {
        quote: str(quote.quote, "evidence quote"),
        verified: quote.verified === true,
        ranges: quote.ranges.map((range) => {
          const span = reqRec(range, "evidence range")
          if (typeof span.start !== "number" || typeof span.end !== "number")
            throw new RpcError(-32603, "the daemon returned no evidence range")
          return { start: span.start, end: span.end }
        }),
      }
    }),
    retractions: root.retractions.map((entry) => {
      const retraction = reqRec(entry, "evidence retraction")
      return {
        source: str(retraction.source, "evidence retraction"),
        event: str(retraction.event, "evidence retraction"),
        at: str(retraction.at, "evidence retraction"),
        note: typeof retraction.note === "string" ? retraction.note : "",
        by: str(retraction.by, "evidence retraction"),
      }
    }),
    events: root.events.map((entry) => {
      const event = reqRec(entry, "evidence event")
      return {
        claim: str(event.claim, "evidence event"),
        from: str(event.from, "evidence event"),
        to: str(event.to, "evidence event"),
        reason: str(event.reason, "evidence event"),
        at: str(event.at, "evidence event"),
      }
    }),
    rankExplanation: str(root.rankExplanation, "evidence claim"),
    files: strArray(root.files, "evidence claim"),
  }
}

/** One source with capped text and seal status (#133). */
export async function fetchEvidenceSource(runId: string, sha: string, base = ""): Promise<EvidenceSource> {
  const result = await rpc<unknown>("evidence.source", { runId, sha }, base)
  const root = reqRec(result, "evidence source")
  const meta = reqRec(root.meta, "evidence source")
  const title = optStr(meta.title)
  const tier = optStr(meta.tier)
  return {
    meta: {
      sha256: str(meta.sha256, "evidence source"),
      url: str(meta.url, "evidence source"),
      ...(title !== undefined ? { title } : {}),
      retrieved: str(meta.retrieved, "evidence source"),
      provider: str(meta.provider, "evidence source"),
      bytes: typeof meta.bytes === "number" ? meta.bytes : 0,
      ...(tier !== undefined ? { tier } : {}),
    },
    seal: str(root.seal, "evidence source"),
    text: str(root.text, "evidence source"),
    truncated: root.truncated === true,
  }
}

/** Rendered dossier export through the #112 renderers (#133). */
export async function exportEvidenceDossier(
  runId: string,
  format: "markdown" | "html",
  base = "",
): Promise<EvidenceExport> {
  const result = await rpc<{ format?: unknown; body?: unknown; truncated?: unknown }>(
    "evidence.export",
    { runId, format },
    base,
  )
  return {
    format: typeof result.format === "string" ? result.format : format,
    body: typeof result.body === "string" ? result.body : "",
    truncated: result.truncated === true,
  }
}
