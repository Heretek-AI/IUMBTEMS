# SWE Benchmark Suite (#171)

54 isolated software engineering instances across algorithms (16),
refactoring (12), API integration (12) and debugging (14), graded by a
deterministic oracle: compilation (a real bundle build of the entry module),
property tests (exported functions, deep-compared) and a performance budget.

## Layout

- Catalog + harness: `packages/core/src/evals/benchmark-cases.ts`,
  `packages/core/src/evals/benchmarks.ts` (unit-tested in
  `packages/core/test/benchmarks.test.ts`).
- `baseline.json`: reference metrics (all green). The smoke run rewrites it
  and prints the delta against the previous baseline.
- `results/`: model-run records (`results.jsonl`) and retained failing
  workspaces.

## Commands

```sh
bun scripts/benchmarks.ts            # oracle smoke: references green, seeds red
bun scripts/benchmarks.ts --model    # one real model turn per case (opt-in)
```

Smoke is fast, deterministic and model-free. `--model` needs the opencode
CLI and `ES_EVAL_MODEL`, honors `ES_BENCH_MAX_STEPS` (default 24),
`ES_BENCH_TIMEOUT_MS` (default 300000) and `ES_BENCH_MAX_USD`, and skips
cleanly without credentials.

## Policy

- Never CI-blocking: CI runs only the unit self-check
  (`benchmarks.test.ts`), never `scripts/benchmarks.ts --model`.
- Model runs are spend-bearing and human-dispatched, like `bun run evals`.
- Catalog seeds are reviewed repo files and must terminate; the self-check
  proves it by completing.
- The oracle stays hidden from the agent: model prompts name the entry
  module and the behaviour bar, never the properties.
