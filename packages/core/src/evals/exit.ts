// Pure exit decision for the behaviour evals (scripts/evals.ts, #322). A
// `modelLimited` note is an explicit, reviewed statement in a case file: a
// nightly whose only failures carry one is green (exit 0), so model noise the
// reviewers accepted never pages anyone. Any other failure is red (exit 1).
// An empty or missing note counts as no note (fail closed).
export interface EvalExitRow {
  readonly pass: boolean
  readonly modelLimited?: string
}

/** 0 when every failure is model-limited, else 1. */
export function decideEvalsExit(results: readonly EvalExitRow[]): 0 | 1 {
  return results.every((row) => row.pass || !!row.modelLimited) ? 0 : 1
}
