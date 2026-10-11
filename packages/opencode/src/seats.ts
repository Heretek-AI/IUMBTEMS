// Seat tracker (1.1.3, #60): follows factory seats (registry subagents running
// as host child sessions) through host events and records their state, last
// tool and last activity in .factory/runtime/seats.json. es_status, `es
// status`, the dashboard and the headless driver read it; the foreground guard
// and the continuation ask it what is running right now.
import {
  agentSpec,
  assertModelDiversity,
  ModelDiversityError,
  type SeatModelMap,
  type SeatRecord,
  updateSeats,
} from "@heretek-ai/es-core"
import type { Runtime } from "./runtime.ts"

/** Activity-only updates (tool calls, steps) are persisted at most this often per seat. */
const ACTIVITY_PERSIST_MS = 10_000

interface HostEvent {
  readonly type: string
  readonly data?: {
    readonly sessionID?: string
    readonly parentID?: string
    readonly agent?: string
  }
}

export interface SeatTracker {
  /** Feed one host event (session.created, session.execution.*, session.step.ended). */
  onEvent(event: HostEvent, agentOf: (sessionID: string) => Promise<string | undefined>): Promise<void>
  /** A seat is about to run `tool` (from the execute.before hook, which knows the tool name). */
  onTool(sessionID: string, agent: string, tool: string): Promise<void>
  /** Running seats in this host, optionally only one agent's. */
  running(agent?: string): SeatRecord[]
  /** Whether `parentID` has a seat child still running. */
  hasRunningChildren(parentID: string): boolean
}

/** Seats covered by the heterogeneous-model policy (#170): the programmer and both QA seats. */
const DIVERSE_SEATS: ReadonlySet<string> = new Set(["es-programmer", "es-qa-functional", "es-qa-adversarial"])

/**
 * Refusal text when launching `target` would run the programmer and QA on the
 * same model provider (shared weights share blind spots); undefined when the
 * target is not a build seat or diversity holds. Unverified configs (unset
 * seats) launch unless models.requireDiversity is set.
 */
export function seatModelRefusal(target: string, models: SeatModelMap | undefined): string | undefined {
  if (!DIVERSE_SEATS.has(target)) return undefined
  try {
    assertModelDiversity(models)
    return undefined
  } catch (error) {
    if (error instanceof ModelDiversityError) return error.message
    throw error
  }
}

/** Factory seats are the registry's subagents; primary agents (factory, grill) are drivers, not seats. */
const isSeat = (agent: string | undefined): agent is string => agentSpec(agent)?.mode === "subagent"

export function createSeatTracker(
  runtime: Runtime,
  options: { readonly onChange?: () => void; readonly now?: () => Date } = {},
): SeatTracker {
  const seats = new Map<string, SeatRecord>()
  const persistedAt = new Map<string, number>()
  const now = () => (options.now ?? (() => new Date()))()

  const persist = async (record: SeatRecord, transition: boolean) => {
    const at = now().getTime()
    if (!transition && at - (persistedAt.get(record.sessionID) ?? 0) < ACTIVITY_PERSIST_MS) return
    persistedAt.set(record.sessionID, at)
    const state = await runtime.factory.read().catch(() => undefined)
    if (state)
      await updateSeats(runtime.root, state.runId, (list) => {
        const index = list.findIndex((item) => item.sessionID === record.sessionID)
        if (index === -1) list.push(record)
        else list[index] = record
      }).catch(() => undefined)
    if (transition) options.onChange?.()
  }

  const touch = async (sessionID: string, patch: Partial<SeatRecord>, transition: boolean) => {
    const current = seats.get(sessionID)
    if (!current) return
    const next: SeatRecord = { ...current, lastActivityAt: now().toISOString(), ...patch }
    seats.set(sessionID, next)
    await persist(next, transition)
  }

  const start = async (sessionID: string, agent: string, parentID: string | undefined) => {
    const at = now().toISOString()
    // A continued seat keeps its start and last tool; it is running again, so it has no end.
    const { endedAt: _ended, ...base } = seats.get(sessionID) ?? { sessionID, agent, startedAt: at }
    const record: SeatRecord = { ...base, ...(parentID ? { parentID } : {}), lastActivityAt: at, state: "running" }
    seats.set(sessionID, record)
    await persist(record, true)
  }

  return {
    async onEvent(event, agentOf) {
      const sessionID = event.data?.sessionID
      if (!sessionID) return
      if (event.type === "session.created") {
        if (event.data?.parentID && isSeat(event.data.agent))
          await start(sessionID, event.data.agent, event.data.parentID)
        return
      }
      if (event.type === "session.execution.started") {
        // A seat created before this host started (or continued later) is picked up here.
        const agent = seats.get(sessionID)?.agent ?? (await agentOf(sessionID))
        if (isSeat(agent)) await start(sessionID, agent, seats.get(sessionID)?.parentID)
        return
      }
      if (!seats.has(sessionID)) return
      const at = now().toISOString()
      if (event.type === "session.execution.succeeded")
        await touch(sessionID, { state: "completed", endedAt: at }, true)
      else if (event.type === "session.execution.failed") await touch(sessionID, { state: "failed", endedAt: at }, true)
      else if (event.type === "session.execution.interrupted")
        await touch(sessionID, { state: "interrupted", endedAt: at }, true)
      else if (event.type === "session.step.ended") await touch(sessionID, {}, false)
    },
    async onTool(sessionID, agent, tool) {
      if (!isSeat(agent) || !seats.has(sessionID)) return
      await touch(sessionID, { lastTool: tool }, false)
    },
    running(agent) {
      return [...seats.values()].filter((seat) => seat.state === "running" && (!agent || seat.agent === agent))
    },
    hasRunningChildren(parentID) {
      return [...seats.values()].some((seat) => seat.state === "running" && seat.parentID === parentID)
    },
  }
}
