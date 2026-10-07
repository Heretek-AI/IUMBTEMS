// Headless factory runs: `es factory run --headless` drives a harness CLI
// (`opencode run`, later `claude -p` / `pi -p`) through a driver interface and
// emits JSON lines. It never answers human checkpoints: it stops and reports
// when an approval is pending, the grill needs a human, the run halts, or
// progress stalls.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Factory, type FactoryState, factorySummary, gateRunner, pendingApprovals } from "@heretek-ai/es-core"

export type HeadlessEvent =
  | { type: "start"; runId: string; stage: string; driver: string }
  | { type: "turn"; n: number; stage: string; activePhase?: string }
  | { type: "driver"; event: unknown }
  | { type: "waiting"; reason: string; stages?: string[] }
  | { type: "halted"; reason: string }
  | { type: "stalled"; turns: number }
  | { type: "done"; prUrl?: string }
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

async function onPath(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `binary` is always an internal constant; PATH lookup is intended.
    const child = spawn("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" }) // NOSONAR
    child.on("close", (code) => resolve(code === 0))
    child.on("error", () => resolve(false))
  })
}

/** OpenCode v2: `opencode run --standalone --format json`. */
export const opencodeDriver: HarnessDriver = {
  id: "opencode",
  available: () => onPath("opencode"),
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
    // `opencode` is resolved from PATH by design.
    const child = spawn("opencode", args, {
      // NOSONAR
      cwd: root,
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

export async function* runHeadless(options: HeadlessOptions): AsyncGenerator<HeadlessEvent> {
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
    if (state.stage === "DONE") {
      yield { type: "done", ...(state.release?.prUrl ? { prUrl: state.release.prUrl } : {}) }
      return
    }
    if (state.stage === "HALTED") {
      yield { type: "halted", reason: state.halt?.reason ?? "unknown" }
      return
    }
    const pending = await pendingApprovals(options.root)
    if (pending.length) {
      yield {
        type: "waiting",
        reason: "a human must approve (es approve <stage>)",
        stages: pending.map((item) => item.stage),
      }
      return
    }
    if (state.stage === "GRILL") {
      yield { type: "waiting", reason: "the grill needs a human; run /grill interactively" }
      return
    }
    yield { type: "turn", n, stage: state.stage, ...(state.activePhase ? { activePhase: state.activePhase } : {}) }
    const before = fingerprint(state)
    const turn = options.driver.turn({
      root: options.root,
      agent: "factory",
      prompt: `${factorySummary(state)}\nContinue the factory run from its current stage. This is a headless run: no human will answer questions.`,
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
    unchanged = fingerprint(await factory.read()) === before ? unchanged + 1 : 0
    if (unchanged >= (options.stallTurns ?? 3)) {
      yield { type: "stalled", turns: unchanged }
      return
    }
  }
  yield { type: "stalled", turns: maxTurns }
}
