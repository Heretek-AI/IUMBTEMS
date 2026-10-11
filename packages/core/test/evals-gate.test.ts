// E2E regression gate verdict (#210): the gate must fail closed. A red run
// with zero sampled history (expired artifacts) previously exited 0, and
// renamed/never-sampled case IDs were never in `stable`, so a fully-red
// renamed suite also exited 0. Unknown IDs are regressions; zero history
// with failures is a distinct exit 2 ("no history", not "no regression").
import { describe, expect, test } from "bun:test"
import { decideGateVerdict } from "../src/evals/gate.ts"

describe("e2e gate verdict (#210)", () => {
  test("a fully green run stays green", () => {
    expect(decideGateVerdict({ failed: [], stable: [], sampled: 0 }).exit).toBe(0)
    expect(decideGateVerdict({ failed: [], stable: ["a"], sampled: 6 }).exit).toBe(0)
  })

  test("zero sampled history with failures fails closed with exit 2", () => {
    const verdict = decideGateVerdict({ failed: ["case-a", "case-b"], stable: [], sampled: 0 })
    expect(verdict.exit).toBe(2)
    expect(verdict.message).toContain("sampled 0")
    expect(verdict.message).toContain("case-a")
  })

  test("unknown (never-sampled) failed IDs are regressions", () => {
    const verdict = decideGateVerdict({ failed: ["renamed-case"], stable: ["old-case"], sampled: 6 })
    expect(verdict.exit).toBe(1)
    expect(verdict.message).toContain("renamed-case")
  })

  test("a stable case failing now is a regression with exit 1", () => {
    const verdict = decideGateVerdict({ failed: ["stable-case"], stable: ["stable-case"], sampled: 6 })
    expect(verdict.exit).toBe(1)
    expect(verdict.message).toContain("stable-case")
  })

  test("known-unstable failures still pass (regressions-only gate)", () => {
    const verdict = decideGateVerdict({
      failed: ["flaky-case"],
      stable: ["stable-case"],
      sampled: 6,
      known: ["stable-case", "flaky-case"],
    })
    expect(verdict.exit).toBe(0)
  })
})
