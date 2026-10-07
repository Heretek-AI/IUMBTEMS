// Headless factory runs: `es factory run --headless` drives a harness CLI
// (`opencode run`, later `claude -p` / `pi -p`) through a driver interface and
// emits JSON lines. It never answers human checkpoints: it stops and reports
// when an approval is pending, the grill needs a human, the run halts, or
// progress stalls.
import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { checkStopFile, Factory, type FactoryState, gateRunner, pendingApprovals } from "@heretek-ai/es-core"

export type HeadlessEvent =
  | { type: "start"; runId: string; stage: string; driver: string }
  | { type: "turn"; n: number; stage: string; activePhase?: string }
  | { type: "driver"; event: unknown }
  | { type: "waiting"; reason: string; stages?: string[] }
  | { type: "halted"; reason: string }
  | { type: "stalled"; turns: number }
  | { type: "done"; prUrl?: string; audit?: string; status?: string; report?: string }
  | { type: "error"; message: string }

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

const fingerprint = (state: FactoryState | undefined) =>
  JSON.stringify([
    state?.stage,
    state?.activePhase,
    state?.phases.map((phase) => [phase.status, phase.failures, phase.history.length]),
  ])

export interface HeadlessOptions {
  readonly root: string
  readonly driver: HarnessDriver
  readonly maxTurns?: number
  readonly stallTurns?: number
  readonly stateDir?: string
  readonly signal?: AbortSignal
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
  yield { type: "start", runId: state.runId, stage: state.stage, driver: options.driver.id }
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
    try {
      for (;;) {
        const next = await turn.next()
        if (next.done) {
          session = next.value ?? session
          break
        }
        yield { type: "driver", event: next.value }
      }
    } catch (error) {
      yield { type: "error", message: error instanceof Error ? error.message : String(error) }
      return
    }
    const after = await factory.read()
    unchanged = after && (await job.progress(after)) === before ? unchanged + 1 : 0
    if (unchanged >= (options.stallTurns ?? 3)) {
      yield { type: "stalled", turns: unchanged }
      return
    }
  }
  yield { type: "stalled", turns: maxTurns }
}

/** The factory run: until DONE, a pending approval, or the grill (which needs a human). */
export function runHeadless(options: HeadlessOptions): AsyncGenerator<HeadlessEvent> {
  return driveHeadless(options, {
    agent: "factory",
    prompt: async (state, factory) =>
      `${await factory.summary(state)}\nContinue the factory run from its current stage. This is a headless run: no human will answer questions.`,
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
    progress: async (state) => fingerprint(state),
  })
}
