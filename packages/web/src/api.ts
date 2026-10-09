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
