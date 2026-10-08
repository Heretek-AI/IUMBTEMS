// Headless factory runs: `es factory run --headless` drives a harness CLI
// (`opencode run`, later `claude -p` / `pi -p`) through a driver interface and
// emits JSON lines. It never answers human checkpoints: it stops and reports
// when an approval is pending, the grill needs a human, the run halts, or
// progress stalls.
import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import {
  checkStopFile,
  Factory,
  type FactoryState,
  gateRunner,
  headline,
  type Liveness,
  pendingApprovals,
  progressPrint,
  readLiveness,
} from "@heretek-ai/es-core"

/** A seat as the progress and stall events report it. */
export interface SeatSnapshot {
  readonly agent: string
  readonly state: string
  readonly lastTool?: string
  readonly agoSec: number
}

export type HeadlessEvent =
  | { type: "start"; runId: string; stage: string; driver: string; monitor: string }
  | { type: "turn"; n: number; stage: string; activePhase?: string }
  | { type: "driver"; event: unknown }
  | { type: "progress"; headline: string; lastActivityAgoSec?: number; seats: SeatSnapshot[] }
  | { type: "waiting"; reason: string; stages?: string[] }
  | { type: "halted"; reason: string }
  | { type: "stalled"; turns: number; headline: string; lastActivityAgoSec?: number; seats: SeatSnapshot[] }
  | { type: "turn-cap"; turns: number }
  | { type: "done"; prUrl?: string; audit?: string; status?: string; report?: string }
  | { type: "error"; message: string }

/** Where a human watches a headless run. */
export const MONITOR_HINT = "watch it with `es status`, `es watch`, or /es-factory in the OpenCode TUI"

export interface DriverTurn {
  readonly root: string
  readonly agent: string
  readonly prompt: string
  readonly session?: string
  readonly signal?: AbortSignal
}

export interface HarnessDriver {
  readonly id: string
  available(): Promise<boolean>
  /** Run one prompt to completion; yields raw events and returns the session id to continue. */
  turn(input: DriverTurn): AsyncGenerator<unknown, string | undefined>
}

/** Absolute path of `binary` on PATH, or undefined. No shell, so no injection. */
function resolveOnPath(binary: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, binary)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not executable here; keep looking
    }
  }
  return undefined
}

/** OpenCode v2: `opencode run --standalone --format json`. */
export const opencodeDriver: HarnessDriver = {
  id: "opencode",
  available: () => Promise.resolve(resolveOnPath("opencode") !== undefined),
  async *turn({ root, agent, prompt, session, signal }) {
    const args = [
      "run",
      "--standalone",
      "--format",
      "json",
      "--agent",
      agent,
      ...(session ? ["--session", session] : []),
      prompt,
    ]
    // Resolve to an absolute path so the child is not looked up on PATH again.
    const binary = resolveOnPath("opencode")
    if (!binary) throw new Error("the opencode CLI is not on PATH")
    const child = spawn(binary, args, {
      cwd: root,
      // opencode resolves the project from PWD, not the spawn cwd.
      env: { ...process.env, PWD: root },
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    })
    let sessionID = session
    const lines = createInterface({ input: child.stdout! })
    for await (const line of lines) {
      if (!line.trim()) continue
      let event: unknown = line
      try {
        event = JSON.parse(line)
      } catch {
        // plain text line
      }
      const match = /"(?:sessionID|sessionId|session_id)"\s*:\s*"(ses_[\w-]+)"/.exec(line)
      if (match) sessionID = match[1]
      yield event
    }
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
    if (code !== 0) throw new Error(`opencode run exited ${code}`)
    return sessionID
  },
}

export const DRIVERS: Record<string, HarnessDriver> = { opencode: opencodeDriver }

export interface HeadlessOptions {
  readonly root: string
  readonly driver: HarnessDriver
  readonly maxTurns?: number
  readonly stallTurns?: number
  readonly stateDir?: string
  readonly signal?: AbortSignal
  /** How often a `progress` event is emitted while a turn runs (default 30 s). */
  readonly progressMs?: number
}

const secondsSince = (liveness: Liveness, at: string | undefined) =>
  at === undefined ? undefined : Math.max(0, Math.round((Date.parse(liveness.now) - Date.parse(at)) / 1000))

const seatSnapshots = (liveness: Liveness): SeatSnapshot[] =>
  liveness.seats
    .filter((seat) => seat.state === "running")
    .map((seat) => ({
      agent: seat.agent,
      state: seat.state,
      ...(seat.lastTool ? { lastTool: seat.lastTool } : {}),
      agoSec: secondsSince(liveness, seat.lastActivityAt) ?? 0,
    }))

/** The run's liveness as a progress report (`stalled` carries the same evidence). */
async function progressReport(root: string, factory: Factory) {
  const state = await factory.read().catch(() => undefined)
  const liveness = await readLiveness(root, state)
  const quiet = secondsSince(liveness, liveness.lastActivityAt)
  return {
    headline: headline(state, liveness),
    ...(quiet === undefined ? {} : { lastActivityAgoSec: quiet }),
    seats: seatSnapshots(liveness),
  }
}

const TICK = Symbol("tick")

/** A cancellable timer that resolves to TICK. */
function tick(ms: number) {
  let id: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<typeof TICK>((resolve) => {
    id = setTimeout(() => resolve(TICK), ms)
  })
  return { promise, cancel: () => clearTimeout(id) }
}

/** One headless job: which seat to drive, what to tell it each turn, and when it is finished. */
export interface HeadlessJob {
  readonly agent: string
  readonly prompt: (state: FactoryState, factory: Factory) => Promise<string>
  /** An event that ends the job (done/waiting), or undefined to keep going. */
  readonly finished: (state: FactoryState) => Promise<HeadlessEvent | undefined>
  /** Progress fingerprint: a turn that leaves it unchanged counts toward a stall. */
  readonly progress: (state: FactoryState) => Promise<string>
}

/**
 * Drive one seat through a harness CLI until the job finishes, the run halts
 * (STOP, spend ceiling, runtime cap, drift), progress stalls or the turn cap is
 * reached. It never answers human checkpoints.
 */
export async function* driveHeadless(options: HeadlessOptions, job: HeadlessJob): AsyncGenerator<HeadlessEvent> {
  const factory = new Factory(options.root, {
    gates: gateRunner(options.stateDir ? { stateDir: options.stateDir } : {}),
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
  })
  let state = await factory.read()
  if (!state) {
    yield { type: "error", message: "No factory run here. Grill an idea first (/grill in OpenCode)." }
    return
  }
  if (!(await options.driver.available())) {
    yield { type: "error", message: `The ${options.driver.id} CLI is not installed or not on PATH.` }
    return
  }
  yield { type: "start", runId: state.runId, stage: state.stage, driver: options.driver.id, monitor: MONITOR_HINT }
  let session: string | undefined
  let unchanged = 0
  const maxTurns = options.maxTurns ?? 200
  for (let n = 1; n <= maxTurns; n++) {
    state = await factory.read()
    if (!state) return
    const stop = await checkStopFile(options.root)
    if (state.stage === "HALTED" || stop.stopped) {
      yield { type: "halted", reason: state.halt?.reason ?? `STOP file: ${stop.reason}` }
      return
    }
    const finished = await job.finished(state)
    if (finished) {
      yield finished
      return
    }
    yield { type: "turn", n, stage: state.stage, ...(state.activePhase ? { activePhase: state.activePhase } : {}) }
    const before = await job.progress(state)
    const turn = options.driver.turn({
      root: options.root,
      agent: job.agent,
      prompt: await job.prompt(state, factory),
      ...(session ? { session } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    // A turn can run for many minutes (foreground seats): report liveness
    // while it does, so "quiet" is never mistaken for "stuck".
    try {
      let pending = turn.next()
      for (;;) {
        const timer = tick(options.progressMs ?? 30_000)
        const next = await Promise.race([pending, timer.promise])
        timer.cancel()
        if (next === TICK) {
          yield { type: "progress", ...(await progressReport(options.root, factory)) }
          continue
        }
        if (next.done) {
          session = next.value ?? session
          break
        }
        yield { type: "driver", event: next.value }
        pending = turn.next()
      }
    } catch (error) {
      yield { type: "error", message: error instanceof Error ? error.message : String(error) }
      return
    }
    const after = await factory.read()
    unchanged = after && (await job.progress(after)) === before ? unchanged + 1 : 0
    if (unchanged >= (options.stallTurns ?? 3)) {
      yield { type: "stalled", turns: unchanged, ...(await progressReport(options.root, factory)) }
      return
    }
  }
  yield { type: "turn-cap", turns: maxTurns }
}

/** The factory run: until DONE, a pending approval, or the grill (which needs a human). */
export function runHeadless(options: HeadlessOptions): AsyncGenerator<HeadlessEvent> {
  return driveHeadless(options, {
    agent: "factory",
    prompt: async (state, factory) =>
      `${await factory.summary(state)}\n${headline(state, await readLiveness(options.root, state))}\nContinue the factory run from its current stage. This is a headless run: no human will answer questions.`,
    finished: async (state) => {
      if (state.stage === "DONE")
        return { type: "done", ...(state.release?.prUrl ? { prUrl: state.release.prUrl } : {}) }
      const pending = await pendingApprovals(options.root)
      if (pending.length)
        return {
          type: "waiting",
          reason: "a human must approve (es approve <stage>)",
          stages: pending.map((item) => item.stage),
        }
      if (state.stage === "GRILL")
        return { type: "waiting", reason: "the grill needs a human; run /grill interactively" }
      return undefined
    },
    // Research artifacts and seat outcomes count as progress, not just the stage machine.
    progress: async (state) => progressPrint(state, await readLiveness(options.root, state)),
  })
}

export const LOG_LEVELS = ["quiet", "info", "debug"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const isLogLevel = (value: unknown): value is LogLevel => (LOG_LEVELS as readonly unknown[]).includes(value)

/** `--log-level` (default info); undefined for an unknown value. */
export function logLevel(args: { readonly flags: Record<string, string | boolean> }): LogLevel | undefined {
  const value = args.flags["log-level"]
  if (value === undefined) return "info"
  return isLogLevel(value) ? value : undefined
}

/** Longest string a `debug` driver event keeps. */
const DEBUG_STRING_MAX = 2048
const TEXT_MAX = 500
const TARGET_MAX = 120

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text

/** Deep copy with every long string clipped (file contents in tool events). */
function clipStrings(value: unknown, max: number): unknown {
  if (typeof value === "string") return clip(value, max)
  if (Array.isArray(value)) return value.map((item) => clipStrings(item, max))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipStrings(item, max)]))
  return value
}

const TARGET_KEYS = ["path", "filePath", "url", "command", "pattern", "query", "agent", "target"]

/** One compact line for a harness event, or undefined to drop it (steps, reasoning). */
function summarizeDriverEvent(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string") return raw.trim() ? { type: "text", text: clip(raw, TEXT_MAX) } : undefined
  const event = raw as {
    type?: string
    part?: {
      text?: string
      tool?: string
      state?: { status?: string; input?: Record<string, unknown>; error?: unknown }
    }
    error?: { message?: string }
  }
  if (event?.type === "tool_use" && event.part?.tool) {
    const input = event.part.state?.input ?? {}
    const key = TARGET_KEYS.find((name) => typeof input[name] === "string")
    const error = event.part.state?.error
    return {
      type: "tool",
      tool: event.part.tool,
      status: event.part.state?.status ?? "unknown",
      ...(key ? { target: clip(input[key] as string, TARGET_MAX) } : {}),
      ...(error ? { error: clip(typeof error === "string" ? error : JSON.stringify(error), TEXT_MAX) } : {}),
    }
  }
  if (event?.type === "text" && typeof event.part?.text === "string")
    return event.part.text.trim() ? { type: "text", text: clip(event.part.text, TEXT_MAX) } : undefined
  if (event?.type === "error") return { type: "driver-error", message: event.error?.message ?? "unknown error" }
  return undefined
}

/**
 * What to print for one headless event at a log level. `quiet`: lifecycle and
 * progress only. `info` (default): plus one compact line per tool call and
 * the assistant's text. `debug`: the raw harness events, long strings clipped.
 */
export function presentEvent(event: HeadlessEvent, level: LogLevel): unknown {
  if (event.type !== "driver") return event
  if (level === "quiet") return undefined
  if (level === "debug") return { type: "driver", event: clipStrings(event.event, DEBUG_STRING_MAX) }
  return summarizeDriverEvent(event.event)
}
