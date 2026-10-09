// Bus event client (#130, clean-room): a WebSocket over `/fleet/ws` that
// replays the backlog on connect, delivers live `changed`/`liveness`
// events, and reconnects with backoff (refetching on every reconnect).
// In the browser the session cookie authenticates the handshake; tests pass
// a Bearer header through `openSocket` (browsers cannot set headers).
import type { BusEvent } from "@heretek-ai/es-fleet"

export type BusChannel = "changed" | "liveness"

/** Structural socket: the browser WebSocket and the test fakes alike. */
export interface BusSocket {
  send(text: string): void
  close(): void
  set onopen(fn: ((event: unknown) => void) | undefined)
  set onmessage(fn: ((event: unknown) => void) | undefined)
  set onclose(fn: ((event: unknown) => void) | undefined)
  set onerror(fn: ((event: unknown) => void) | undefined)
}

export interface BusClientOptions {
  readonly url: string
  readonly channels?: readonly BusChannel[]
  readonly since?: () => number
  readonly onEvent: (event: BusEvent) => void
  /** Called on every (re)connect: the caller refetches the snapshot. */
  readonly onConnect?: () => void
  readonly backoffMs?: (attempt: number) => number
  readonly openSocket?: (url: string) => BusSocket
}

const defaultBackoff = (attempt: number): number => Math.min(30_000, 1_000 * 2 ** attempt)

const asEvent = (raw: unknown): BusEvent | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const event = raw as Record<string, unknown>
  if (!Number.isInteger(event.seq) || (event.seq as number) <= 0) return undefined
  if (typeof event.at !== "string") return undefined
  if (event.type !== "changed" && event.type !== "liveness") return undefined
  if (typeof event.payload !== "object" || event.payload === null) return undefined
  return event as unknown as BusEvent
}

/**
 * Open the stream. Returns a disconnect function (idempotent): it closes
 * the live socket and cancels any pending reconnect.
 */
export function connectBus(options: BusClientOptions): () => void {
  const channels = options.channels ?? (["changed", "liveness"] as const)
  const since = options.since ?? (() => 0)
  const backoff = options.backoffMs ?? defaultBackoff
  const open = options.openSocket ?? ((url) => new WebSocket(url) as unknown as BusSocket)
  let stopped = false
  let socket: BusSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0

  const connect = (): void => {
    if (stopped) return
    const current = open(options.url)
    socket = current
    current.onopen = () => {
      attempt = 0
      current.send(JSON.stringify({ subscribe: [...channels], since: since() }))
      options.onConnect?.()
    }
    current.onmessage = (event) => {
      const data = (event as { data?: unknown }).data
      if (typeof data !== "string") return
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return // hostile or corrupt frames never reach the store
      }
      const busEvent = asEvent(parsed)
      if (busEvent) options.onEvent(busEvent)
    }
    const schedule = () => {
      if (stopped) return
      const wait = backoff(attempt)
      attempt += 1
      timer = setTimeout(connect, wait)
    }
    current.onclose = schedule
    current.onerror = schedule
  }
  connect()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    socket?.close()
  }
}
