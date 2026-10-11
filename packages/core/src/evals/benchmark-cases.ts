// Benchmark catalog (#171): 54 isolated software engineering instances across
// algorithms, refactoring, API integration and debugging. Each case is a seed
// workspace (stub or buggy code) plus a hidden oracle (properties, source
// constraints, perf budget) and a verified reference solution. The oracle
// self-check (benchmarks.test.ts) grades every reference green and every seed
// red, proving the oracle discriminates. Cases live in ./benchmarks/ per
// category so no single file trips the file-size budgets.

import { ALGORITHMS } from "./benchmarks/algorithms.ts"
import { API_INTEGRATION } from "./benchmarks/api-integration.ts"
import { DEBUGGING } from "./benchmarks/debugging.ts"
import { REFACTORING } from "./benchmarks/refactoring.ts"
import type { BenchmarkCase } from "./benchmarks.ts"

export const BENCHMARKS: readonly BenchmarkCase[] = [...ALGORITHMS, ...REFACTORING, ...API_INTEGRATION, ...DEBUGGING]
