// Pure verdict for the e2e regression gate (scripts/e2e-gate.ts, #210).
// Fail-closed: a red run with zero sampled history exits 2 (distinct from
// the exit-1 regression verdict, so humans can tell "no history" apart from
// "no regression"), and failed IDs with no history at all (renamed or new
// cases never sampled) count as regressions. Only a fully green run, or
// failures confined to known-unstable cases, exits 0.
//
// Sticky red (#323): the stable set is computed over the sampled window, so
// two red runs can pull a case under the 90% stable line and its third
// failure would pass the gate. A case that was stable before its current
// consecutive-failure streak keeps failing the gate until it passes again
// or a human acknowledges that streak in evals/acknowledgments.json. An
// acknowledgment is bound to its streak by date: a pass sampled after the
// acknowledgment's date ends the streak, and a later failure is a new
// regression the old acknowledgment never excuses.
export interface GateVerdictInput {
  /** Current-run failed case IDs. */
  readonly failed: readonly string[]
  /** Historically stable case IDs (>= 5 samples, >= 90% pass). */
  readonly stable: readonly string[]
  /** Number of prior runs actually sampled. */
  readonly sampled: number
  /** IDs seen in history (sampled at least once); defaults to `stable`. */
  readonly known?: readonly string[]
  /** Sampled prior runs, newest first; enables the sticky-red rule (#323). */
  readonly history?: readonly GateHistoryRun[]
  /** Parsed acknowledgments (evals/acknowledgments.json); defaults to none. */
  readonly acks?: readonly GateAcknowledgment[]
}

export interface GateVerdict {
  /** 0 green, 1 regression, 2 red run with no history to judge it against. */
  readonly exit: 0 | 1 | 2
  readonly message: string
}

/** One sampled prior run of the same workflow, newest first. */
export interface GateHistoryRun {
  /** Workflow run id (or sha); informational only. */
  readonly id: string
  /** ISO-8601 timestamp of the run; binds acknowledgments to a red streak. */
  readonly at: string
  /** Case id to passed. Absent means the case was not sampled in that run. */
  readonly passes: Readonly<Record<string, boolean>>
}

/** One human acknowledgment from evals/acknowledgments.json (#323). */
export interface GateAcknowledgment {
  /** The failing case id being acknowledged. */
  readonly case: string
  /** Why the red streak is accepted for now. */
  readonly reason: string
  /** Issue link tracking the underlying problem. */
  readonly issue: string
  /** ISO-8601 date the acknowledgment was written; anchors it to its streak. */
  readonly date: string
}

export function decideGateVerdict(input: GateVerdictInput): GateVerdict {
  const { failed, stable, sampled } = input
  if (!failed.length) return { exit: 0, message: "no current failures; nothing to gate." }
  const known = new Set(input.known ?? stable)
  const stableSet = new Set(stable)
  if (sampled === 0)
    return {
      exit: 2,
      message:
        `fail-closed: sampled 0 prior run(s), so ${failed.length} current failure(s) ` +
        `cannot be judged against history (unknown IDs: ${failed.join(", ")}); refusing to green a red run.`,
    }
  const history = input.history ?? []
  const acks = input.acks ?? []
  const regressions: string[] = []
  const acknowledged: string[] = []
  const unstable: string[] = []
  for (const id of failed) {
    if (stableSet.has(id) || !known.has(id)) {
      // Unknown (never-sampled) IDs stay regressions: an acknowledgment is
      // for a stable case's red streak, never for a case with no history.
      if (stableSet.has(id) && isAcknowledged(id, acks, history)) acknowledged.push(id)
      else regressions.push(id)
      continue
    }
    if (wasStableBeforeStreak(id, history)) {
      if (isAcknowledged(id, acks, history)) acknowledged.push(id)
      else regressions.push(id)
      continue
    }
    unstable.push(id)
  }
  const acknowledgedNote = (list: readonly string[]) =>
    list.length ? `; acknowledged sticky regression(s): ${list.join(", ")}` : ""
  const unstableNote = (list: readonly string[]) =>
    list.length ? `; not stable cases (passing): ${list.join(", ")}` : ""
  if (!regressions.length)
    return {
      exit: 0,
      message:
        `${failed.length} current failure(s) (${failed.join(", ")}) are not regressions of stable cases; passing.` +
        acknowledgedNote(acknowledged),
    }
  const unknown = regressions.filter((id) => !known.has(id))
  const unknownNote = unknown.length ? ` (no history for: ${unknown.join(", ")})` : ""
  return {
    exit: 1,
    message:
      `REGRESSION in historically stable case(s): ${regressions.join(", ")}${unknownNote}` +
      acknowledgedNote(acknowledged) +
      unstableNote(unstable),
  }
}

/**
 * Whether the case was stable (>= 5 samples, >= 90% pass) in the runs older
 * than its current consecutive-failure streak. `history` is newest first;
 * runs that did not sample the case neither extend nor end the streak (only
 * an observed pass ends it).
 */
function wasStableBeforeStreak(id: string, history: readonly GateHistoryRun[]): boolean {
  let at = 0
  while (at < history.length && history[at]!.passes[id] !== true) at += 1
  let samples = 0
  let passes = 0
  for (; at < history.length; at += 1) {
    const value = history[at]!.passes[id]
    if (value === undefined) continue
    samples += 1
    if (value) passes += 1
  }
  return samples >= 5 && passes / samples >= 0.9
}

/**
 * Whether a human acknowledgment covers the case's current streak: an entry
 * for the case exists and no pass was sampled after the entry's date. An
 * unparseable entry date never acknowledges (the file parser rejects it
 * first; this is the second lock). An unparseable run timestamp sorts as
 * newer than any entry (fail closed).
 */
function isAcknowledged(id: string, acks: readonly GateAcknowledgment[], history: readonly GateHistoryRun[]): boolean {
  const ack = acks.find((entry) => entry.case === id)
  if (!ack) return false
  const written = Date.parse(ack.date)
  if (Number.isNaN(written)) return false
  return !history.some((run) => run.passes[id] === true && runTime(run.at) > written)
}

function runTime(at: string): number {
  const time = Date.parse(at)
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

/**
 * Parse evals/acknowledgments.json. Fail-closed: anything but
 * `{version: 1, acknowledgments: [{case, reason, issue, date}]}` with
 * non-empty strings and a parseable date is an error, and the caller
 * (scripts/e2e-gate.ts) fails the gate rather than greening past it.
 */
export function parseAcknowledgments(text: string): { acks: GateAcknowledgment[] } | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: "acknowledgments file is not valid JSON." }
  }
  if (typeof data !== "object" || data === null) return { error: "acknowledgments file must be a JSON object." }
  const { version, acknowledgments } = data as { version?: unknown; acknowledgments?: unknown }
  if (version !== 1) return { error: "acknowledgments file must declare version 1." }
  if (!Array.isArray(acknowledgments)) return { error: "acknowledgments file must hold an acknowledgments array." }
  const acks: GateAcknowledgment[] = []
  for (const [index, entry] of acknowledgments.entries()) {
    if (typeof entry !== "object" || entry === null)
      return { error: `acknowledgments[${index}] must be an object with case, reason, issue and date.` }
    const { case: id, reason, issue, date } = entry as Record<string, unknown>
    if (typeof id !== "string" || !id || typeof reason !== "string" || !reason)
      return { error: `acknowledgments[${index}] needs a non-empty case id and reason.` }
    if (typeof issue !== "string" || !issue) return { error: `acknowledgments[${index}] needs a non-empty issue link.` }
    if (typeof date !== "string" || Number.isNaN(Date.parse(date)))
      return { error: `acknowledgments[${index}] needs a parseable ISO-8601 date.` }
    acks.push({ case: id, reason, issue, date })
  }
  return { acks }
}
