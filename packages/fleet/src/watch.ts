// `es-fleet watch` terminal dashboard (#126): a read-only view over the
// telemetry bus. Rendering is pure (`renderDashboard`, tested); the loop
// polls `fleet.status` and redraws until `q`.
import { fleetStatus } from "./lifecycle.ts"
import { loadDag } from "./tasks.ts"
import { type BusEvent, type FleetSnapshot, readTelemetryEndpoint } from "./telemetry.ts"

/** Read the full snapshot the bus serves (shared by the server and watch). */
export async function readFleetSnapshot(stateRoot: string): Promise<FleetSnapshot> {
  const [daemon, dag] = await Promise.all([fleetStatus(stateRoot), loadDag(stateRoot)])
  const tasks = dag
    ? Object.values(dag.tasks)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          ceilingUSD: task.ceilingUSD,
          spendUsd: task.result?.spendUsd ?? 0,
          deps: [...task.deps].sort(),
          ...(task.reason ? { reason: task.reason } : {}),
        }))
    : []
  const spendUsd = tasks.reduce((sum, task) => sum + task.spendUsd, 0)
  return {
    daemon: { running: daemon.running, pid: daemon.pid, maxUsd: daemon.maxUsd, concurrency: daemon.concurrency },
    tasks,
    spendUsd,
    pending: tasks
      .filter((task) => task.status === "waiting-human")
      .map((task) => ({ taskId: task.id, reason: task.reason ?? "waiting for a human" })),
  }
}

/** Render one dashboard frame: headline, task table, pending approvals, recent events. */
export function renderDashboard(snapshot: FleetSnapshot, recent: readonly BusEvent[]): string {
  const lines: string[] = []
  const { daemon } = snapshot
  lines.push(
    daemon.running
      ? `Fleet running (pid ${daemon.pid}, spend $${snapshot.spendUsd.toFixed(2)} / $${daemon.maxUsd}, concurrency ${daemon.concurrency})`
      : "Fleet stopped.",
  )
  lines.push("")
  if (snapshot.tasks.length === 0) lines.push("No tasks.")
  else {
    lines.push(`${"TASK".padEnd(16)}${"STATUS".padEnd(14)}${"CEIL".padEnd(8)}${"SPENT".padEnd(8)}DETAIL`)
    for (const task of snapshot.tasks)
      lines.push(
        `${task.id.padEnd(16)}${task.status.padEnd(14)}$${task.ceilingUSD.toFixed(0).padStart(6)}  $${task.spendUsd.toFixed(2).padStart(6)}  ${task.reason ?? ""}`.trimEnd(),
      )
  }
  if (snapshot.pending.length > 0) {
    lines.push("")
    lines.push("Waiting on a human:")
    for (const item of snapshot.pending) lines.push(`  ${item.taskId}: ${item.reason}`)
  }
  const tail = recent.slice(-5)
  if (tail.length > 0) {
    lines.push("")
    lines.push("Recent events:")
    for (const event of tail) lines.push(`  #${event.seq} ${event.type} ${JSON.stringify(event.payload)}`)
  }
  return `${lines.join("\n")}\n`
}

export interface WatchOptions {
  readonly stateRoot: string
  readonly intervalMs?: number
}

const rpcCall = async (port: number, token: string, method: string, params: unknown): Promise<unknown> => {
  const response = await fetch(`http://127.0.0.1:${port}/fleet/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params }),
  })
  return (await response.json()) as unknown
}

/** Poll the bus and redraw until `q`. Needs a TTY; refuses otherwise. */
export async function watchFleet(options: WatchOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("es-fleet watch needs an interactive terminal.\n")
    return 1
  }
  const endpoint = await readTelemetryEndpoint(options.stateRoot)
  if (!endpoint) {
    process.stderr.write("No fleet telemetry endpoint: is the daemon running?\n")
    return 1
  }
  let since = 0
  let quit = false
  process.stdin.setRawMode(true)
  process.stdin.resume()
  const onKey = (chunk: Buffer) => {
    if (chunk.toString().includes("q")) quit = true
  }
  process.stdin.on("data", onKey)
  try {
    while (!quit) {
      try {
        const [status, events] = await Promise.all([
          rpcCall(endpoint.port, endpoint.token, "fleet.status", {}),
          rpcCall(endpoint.port, endpoint.token, "fleet.events", { since }),
        ])
        const snapshot = (status as { result: FleetSnapshot }).result
        const backlog = (events as { result: { events: BusEvent[] } }).result.events
        if (backlog.length > 0) since = backlog.at(-1)!.seq
        process.stdout.write("\x1b[2J\x1b[H")
        process.stdout.write(renderDashboard(snapshot, backlog))
        process.stdout.write("\nq quits.\n")
      } catch (error) {
        process.stdout.write(`telemetry unreachable: ${error instanceof Error ? error.message : String(error)}\n`)
      }
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 2000))
    }
  } finally {
    process.stdin.removeListener("data", onKey)
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
  return 0
}
