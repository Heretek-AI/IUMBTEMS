// Read-only bus client (#129, ticket #130 builds the dashboard on it): the
// browser calls the same `POST /fleet/rpc` the CLI uses, authenticated by
// the session cookie the ticket exchange set (same-origin fetch carries it;
// no token ever touches client state). Strict-schema responses only.
import type { FleetSnapshot } from "@heretek-ai/es-fleet"

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
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
  const cleanPending: { taskId: string; reason: string }[] = []
  for (const entry of pending) {
    const item = entry as Record<string, unknown>
    if (typeof item?.taskId !== "string" || typeof item?.reason !== "string")
      throw new RpcError(-32603, "fleet.status returned a malformed pending entry")
    cleanPending.push({ taskId: item.taskId, reason: item.reason })
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

export interface ConfigDrift {
  readonly clean: boolean
  readonly violations: readonly string[]
  readonly hasBaseline: boolean
}

export interface ConfigView {
  readonly config: Record<string, unknown> | null
  readonly configHash: string | null
  readonly gates: Record<string, unknown> | null
  readonly gatesHash: string | null
  readonly drift: ConfigDrift
  readonly forbidden: readonly string[]
}

export interface ConfigPlan {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly oldHash: string | null
  readonly newHash: string | null
  readonly changedKeys: readonly string[]
  readonly commands: readonly string[]
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
