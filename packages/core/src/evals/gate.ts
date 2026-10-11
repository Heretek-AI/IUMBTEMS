// Pure verdict for the e2e regression gate (scripts/e2e-gate.ts, #210).
// Fail-closed: a red run with zero sampled history exits 2 (distinct from
// the exit-1 regression verdict, so humans can tell "no history" apart from
// "no regression"), and failed IDs with no history at all (renamed or new
// cases never sampled) count as regressions. Only a fully green run, or
// failures confined to known-unstable cases, exits 0.
export interface GateVerdictInput {
  /** Current-run failed case IDs. */
  readonly failed: readonly string[]
  /** Historically stable case IDs (>= 5 samples, >= 90% pass). */
  readonly stable: readonly string[]
  /** Number of prior runs actually sampled. */
  readonly sampled: number
  /** IDs seen in history (sampled at least once); defaults to `stable`. */
  readonly known?: readonly string[]
}

export interface GateVerdict {
  /** 0 green, 1 regression, 2 red run with no history to judge it against. */
  readonly exit: 0 | 1 | 2
  readonly message: string
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
  const regressions = failed.filter((id) => stableSet.has(id) || !known.has(id))
  if (!regressions.length)
    return {
      exit: 0,
      message: `${failed.length} current failure(s) (${failed.join(", ")}) are not regressions of stable cases; passing.`,
    }
  const unknown = regressions.filter((id) => !known.has(id))
  const unknownNote = unknown.length ? ` (no history for: ${unknown.join(", ")})` : ""
  return {
    exit: 1,
    message: `REGRESSION in historically stable case(s): ${regressions.join(", ")}${unknownNote}`,
  }
}
