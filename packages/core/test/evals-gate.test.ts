// E2E regression gate verdict (#210): the gate must fail closed. A red run
// with zero sampled history (expired artifacts) previously exited 0, and
// renamed/never-sampled case IDs were never in `stable`, so a fully-red
// renamed suite also exited 0. Unknown IDs are regressions; zero history
// with failures is a distinct exit 2 ("no history", not "no regression").
import { describe, expect, test } from "bun:test"
import { decideEvalsExit } from "../src/evals/exit.ts"
import {
  decideGateVerdict,
  type GateAcknowledgment,
  type GateHistoryRun,
  parseAcknowledgments,
} from "../src/evals/gate.ts"

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

describe("evals exit policy (#322)", () => {
  test("all pass → 0", () => {
    expect(decideEvalsExit([{ pass: true }, { pass: true }])).toBe(0)
    expect(decideEvalsExit([])).toBe(0)
  })

  test("only model-limited failures → 0", () => {
    expect(decideEvalsExit([{ pass: false, modelLimited: "free model misses this plant" }])).toBe(0)
    expect(decideEvalsExit([{ pass: true }, { pass: false, modelLimited: "free model misses this plant" }])).toBe(0)
  })

  test("any other failure → 1", () => {
    expect(decideEvalsExit([{ pass: false }])).toBe(1)
    expect(decideEvalsExit([{ pass: false, modelLimited: "" }])).toBe(1)
    expect(decideEvalsExit([{ pass: false, modelLimited: "free model misses this plant" }, { pass: false }])).toBe(1)
  })
})

describe("sticky-red gate (#323)", () => {
  // Runs newest first. Mirrors the 2026-10-11 witness: registry-hidden-spawn
  // stable, red twice on 0aacd68, red again on 9649565 — where the old gate
  // went green because the two red runs had pulled it under 90% stable.
  const run = (id: string, at: string, passes: Record<string, boolean>): GateHistoryRun => ({ id, at, passes })
  const oldPasses = (n: number, at = "2026-10-09T06:00:00Z") =>
    Array.from({ length: n }, (_, i) => run(`old-${i}`, at, { "registry-hidden-spawn": true }))
  const ack = (date: string): GateAcknowledgment => ({
    case: "registry-hidden-spawn",
    reason: "known model flake, tracked upstream",
    issue: "https://github.com/Heretek-AI/IUMBTEMS/issues/323",
    date,
  })
  const thirdRun = {
    failed: ["registry-hidden-spawn"],
    stable: [] as string[],
    sampled: 9,
    known: ["registry-hidden-spawn", "other-case"],
    history: [
      run("r2b", "2026-10-11T14:00:00Z", { "registry-hidden-spawn": false }),
      run("r2a", "2026-10-11T12:00:00Z", { "registry-hidden-spawn": false }),
      ...Array.from({ length: 7 }, (_, i) =>
        run(`old-${i}`, "2026-10-09T06:00:00Z", { "registry-hidden-spawn": true }),
      ),
    ] as GateHistoryRun[],
  }

  test("a stable case red once is a regression with exit 1", () => {
    const verdict = decideGateVerdict({
      failed: ["registry-hidden-spawn"],
      stable: ["registry-hidden-spawn"],
      sampled: 6,
      known: ["registry-hidden-spawn"],
      history: oldPasses(6),
    })
    expect(verdict.exit).toBe(1)
    expect(verdict.message).toContain("registry-hidden-spawn")
  })

  test("three red runs in a row with no acknowledgment still exit 1", () => {
    const verdict = decideGateVerdict({ ...thirdRun, acks: [] })
    expect(verdict.exit).toBe(1)
    expect(verdict.message).toContain("registry-hidden-spawn")
  })

  test("an acknowledgment for the streak exits 0 and names the acknowledgment", () => {
    const verdict = decideGateVerdict({ ...thirdRun, acks: [ack("2026-10-12T06:00:00Z")] })
    expect(verdict.exit).toBe(0)
    expect(verdict.message).toContain("registry-hidden-spawn")
    expect(verdict.message.toLowerCase()).toContain("acknowledg")
  })

  test("a pass after the acknowledgment then a new failure exits 1 again", () => {
    const verdict = decideGateVerdict({
      failed: ["registry-hidden-spawn"],
      stable: [] as string[],
      sampled: 10,
      known: ["registry-hidden-spawn"],
      history: [
        run("r-new", "2026-10-14T06:00:00Z", { "registry-hidden-spawn": false }),
        run("r-fixed", "2026-10-13T06:00:00Z", { "registry-hidden-spawn": true }),
        ...Array.from({ length: 8 }, (_, i) =>
          run(`old-${i}`, "2026-10-10T06:00:00Z", { "registry-hidden-spawn": true }),
        ),
      ] as GateHistoryRun[],
      acks: [ack("2026-10-12T06:00:00Z")],
    })
    expect(verdict.exit).toBe(1)
    expect(verdict.message).toContain("registry-hidden-spawn")
  })

  test("an acknowledgment never excuses an unknown (never-sampled) id", () => {
    const verdict = decideGateVerdict({
      failed: ["renamed-case"],
      stable: ["old-case"],
      sampled: 6,
      known: ["old-case"],
      history: oldPasses(6),
      acks: [{ ...ack("2026-10-12T06:00:00Z"), case: "renamed-case" }],
    })
    expect(verdict.exit).toBe(1)
  })
})

describe("acknowledgment file parsing (#323)", () => {
  test("an empty acknowledgment list parses", () => {
    expect(parseAcknowledgments(`{"version":1,"acknowledgments":[]}`)).toEqual({ acks: [] })
  })

  test("a well-formed entry parses", () => {
    const parsed = parseAcknowledgments(
      `{"version":1,"acknowledgments":[{"case":"c","reason":"r","issue":"https://example.test/i/1","date":"2026-10-12"}]}`,
    )
    expect(parsed).toEqual({
      acks: [{ case: "c", reason: "r", issue: "https://example.test/i/1", date: "2026-10-12" }],
    })
  })

  test("malformed files fail closed with an error, never with acks", () => {
    for (const text of [
      "not json",
      `{"version":1}`,
      `{"version":1,"acknowledgments":{}}`,
      `{"version":2,"acknowledgments":[]}`,
      `{"version":1,"acknowledgments":[{"case":"c","reason":"r","issue":"i","date":"not-a-date"}]}`,
      `{"version":1,"acknowledgments":[{"case":"","reason":"r","issue":"i","date":"2026-10-12"}]}`,
      `{"version":1,"acknowledgments":[{"case":"c","reason":"","issue":"i","date":"2026-10-12"}]}`,
      `{"version":1,"acknowledgments":[null]}`,
    ])
      expect([text, parseAcknowledgments(text)]).toMatchObject([text, { error: expect.any(String) }])
  })
})
