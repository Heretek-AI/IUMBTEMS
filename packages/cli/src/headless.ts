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
  currentBranch,
  stateDir as defaultStateDir,
  exists,
  Factory,
  type FactoryState,
  gateRunner,
  git,
  headline,
  indexRun,
  type Liveness,
  pendingApprovals,
  progressPrint,
  readLiveness,
  seatOf,
} from "@heretek-ai/es-core"
import { z } from "zod"

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
  | {
      type: "turn-metrics"
      turn: number
      /** Sealed run-state spend delta across the turn (USD, 0 when the turn spent nothing). */
      costUSD: number
      /** Opportunistic per-turn tokens from the child's events, when the driver reports them. */
      tokensIn?: number
      tokensOut?: number
      tools: Array<{ name: string; ok: boolean; ms?: number; seat?: string }>
    }
  | { type: "waiting"; reason: string; stages?: string[] }
  | { type: "halted"; reason: string }
  | { type: "stalled"; turns: number; headline: string; lastActivityAgoSec?: number; seats: SeatSnapshot[] }
  | { type: "turn-cap"; turns: number }
  | { type: "cancelled"; reason: string }
  | { type: "done"; prUrl?: string; audit?: string; status?: string; report?: string }
  | { type: "error"; message: string }

/** Process exit for one headless event kind: cancellation is 130, failures 1, the rest 0. */
export function headlessExitCode(type: HeadlessEvent["type"]): number {
  if (type === "cancelled") return 130
  if (type === "error" || type === "halted" || type === "stalled" || type === "turn-cap") return 1
  return 0
}

/** Version of the `--events jsonl` envelope (bump on any incompatible change). */
export const JSONL_VERSION = 1 as const

/** One JSONL line: the envelope plus the full event, so the fleet can parse without joining streams. */
export interface JsonlEnvelope {
  readonly v: typeof JSONL_VERSION
  readonly at: string
  readonly runId: string
  readonly kind: HeadlessEvent["type"]
  readonly event: HeadlessEvent
}

/** One tool call in a `turn-metrics` payload: duration and seat when the driver reports them. */
export const TurnMetricsToolSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  ms: z.number().nonnegative().optional(),
  seat: z.string().min(1).optional(),
})

/** A `turn-metrics` payload: validated on its own, not just as an envelope. */
export const TurnMetricsEventSchema = z.object({
  type: z.literal("turn-metrics"),
  turn: z.number().int().positive(),
  costUSD: z.number(),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  tools: z.array(TurnMetricsToolSchema),
})

export const HeadlessJsonlSchema = z
  .object({
    v: z.literal(1),
    at: z.string().datetime(),
    runId: z.string().min(1),
    kind: z.string().min(1),
    event: z.record(z.string(), z.unknown()),
  })
  .superRefine((envelope, ctx) => {
    if (envelope.kind !== "turn-metrics") return
    const payload = TurnMetricsEventSchema.safeParse(envelope.event)
    if (!payload.success)
      ctx.addIssue({
        code: "custom",
        message: `invalid turn-metrics payload: ${payload.error.issues.map((issue) => issue.message).join("; ")}`,
        path: ["event"],
      })
  })
export type HeadlessJsonl = z.infer<typeof HeadlessJsonlSchema>

/** Wrap one headless event in its versioned JSONL envelope. */
export function toJsonl(runId: string, event: HeadlessEvent): JsonlEnvelope {
  return { v: JSONL_VERSION, at: new Date().toISOString(), runId, kind: event.type, event }
}

/** Where a human watches a headless run. */
export const MONITOR_HINT = "watch it with `es status`, `es watch`, or /es-factory in the OpenCode TUI"

export interface DriverTurn {
  readonly root: string
  readonly agent: string
  readonly prompt: string
  readonly session?: string
  readonly signal?: AbortSignal
  /** Seat model override, "provider/model" (human-set flags only). */
  readonly model?: string
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
  async *turn({ root, agent, prompt, session, signal, model }) {
    const args = [
      "run",
      "--standalone",
      "--format",
      "json",
      "--agent",
      agent,
      ...(model ? ["--model", model] : []),
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
  /** Seat model override, "provider/model" (human-set flags only). */
  readonly model?: string
  /** How often a `progress` event is emitted while a turn runs (default 30 s). */
  readonly progressMs?: number
  /** Abort a turn that runs longer than this (ms); reported as a `turn-timeout` error. */
  readonly turnTimeoutMs?: number
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
const ABORTED = Symbol("aborted")

/** A turn that ran past `--turn-timeout`: aborted and reported, never retried. */
class TurnTimeout extends Error {}

/** The error for a turn aborted by `--turn-timeout` (seconds). */
const turnTimeout = (n: number, timeoutMs: number) =>
  new TurnTimeout(`turn ${n} timed out after ${timeoutMs / 1000}s (turn-timeout); the run state is untouched`)

const isTurnTimeout = (error: unknown): error is TurnTimeout => error instanceof TurnTimeout

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
 * Refuse an unsafe `--cwd` root, or return undefined when it is fine.
 * Refuses a path inside another active run's `.factory/worktrees/` (a seat
 * worktree is not a run root) and a repo checkout with a detached HEAD
 * (a run must be attributable to a branch). A non-repo directory is fine.
 */
export async function checkCwd(root: string): Promise<string | undefined> {
  const resolved = path.resolve(root)
  // Inside <project>/.factory/worktrees/ while that project holds a run state?
  let dir = path.dirname(resolved)
  while (dir !== path.dirname(dir)) {
    const seatRoot = path.join(dir, ".factory", "worktrees")
    if (`${resolved}${path.sep}`.startsWith(`${seatRoot}${path.sep}`)) {
      if (await exists(path.join(dir, ".factory", "runtime", "state.json")))
        return `refusing --cwd inside another run's seat worktrees (${seatRoot}): point it at a run root or a fresh worktree instead`
      break
    }
    dir = path.dirname(dir)
  }
  const gitDir = await git(resolved, ["rev-parse", "--absolute-git-dir"], { allowFail: true })
  if (gitDir.code !== 0) return undefined
  if ((await currentBranch(resolved)) === undefined)
    return `refusing --cwd with a detached HEAD (${resolved}): check out a branch first, so the run is attributable`
  return undefined
}

/** Tool activity in one harness event, using the same shape as the log presenter. */
function toolActivity(raw: unknown): { name: string; ok: boolean; ms?: number; seat?: string } | undefined {
  const event = raw as {
    type?: string
    agent?: unknown
    part?: { tool?: string; state?: { status?: string; time?: { start?: unknown; end?: unknown } } }
  }
  if (event?.type === "tool_use" && typeof event.part?.tool === "string") {
    const activity: { name: string; ok: boolean; ms?: number; seat?: string } = {
      name: event.part.tool,
      ok: event.part.state?.status === "completed",
    }
    const { start, end } = event.part.state?.time ?? {}
    if (
      typeof start === "number" &&
      typeof end === "number" &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end >= start
    )
      activity.ms = end - start
    if (typeof event.agent === "string") {
      const seat = seatOf(event.agent)
      if (seat !== undefined) activity.seat = seat
    }
    return activity
  }
  return undefined
}

const TOKEN_KEYS: Readonly<Record<string, "in" | "out">> = {
  tokensIn: "in",
  inputTokens: "in",
  promptTokens: "in",
  tokensOut: "out",
  outputTokens: "out",
  completionTokens: "out",
}
/** Opportunistic per-turn tokens from a harness event, when the driver reports them. */
function eventTokens(raw: unknown): { tokensIn?: number; tokensOut?: number } {
  let tokensIn: number | undefined
  let tokensOut: number | undefined
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== "object" || (tokensIn !== undefined && tokensOut !== undefined))
      return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "number" && Number.isFinite(item)) {
        if (TOKEN_KEYS[key] === "in") tokensIn ??= item
        else if (TOKEN_KEYS[key] === "out") tokensOut ??= item
      } else walk(item, depth + 1)
    }
  }
  walk(raw, 0)
  return { ...(tokensIn !== undefined ? { tokensIn } : {}), ...(tokensOut !== undefined ? { tokensOut } : {}) }
}

/**
 * Drive one seat through a harness CLI until the job finishes, the run halts
 * (STOP, spend ceiling, runtime cap, drift), progress stalls, the turn cap is
 * reached, the turn times out, or a signal cancels the run. It never answers
 * human checkpoints. Cancellation leaves the run state untouched (no halt),
 * so re-running resumes where it stopped.
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
  // The --cwd path is this run's root: keep the per-user run index fresh even
  // when no turn changes state (indexRun is best-effort and never throws).
  await indexRun(options.stateDir ?? defaultStateDir(), {
    runId: state.runId,
    root: options.root,
    stage: state.stage,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  })
  yield { type: "start", runId: state.runId, stage: state.stage, driver: options.driver.id, monitor: MONITOR_HINT }
  // A signal that fires while a turn hangs must still end the race, even with
  // a driver that never listens to it.
  const aborted =
    options.signal === undefined
      ? undefined
      : options.signal.aborted
        ? Promise.resolve(ABORTED)
        : new Promise<typeof ABORTED>((resolve) =>
            options.signal!.addEventListener("abort", () => resolve(ABORTED), { once: true }),
          )
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
    const spendBefore = state.spend.usd
    const turn = options.driver.turn({
      root: options.root,
      agent: job.agent,
      prompt: await job.prompt(state, factory),
      ...(session ? { session } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.model ? { model: options.model } : {}),
    })
    const tools: Array<{ name: string; ok: boolean; ms?: number; seat?: string }> = []
    let tokensIn: number | undefined
    let tokensOut: number | undefined
    const deadline = options.turnTimeoutMs === undefined ? undefined : Date.now() + options.turnTimeoutMs
    // A turn can run for many minutes (foreground seats): report liveness
    // while it does, so "quiet" is never mistaken for "stuck".
    try {
      let pending = turn.next()
      for (;;) {
        const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
        if (remaining === 0) throw turnTimeout(n, options.turnTimeoutMs!)
        const timer = tick(Math.min(options.progressMs ?? 30_000, ...(remaining === undefined ? [] : [remaining])))
        let next: IteratorResult<unknown, string | undefined> | typeof TICK | typeof ABORTED
        try {
          next = await Promise.race([pending, timer.promise, ...(aborted === undefined ? [] : [aborted])])
        } finally {
          // Also when the turn rejects: a live timer would keep the CLI alive.
          timer.cancel()
        }
        if (next === ABORTED) {
          // Best-effort close: a stuck driver may never settle its pending
          // await, so never block cancellation on it.
          turn.return?.(undefined)?.then(
            () => undefined,
            () => undefined,
          )
          yield { type: "cancelled", reason: "cancelled by signal; the run state is untouched, re-run to resume" }
          return
        }
        if (next === TICK) {
          if (deadline !== undefined && Date.now() >= deadline) {
            turn.return?.(undefined)?.then(
              () => undefined,
              () => undefined,
            )
            throw turnTimeout(n, options.turnTimeoutMs!)
          }
          yield { type: "progress", ...(await progressReport(options.root, factory)) }
          continue
        }
        if (next.done) {
          session = next.value ?? session
          break
        }
        const activity = toolActivity(next.value)
        if (activity) tools.push(activity)
        const tokens = eventTokens(next.value)
        tokensIn ??= tokens.tokensIn
        tokensOut ??= tokens.tokensOut
        yield { type: "driver", event: next.value }
        pending = turn.next()
      }
    } catch (error) {
      if (isTurnTimeout(error)) {
        yield { type: "error", message: (error as Error).message }
        return
      }
      if (aborted !== undefined && options.signal?.aborted) {
        turn.return?.(undefined)?.then(
          () => undefined,
          () => undefined,
        )
        yield { type: "cancelled", reason: "cancelled by signal; the run state is untouched, re-run to resume" }
        return
      }
      yield { type: "error", message: error instanceof Error ? error.message : String(error) }
      return
    }
    const after = await factory.read()
    const costUSD = Math.max(0, Math.round(((after?.spend.usd ?? spendBefore) - spendBefore) * 100) / 100)
    yield {
      type: "turn-metrics",
      turn: n,
      costUSD,
      ...(tokensIn !== undefined ? { tokensIn } : {}),
      ...(tokensOut !== undefined ? { tokensOut } : {}),
      tools,
    }
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
 * the assistant's text. `debug`: the raw harness events, long strings
 * clipped, and the per-turn metrics. Per-turn metrics otherwise go only to
 * the `--events jsonl` stream, so the default output is unchanged by them.
 */
export function presentEvent(event: HeadlessEvent, level: LogLevel): unknown {
  if (event.type === "turn-metrics") return level === "debug" ? event : undefined
  if (event.type !== "driver") return event
  if (level === "quiet") return undefined
  if (level === "debug") return { type: "driver", event: clipStrings(event.event, DEBUG_STRING_MAX) }
  return summarizeDriverEvent(event.event)
}
