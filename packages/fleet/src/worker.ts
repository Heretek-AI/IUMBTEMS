// Fleet workers (#125, clean-room): one headless run per task, spawned with
// argv only (no shell), each task's ceiling provisioned into its run state,
// headless JSONL events folded into task reports with spend/token tracking,
// StillDown pre-restart probes and a mass-death circuit breaker.
import { type ChildProcess, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Factory, gateRunner, readJson, run, writeJson } from "@heretek-ai/es-core"
import { FleetError } from "./lifecycle.ts"
import type { TaskReport } from "./scheduler.ts"
import { fleetPaths } from "./state.ts"

export interface WorkerSpec {
  readonly taskId: string
  readonly worktreeDir: string
  readonly ceilingUSD: number
  readonly kind: "factory-run" | "research-run"
  readonly objective: string
  /** Path to the `es` CLI entry (bin/es.js). Tests inject a stub script. */
  readonly esBin: string
}

/**
 * Argv for the task's headless run. Argv-only: the caller spawns this array
 * directly, never through a shell. Note there is deliberately no `--max-usd`
 * here: `es factory run` has no such flag (verified against the CLI), so the
 * ceiling is provisioned into the run state by `prepareTaskRun`, where the
 * factory's own guard enforces it.
 */
export function buildWorkerArgv(spec: WorkerSpec): string[] {
  if (spec.kind !== "factory-run")
    throw new FleetError(
      `Task ${spec.taskId} is a research-run: no headless research driver exists yet (research runs need one from #110/#111); refusing to guess.`,
    )
  if (!(spec.ceilingUSD > 0)) throw new FleetError(`Task ${spec.taskId} needs a positive ceiling.`)
  return [spec.esBin, "factory", "run", "--headless", "--events", "jsonl", "--cwd", spec.worktreeDir]
}

/**
 * Give a task worktree a runnable run with the task's own ceiling, using
 * core's Factory API (the daemon runs as the human-started process, so this
 * is the human provisioning the ceiling, never an agent).
 */
export async function prepareTaskRun(spec: WorkerSpec): Promise<void> {
  if (!(spec.ceilingUSD > 0)) throw new FleetError(`Task ${spec.taskId} needs a positive ceiling.`)
  const factory = new Factory(spec.worktreeDir, { gates: gateRunner({}) })
  if (spec.kind === "factory-run") {
    await factory.provisionRun("fleet-daemon", spec.ceilingUSD)
    return
  }
  const objective = spec.objective.trim()
  if (!objective) throw new FleetError(`Task ${spec.taskId} is a research-run without an objective.`)
  await factory.beginResearchRun({ objective, ceilingUSD: spec.ceilingUSD }, "fleet-daemon")
}

export interface SpendAcc {
  spendUsd: number
  tokensIn: number
  tokensOut: number
}

export const emptyAcc = (): SpendAcc => ({ spendUsd: 0, tokensIn: 0, tokensOut: 0 })

export interface WorkerEnvelope {
  readonly v: number
  readonly at: string
  readonly runId: string
  readonly kind: string
  readonly event: { readonly type: string; readonly [key: string]: unknown }
}

export interface FoldedEvent {
  readonly acc: SpendAcc
  readonly report?: TaskReport
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const reasonOf = (event: WorkerEnvelope["event"], fallback: string): string =>
  textOf(event.reason) ?? textOf(event.message) ?? textOf(event.headline) ?? fallback

/**
 * Fold one headless envelope into spend/token accumulation and, for terminal
 * or waiting events, a task report. Pure: same envelope and acc give the
 * same fold.
 */
export function foldWorkerEvent(acc: SpendAcc, envelope: WorkerEnvelope): FoldedEvent {
  const event = envelope.event
  if (event.type === "turn-metrics") {
    const numberOf = (value: unknown): number => (typeof value === "number" ? value : 0)
    const cost = numberOf(event.costUSD)
    const tokensIn = numberOf(event.tokensIn)
    const tokensOut = numberOf(event.tokensOut)
    return {
      acc: { spendUsd: acc.spendUsd + cost, tokensIn: acc.tokensIn + tokensIn, tokensOut: acc.tokensOut + tokensOut },
    }
  }
  switch (event.type) {
    case "waiting":
      return { acc, report: { outcome: "waiting-human", reason: reasonOf(event, "run waits for a human") } }
    case "done":
      return { acc, report: { outcome: "done", spendUsd: acc.spendUsd } }
    case "halted":
    case "stalled":
    case "turn-cap":
    case "error":
      return {
        acc,
        report: { outcome: "failed", reason: reasonOf(event, `run ${event.type}`), spendUsd: acc.spendUsd },
      }
    case "cancelled":
      return { acc, report: { outcome: "cancelled", reason: reasonOf(event, "run cancelled") } }
    default:
      return { acc }
  }
}

export interface WorkerOutcome {
  /** Final task status from the run's terminal event (or the exit fallback). */
  readonly status: "done" | "failed" | "cancelled" | "waiting-human"
  readonly reason?: string
  readonly spendUsd: number
}

export interface WorkerOptions extends WorkerSpec {
  /** Spawn override (tests inject a stub script). Default: the es CLI argv. */
  readonly spawn?: { readonly command: string; readonly args: readonly string[] }
  readonly onReport: (taskId: string, report: TaskReport) => void
  /** Grace period for SIGTERM before SIGKILL (ms). */
  readonly stopGraceMs?: number
}

/**
 * Supervises one task's headless child: parses versioned JSONL envelopes off
 * stdout, folds them into reports, and synthesizes a terminal outcome from
 * the exit code when the run dies without a final event (130 → cancelled,
 * anything else → failed). Never uses a shell.
 */
export class Worker {
  private child: ChildProcess | undefined
  private acc: SpendAcc = emptyAcc()
  private terminal: TaskReport | undefined
  private startedResolve: ((pid: number) => void) | undefined
  readonly started: Promise<number>

  constructor(private readonly options: WorkerOptions) {
    this.started = new Promise<number>((resolve) => {
      this.startedResolve = resolve
    })
  }

  snapshot(): SpendAcc & { taskId: string; pid: number | undefined } {
    return { taskId: this.options.taskId, pid: this.child?.pid, ...this.acc }
  }

  private emit(report: TaskReport): void {
    if (report.outcome === "done" || report.outcome === "failed")
      report = { ...report, spendUsd: report.spendUsd ?? this.acc.spendUsd }
    if (this.terminal === undefined) {
      this.terminal = report
      this.options.onReport(this.options.taskId, report)
    }
  }

  async run(): Promise<WorkerOutcome> {
    const spawnArgs = this.options.spawn ?? {
      command: this.options.esBin,
      args: buildWorkerArgv(this.options).slice(1),
    }
    const child = spawn(spawnArgs.command, [...spawnArgs.args], { stdio: ["ignore", "pipe", "pipe"], env: process.env })
    this.child = child
    this.startedResolve?.(child.pid ?? -1)
    const stderrTail: string[] = []
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail.push(chunk.toString())
      if (stderrTail.length > 20) stderrTail.shift()
    })
    const lines = createInterface({ input: child.stdout! })
    const finished = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 1))
      child.once("error", () => resolve(1))
    })
    try {
      for await (const line of lines) {
        let envelope: WorkerEnvelope | undefined
        try {
          const raw = JSON.parse(line) as {
            kind?: unknown
            event?: unknown
            v?: unknown
            at?: unknown
            runId?: unknown
          }
          if (typeof raw.kind === "string" && typeof raw.event === "object" && raw.event !== null)
            envelope = {
              v: typeof raw.v === "number" ? raw.v : 0,
              at: typeof raw.at === "string" ? raw.at : "",
              runId: typeof raw.runId === "string" ? raw.runId : "",
              kind: raw.kind,
              event: raw.event as WorkerEnvelope["event"],
            }
        } catch {
          continue
        }
        if (!envelope) continue
        const folded = foldWorkerEvent(this.acc, envelope)
        this.acc = folded.acc
        if (folded.report) this.emit(folded.report)
      }
    } finally {
      lines.removeAllListeners()
    }
    const code = await finished
    if (this.terminal) return toOutcome(this.terminal, this.acc.spendUsd)
    if (code === 130) {
      const report: TaskReport = { outcome: "cancelled", reason: "run exited 130 (SIGTERM); resumable" }
      this.emit(report)
      return toOutcome(report, this.acc.spendUsd)
    }
    const tail = stderrTail.join("").trim().slice(-300)
    const report: TaskReport = {
      outcome: "failed",
      reason: `run exited with code ${code} and no final event${tail ? `: ${tail}` : ""}`,
      spendUsd: this.acc.spendUsd,
    }
    this.emit(report)
    return toOutcome(report, this.acc.spendUsd)
  }

  /** SIGTERM the child (the headless run records `cancelled`, exit 130). */
  async stop(graceMs = this.options.stopGraceMs ?? 5_000): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill("SIGTERM")
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
    })
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, graceMs))
    await Promise.race([exited, timeout])
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
  }
}

const toOutcome = (report: TaskReport, spendUsd: number): WorkerOutcome => {
  if (report.outcome === "running") return { status: "failed", reason: "run ended while reporting running", spendUsd }
  if (report.outcome === "cancelled") return { status: "cancelled", reason: report.reason, spendUsd }
  return { status: report.outcome, reason: report.reason, spendUsd }
}

export class WorkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkerError"
  }
}

/**
 * Tracks live workers across one daemon: starting an already-tracked task is
 * refused (never double-start), and a daemon restart reattaches to live pids
 * while dead ones are reported as failed for the failure policy to decide.
 */
export class WorkerSupervisor {
  private readonly live = new Map<string, { pid: number; acc: SpendAcc }>()

  track(taskId: string, pid: number, acc: SpendAcc = emptyAcc()): void {
    this.live.set(taskId, { pid, acc })
  }

  untrack(taskId: string): void {
    this.live.delete(taskId)
  }

  isTracked(taskId: string): boolean {
    return this.live.has(taskId)
  }

  entries(): Array<{ taskId: string; pid: number }> {
    return [...this.live.entries()].map(([taskId, record]) => ({ taskId, pid: record.pid }))
  }

  /** Throw when the task must not be (re)started: it is already tracked. */
  requireStartable(taskId: string): void {
    if (this.live.has(taskId))
      throw new WorkerError(`Task ${taskId} is already running under this daemon; refusing a second worker.`)
  }

  recover(
    records: ReadonlyArray<{ taskId: string; pid: number }>,
    _now: number,
  ): { reattached: string[]; failed: Array<{ taskId: string; reason: string }> } {
    const reattached: string[] = []
    const failed: Array<{ taskId: string; reason: string }> = []
    for (const record of records) {
      if (isPidAlive(record.pid)) {
        this.live.set(record.taskId, { pid: record.pid, acc: emptyAcc() })
        reattached.push(record.taskId)
      } else {
        failed.push({ taskId: record.taskId, reason: "daemon restarted while the run was gone; re-queue by policy" })
      }
    }
    return { reattached, failed }
  }
}

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === "EPERM"
  }
}

export interface BreakerOptions {
  /** Crashes per task inside the window that refuse a restart. */
  readonly maxRestarts: number
  /** Window (ms) crash counts are kept for. */
  readonly windowMs: number
  /** How long a refusal lasts after the last crash (ms). */
  readonly cooldownMs: number
  /** Total crashes inside the window that open the breaker for every task. */
  readonly massThreshold: number
}
/**
 * StillDown circuit breaker (clean-room): a pre-restart probe refuses to
 * relaunch a task that keeps crashing, and a mass-death probe refuses all
 * launches while many workers die at once. Both recover after the cooldown.
 */
export class CircuitBreaker {
  private readonly crashes = new Map<string, number[]>()
  private openUntil = 0

  constructor(private readonly options: BreakerOptions) {}

  noteCrash(taskId: string, now: number): void {
    const kept = [...(this.crashes.get(taskId) ?? []), now].filter((at) => now - at < this.options.windowMs)
    this.crashes.set(taskId, kept)
    const total = [...this.crashes.values()].flat().filter((at) => now - at < this.options.windowMs).length
    if (total >= this.options.massThreshold) this.openUntil = Math.max(this.openUntil, now + this.options.cooldownMs)
  }

  probe(taskId: string, now: number): "ok" | { refused: string } {
    if (now < this.openUntil)
      return { refused: `mass worker death: launches paused until ${new Date(this.openUntil).toISOString()}` }
    const recent = (this.crashes.get(taskId) ?? []).filter((at) => now - at < this.options.windowMs)
    if (recent.length >= this.options.maxRestarts) {
      const retryAt = Math.max(...recent) + this.options.cooldownMs
      if (now < retryAt)
        return {
          refused: `task ${taskId} crashed ${recent.length} times: StillDown probe refuses a restart until ${new Date(retryAt).toISOString()}`,
        }
    }
    return "ok"
  }
}

const WorkerPidsSchema = (raw: unknown): Record<string, number> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const pids: Record<string, number> = {}
  for (const [taskId, pid] of Object.entries(raw as Record<string, unknown>))
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) pids[taskId] = pid
  return pids
}

/**
 * Worker pid table (`<stateDir>/fleet/workers.json`): the daemon is its sole
 * writer (updated on track/untrack), so a restarted daemon can reattach to
 * live runs or fail the dead ones. Unknown shapes read as empty.
 */
export async function loadWorkerPids(stateRoot: string): Promise<Record<string, number>> {
  let raw: unknown
  try {
    raw = await readJson(fleetPaths(stateRoot).workers)
  } catch {
    return {}
  }
  return raw === undefined ? {} : WorkerPidsSchema(raw)
}

export async function saveWorkerPids(stateRoot: string, pids: Record<string, number>): Promise<void> {
  await writeJson(fleetPaths(stateRoot).workers, pids)
}

/**
 * Default gate check for landings: `es gates run` in the task worktree
 * (agent-safe, argv-only, no shell). `{ ok: true }` only on exit 0.
 */
export const defaultGateCheck =
  (esBin: string) =>
  async (worktreeDir: string): Promise<{ ok: true } | { ok: false; reason?: string }> => {
    try {
      const result = await run([esBin, "--cwd", worktreeDir, "gates", "run"], { cwd: worktreeDir, timeoutMs: 300_000 })
      return result.code === 0 ? { ok: true } : { ok: false, reason: `gates exited ${result.code}` }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
