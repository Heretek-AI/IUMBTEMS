// Run liveness (1.1.3, #58/#61): is the run working, waiting, stuck or done?
// Everything here is read from files the engine and the plugin already
// write: the run state (saved on every seat step through recordSpend), the
// audit log, the seat records, the research cache and notes, and the pending
// approvals. `es status`, `es watch`, `es_status`, the dashboard, the prompt
// footer and the headless driver all render from one Liveness value.
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { recentAuditEntries } from "../audit/chain.ts"
import { factoryLayout } from "../layout.ts"
import { researchSourcesDir } from "../research/cache.ts"
import { type PendingApproval, pendingApprovals } from "./pending.ts"
import { readSeats, type SeatRecord } from "./seats.ts"
import type { FactoryState, Stage } from "./state.ts"

export interface FileStamp {
  readonly bytes: number
  readonly mtime: string
}

export interface ResearchProgress {
  /** Cached sources (content-addressed entries under research/sources). */
  readonly sources: number
  readonly lastSourceAt?: string
  readonly report?: FileStamp
  readonly alpha?: FileStamp
  readonly beta?: FileStamp
  /** coverage.json from the last es_research_complete attempt. */
  readonly coverage?: { readonly passed: boolean; readonly at: string }
}

export interface LivenessEvent {
  readonly seq: number
  readonly at: string
  readonly actor: string
  readonly action: string
}

export interface Liveness {
  readonly root: string
  readonly now: string
  readonly runId?: string
  readonly stage: Stage | "NONE"
  readonly updatedAt?: string
  /** The newest of every timestamp below: the run's last sign of life. */
  readonly lastActivityAt?: string
  readonly seats: readonly SeatRecord[]
  readonly research?: ResearchProgress
  readonly events: readonly LivenessEvent[]
  readonly pending: readonly PendingApproval[]
}

/** With no sign of life for this long, an active run is reported as possibly stuck. */
export const STALE_AFTER_MS = 10 * 60_000

const RECENT_EVENTS = 5

const ACTIVE_STAGES: ReadonlySet<string> = new Set(["RESEARCH", "SPEC", "BUILD", "QA", "RELEASE"])

async function stamp(file: string): Promise<FileStamp | undefined> {
  const info = await stat(file).catch(() => undefined)
  return info?.isFile() ? { bytes: info.size, mtime: info.mtime.toISOString() } : undefined
}

async function researchProgress(root: string): Promise<ResearchProgress> {
  const layout = factoryLayout(root)
  const dir = researchSourcesDir(root)
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => /^[0-9a-f]{64}\.md$/.test(name))
  let lastSourceAt: string | undefined
  for (const name of names) {
    const mtime = (await stamp(path.join(dir, name)))?.mtime
    if (mtime && (!lastSourceAt || mtime > lastSourceAt)) lastSourceAt = mtime
  }
  const [report, alpha, beta] = await Promise.all([
    stamp(layout.researchReport),
    stamp(path.join(layout.research, "alpha.md")),
    stamp(path.join(layout.research, "beta.md")),
  ])
  let coverage: ResearchProgress["coverage"]
  try {
    const raw = JSON.parse(await readFile(layout.researchCoverage, "utf8")) as { passed?: unknown; at?: unknown }
    if (typeof raw.passed === "boolean" && typeof raw.at === "string") coverage = { passed: raw.passed, at: raw.at }
  } catch {
    // No coverage yet (es_research_complete not attempted).
  }
  return {
    sources: names.length,
    ...(lastSourceAt ? { lastSourceAt } : {}),
    ...(report ? { report } : {}),
    ...(alpha ? { alpha } : {}),
    ...(beta ? { beta } : {}),
    ...(coverage ? { coverage } : {}),
  }
}

const newest = (values: ReadonlyArray<string | undefined>) =>
  values.reduce<string | undefined>((best, value) => (value && (!best || value > best) ? value : best), undefined)

/** Read the run's liveness. `state` is the already-verified run state (undefined: no run). */
export async function readLiveness(
  root: string,
  state: FactoryState | undefined,
  options: { readonly now?: Date } = {},
): Promise<Liveness> {
  const now = (options.now ?? new Date()).toISOString()
  if (!state) return { root, now, stage: "NONE", seats: [], events: [], pending: [] }
  const [seats, entries, pending, research] = await Promise.all([
    readSeats(root, state.runId),
    recentAuditEntries(root, RECENT_EVENTS),
    pendingApprovals(root),
    state.stage === "RESEARCH" ? researchProgress(root) : Promise.resolve(undefined),
  ])
  const events = entries.map((entry) => ({
    seq: entry.seq,
    at: entry.timestamp,
    actor: entry.actor,
    action: entry.action,
  }))
  const lastActivityAt = newest([
    state.updatedAt,
    events.at(-1)?.at,
    ...seats.map((seat) => seat.lastActivityAt),
    research?.lastSourceAt,
    research?.report?.mtime,
    research?.alpha?.mtime,
    research?.beta?.mtime,
  ])
  return {
    root,
    now,
    runId: state.runId,
    stage: state.stage,
    updatedAt: state.updatedAt,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    seats,
    ...(research ? { research } : {}),
    events,
    pending,
  }
}

/** Milliseconds from `from` to `to` (ISO strings), never negative. */
const elapsed = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from))

/** "12s", "4m", "3h", "2d". */
export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 48 * 3600) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/** "12s ago" relative to the liveness clock. */
export const ago = (liveness: Pick<Liveness, "now">, at: string | undefined) =>
  at ? `${formatAge(elapsed(at, liveness.now))} ago` : "never"

const STAGE_WORD: Record<string, string> = {
  RESEARCH: "Research",
  SPEC: "Spec writing",
  RELEASE: "Release",
}

const stageWork = (state: FactoryState) =>
  state.mode === "research" && state.stage === "RESEARCH"
    ? "Research run"
    : state.stage === "BUILD"
      ? `Building ${state.activePhase ?? "the next phase"}`
      : state.stage === "QA"
        ? `QA on ${state.activePhase ?? "the active phase"}`
        : (STAGE_WORD[state.stage] ?? state.stage)

const shortSession = (sessionID: string) => (sessionID.length > 16 ? sessionID.slice(0, 16) : sessionID)

/** What one seat is doing, in words: "es-research-alpha last ran es_research_fetch 12s ago". */
const seatDoing = (liveness: Liveness, seat: SeatRecord) =>
  `${seat.agent} ${seat.lastTool ? `last ran ${seat.lastTool}` : "started"} ${ago(liveness, seat.lastActivityAt)}`

/**
 * One plain sentence: is the run working, waiting on a human, stuck, halted
 * or done? It reports and never acts; "may be stuck" is a hint, not a verdict.
 */
export function headline(state: FactoryState | undefined, liveness: Liveness): string {
  if (!state) return "No factory run in this project. Start one with /grill."
  if (state.stage === "HALTED")
    return `Halted: ${state.halt?.reason ?? "unknown reason"}. A human must resume it (\`es factory resume\`, or /es-resume to preview).`
  if (state.stage === "DONE")
    return state.release?.prUrl
      ? `Done: the pull request is open at ${state.release.prUrl}.`
      : "Done: the run is complete."
  if (liveness.pending.length) {
    const stages = liveness.pending.map((item) => item.stage)
    return `Waiting for you: approve the ${stages.join(" and ")} with /es-approve (or \`es approve ${stages[0]}\` in a terminal).`
  }
  if (state.stage === "GRILL") return "The grill is running: answer its questions in the grill session."
  const running = liveness.seats.filter((seat) => seat.state === "running")
  const quietFor = liveness.lastActivityAt ? elapsed(liveness.lastActivityAt, liveness.now) : 0
  if (ACTIVE_STAGES.has(state.stage) && quietFor >= STALE_AFTER_MS) {
    const seat = running.at(-1)
    return `No activity for ${formatAge(quietFor)} in ${state.stage}${seat ? ` while ${seat.agent} is marked running (session ${shortSession(seat.sessionID)})` : ""}. It may be stuck: check ${seat ? "that session" : "the factory session"}, or create .factory/STOP to halt.`
  }
  if (running.length)
    return `${stageWork(state)} is running: ${running.map((seat) => seatDoing(liveness, seat)).join("; ")}.`
  return `${stageWork(state)} in progress: no seat is running; last activity ${ago(liveness, liveness.lastActivityAt)}.`
}

/** "es-research-alpha  running  es_research_fetch 12s ago  ses_ee6b70e18ffe". */
export function seatLine(liveness: Liveness, seat: SeatRecord): string {
  const when =
    seat.state === "running"
      ? `${seat.lastTool ?? "started"} ${ago(liveness, seat.lastActivityAt)}`
      : `${ago(liveness, seat.endedAt ?? seat.lastActivityAt)}`
  return `${seat.agent}  ${seat.state}  ${when}  ${shortSession(seat.sessionID)}`
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)

const fileBit = (liveness: Liveness, name: string, file: FileStamp | undefined) =>
  file ? `${name} ${kb(file.bytes)} (${ago(liveness, file.mtime)})` : `${name} —`

/** "10 sources (newest 1m ago) · alpha.md 4.1 KB (2m ago) · beta.md — · REPORT.md — · coverage not checked". */
export function researchLine(liveness: Liveness): string | undefined {
  const research = liveness.research
  if (!research) return undefined
  return [
    `${research.sources} source${research.sources === 1 ? "" : "s"}${research.lastSourceAt ? ` (newest ${ago(liveness, research.lastSourceAt)})` : ""}`,
    fileBit(liveness, "alpha.md", research.alpha),
    fileBit(liveness, "beta.md", research.beta),
    fileBit(liveness, "REPORT.md", research.report),
    research.coverage ? `coverage ${research.coverage.passed ? "passed" : "failed"}` : "coverage not checked",
  ].join(" · ")
}

/**
 * The liveness lines agents see under `es_status` (the `<factory-state>`
 * block above them stays stable, so it is not repeated here).
 */
export function livenessLines(state: FactoryState | undefined, liveness: Liveness): string[] {
  if (!state) return []
  const lines = [headline(state, liveness), `last activity ${ago(liveness, liveness.lastActivityAt)}`]
  if (liveness.seats.length)
    lines.push(`seats:\n${liveness.seats.map((seat) => `  ${seatLine(liveness, seat)}`).join("\n")}`)
  const research = researchLine(liveness)
  if (research) lines.push(`research: ${research}`)
  return lines
}

/** "run run-… · RESEARCH · /path/to/project · updated 40s ago": which run, where, how fresh. */
export const headerLine = (state: FactoryState, liveness: Liveness) =>
  `run ${state.runId} · ${state.stage} · ${liveness.root} · updated ${ago(liveness, state.updatedAt)}`

/** "21:58:40  human:john  stage.research", in local time (the views are for the human at this machine). */
export const eventLine = (event: LivenessEvent) =>
  `${new Date(event.at).toTimeString().slice(0, 8)}  ${event.actor}  ${event.action}`

/**
 * The one-line TUI footer indicator: hidden without a run, otherwise the
 * stage and what it is doing ("ES · RESEARCH · es-research-alpha running ·
 * 12s"), or what it waits for.
 */
export function footerLine(state: FactoryState | undefined, liveness: Liveness, paused?: string): string | undefined {
  if (!state) return undefined
  if (state.stage === "HALTED") return "ES · HALTED · a human must resume"
  if (state.stage === "DONE") return "ES · DONE"
  if (liveness.pending.length)
    return `ES · waiting on you: approve ${liveness.pending.map((item) => item.stage).join(", ")}`
  if (paused) return `ES · ${state.stage} · paused (no progress) · /factory continues`
  const running = liveness.seats.filter((seat) => seat.state === "running")
  const newest = running.reduce<SeatRecord | undefined>(
    (best, seat) => (!best || seat.lastActivityAt > best.lastActivityAt ? seat : best),
    undefined,
  )
  if (newest)
    return `ES · ${state.stage} · ${running.length === 1 ? `${newest.agent} running` : `${running.length} seats running`} · ${formatAge(elapsed(newest.lastActivityAt, liveness.now))}`
  return `ES · ${state.stage} · last activity ${ago(liveness, liveness.lastActivityAt)}`
}

/**
 * The human view (`es status`, `es watch`): the headline, then which run in
 * which project and how fresh it is, then the summary block's lines, seats,
 * research progress, recent audit events and what waits on a human.
 */
export function formatHuman(state: FactoryState | undefined, liveness: Liveness, summary: string): string {
  const lines = [headline(state, liveness)]
  if (!state) return lines.join("\n")
  lines.push(headerLine(state, liveness))
  const body = summary
    .replace(/^<factory-state>\n?/, "")
    .replace(/\n?<\/factory-state>$/, "")
    .split("\n")
    .filter((line) => line && !line.startsWith("run "))
  lines.push(...body)
  if (liveness.seats.length) {
    lines.push("seats:")
    for (const seat of liveness.seats) lines.push(`  ${seatLine(liveness, seat)}`)
  }
  const research = researchLine(liveness)
  if (research) lines.push(`research: ${research}`)
  if (liveness.events.length) {
    lines.push("recent events:")
    for (const event of liveness.events) lines.push(`  ${eventLine(event)}`)
  }
  if (liveness.pending.length)
    lines.push(
      `waiting on you: ${liveness.pending.map((item) => `approve ${item.stage} (/es-approve, or \`es approve ${item.stage}\`)`).join(", ")}`,
    )
  return lines.join("\n")
}

/**
 * Progress fingerprint shared by the in-host continuation and the headless
 * driver: a turn that leaves it unchanged made no progress. It covers the
 * stage machine, research artifacts, seat outcomes and the audit log's head;
 * spend and seat activity are left out, because the factory's own steps would
 * otherwise always count as progress.
 */
export function progressPrint(state: FactoryState | undefined, liveness: Liveness): string {
  const research = liveness.research
  return JSON.stringify([
    state?.stage,
    state?.activePhase,
    state?.phases.map((phase) => [phase.status, phase.failures, phase.history.length]),
    research
      ? [research.sources, research.report?.mtime, research.alpha?.mtime, research.beta?.mtime, research.coverage?.at]
      : null,
    liveness.seats.map((seat) => [seat.sessionID, seat.state]),
    liveness.events.at(-1)?.seq,
  ])
}
