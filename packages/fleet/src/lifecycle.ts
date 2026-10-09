// Daemon lifecycle (#122, clean-room): start/stop/status with a pidfile and
// a lock in the masked state dir. Starting spends money, so start refuses
// agent sandboxes (ES_SANDBOX) and a live double-start; a stale pidfile is
// recovered. The `es-fleet` binary adds the TTY + human-confirmation gate;
// the library takes an explicit `env` so tests can drive both sides.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { readJson, withLock } from "@heretek-ai/es-core"
import { acquireSocket, type SocketGuard } from "./socket-guard.ts"
import { type FleetState, fleetPaths, persistFleetState, readFleetState, stoppedState } from "./state.ts"

export class FleetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FleetError"
  }
}

export interface StartOptions {
  readonly stateRoot: string
  /** Fleet-wide spend ceiling in USD; mandatory, caps the sum of task ceilings. */
  readonly maxUsd: number
  readonly concurrency?: number
  readonly env?: NodeJS.ProcessEnv
}

export interface FleetHandle {
  readonly pid: number
  readonly startedAt: string
  close(): Promise<void>
}

export interface FleetStatus extends FleetState {}

const PidfileSchema = (raw: unknown): { pid: number; startedAt: string } | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const { pid, startedAt } = raw as Record<string, unknown>
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof startedAt !== "string") return undefined
  return { pid, startedAt }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    // EPERM means a live process we may not signal; anything else is dead.
    return error?.code === "EPERM"
  }
}

const sandboxOf = (env: NodeJS.ProcessEnv | undefined): string | undefined =>
  env?.ES_SANDBOX && env.ES_SANDBOX.length > 0 ? env.ES_SANDBOX : undefined

/** Human-only gate for starting the fleet: agents run with ES_SANDBOX set. */
export function assertHumanStart(env: NodeJS.ProcessEnv | undefined, what = "start the fleet"): void {
  const sandbox = sandboxOf(env ?? process.env)
  if (sandbox !== undefined)
    throw new FleetError(
      `Refusing to ${what} inside an agent sandbox (ES_SANDBOX=${sandbox}): the fleet spends money, so only a human may do it from an interactive terminal.`,
    )
}

/** Start the daemon records: lock, pidfile, control socket, persisted state. */
export async function startFleet(options: StartOptions): Promise<FleetHandle> {
  assertHumanStart(options.env ?? process.env)
  if (!(options.maxUsd > 0) || !Number.isFinite(options.maxUsd))
    throw new FleetError(`Refusing to start without a positive --max-usd ceiling (got ${options.maxUsd}).`)
  const concurrency = options.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new FleetError(`Refusing to start with concurrency ${concurrency}: it must be an integer >= 1.`)
  const paths = fleetPaths(options.stateRoot)
  await mkdir(paths.dir, { recursive: true })
  const startedAt = new Date().toISOString()
  await withLock(paths.lock, async () => {
    const raw = await readJson(paths.pid).catch(() => undefined)
    const pidfile = PidfileSchema(raw)
    if (pidfile && isPidAlive(pidfile.pid) && pidfile.pid !== process.pid)
      throw new FleetError(
        `The fleet is already running as pid ${pidfile.pid} (started ${pidfile.startedAt}); refusing a second owner.`,
      )
    // Our own pid in the file (a previous start in this process without
    // close) is also a double start.
    if (pidfile && pidfile.pid === process.pid)
      throw new FleetError(`The fleet is already running in this process (pid ${process.pid}).`)
    // Otherwise the pidfile is missing, corrupt, or stale: reclaim it.
    await writeFile(paths.pid, `${JSON.stringify({ pid: process.pid, startedAt })}\n`)
    await persistFleetState(paths, {
      v: 1,
      running: true,
      pid: process.pid,
      startedAt,
      maxUsd: options.maxUsd,
      concurrency,
    })
  })
  // The socket binds after the lock is released: binding is quick, and a
  // bind failure must not wedge the lock. A stale socket is reclaimed inside.
  let socket: SocketGuard
  try {
    socket = await acquireSocket(paths.socket)
  } catch (error) {
    await withLock(paths.lock, async () => {
      await rm(paths.pid, { force: true })
      await persistFleetState(paths, stoppedState(concurrency))
    })
    throw error
  }
  let closed = false
  return {
    pid: process.pid,
    startedAt,
    close: async () => {
      if (closed) return
      closed = true
      await socket.close()
      await withLock(paths.lock, async () => {
        const raw = await readJson(paths.pid).catch(() => undefined)
        // Only clear our own pidfile; a successor's file is not ours.
        if (PidfileSchema(raw)?.pid === process.pid) await rm(paths.pid, { force: true })
        await persistFleetState(paths, stoppedState(concurrency))
      })
    },
  }
}

/** Read the persisted daemon status (works for humans and agents alike). */
export async function fleetStatus(stateRoot: string): Promise<FleetStatus> {
  return (await readFleetState(stateRoot)) ?? stoppedState()
}

/**
 * Stop a daemon started elsewhere: SIGTERM its pid and wait for the pidfile
 * to clear. `{ stopped: false }` when nothing was running. Never throws for
 * a missing or stale pidfile; the stale record is reclaimed.
 */
export async function stopFleet(
  stateRoot: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<{ stopped: boolean }> {
  const paths = fleetPaths(stateRoot)
  const raw = await readJson(paths.pid).catch(() => undefined)
  const pidfile = PidfileSchema(raw)
  if (!pidfile || !isPidAlive(pidfile.pid)) {
    await rm(paths.pid, { force: true })
    return { stopped: false }
  }
  try {
    process.kill(pidfile.pid, "SIGTERM")
  } catch {
    return { stopped: false }
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  for (;;) {
    const current = await readFile(paths.pid, "utf8").catch(() => undefined)
    if (current === undefined) return { stopped: true }
    let cleared = false
    try {
      cleared = PidfileSchema(JSON.parse(current))?.pid !== pidfile.pid
    } catch {
      cleared = true
    }
    if (cleared) return { stopped: true }
    if (!isPidAlive(pidfile.pid)) {
      await rm(paths.pid, { force: true })
      return { stopped: true }
    }
    if (Date.now() > deadline) return { stopped: true }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
