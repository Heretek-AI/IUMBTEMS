// The opt-in eval grader: contains / notContains (case-insensitive), tools
// used / not used, and error events, over an `opencode run --format json` stream.
import { describe, expect, test } from "bun:test"
import { gradeOutput, gradeTranscript, readTranscript } from "../src/index.ts"

describe("the eval grader", () => {
  test("empty checks always pass", () => {
    expect(gradeOutput("anything", {})).toEqual({ pass: true, failures: [] })
  })

  test("contains is case-insensitive", () => {
    expect(gradeOutput("Spend Ceiling: $5", { contains: ["spend ceiling"] }).pass).toBe(true)
    expect(gradeOutput("nothing here", { contains: ["spend ceiling"] })).toEqual({
      pass: false,
      failures: ["missing: spend ceiling"],
    })
  })

  test("notContains fails when a banned string appears", () => {
    expect(gradeOutput("an error: boom", { notContains: ["error:"] }).pass).toBe(false)
    expect(gradeOutput("all good", { notContains: ["error:"] }).pass).toBe(true)
  })

  test("collects every failure", () => {
    const grade = gradeOutput("hello", { contains: ["a", "b"], notContains: ["hello"] })
    expect(grade.pass).toBe(false)
    expect(grade.failures).toEqual(["missing: a", "missing: b", "must not contain: hello"])
  })
})

describe("transcripts", () => {
  const events = [
    { type: "step_start", part: {} },
    { type: "tool_use", part: { tool: "es_brainstorm_plan", state: { status: "completed" } } },
    { type: "step_start", part: {} },
    { type: "text", part: { text: "Lenses: Inversion, SCAMPER." } },
  ]

  test("text, tools and steps are read from the event stream", () => {
    expect(readTranscript(events)).toEqual({
      text: "Lenses: Inversion, SCAMPER.",
      tools: ["es_brainstorm_plan"],
      errors: [],
      steps: 2,
    })
  })

  test("tool checks and error events grade the run", () => {
    const transcript = readTranscript(events)
    expect(gradeTranscript(transcript, { toolsUsed: ["es_brainstorm_plan"], contains: ["inversion"] }).pass).toBe(true)
    expect(gradeTranscript(transcript, { toolsNotUsed: ["es_brainstorm_plan"] }).failures).toEqual([
      "must not call: es_brainstorm_plan",
    ])
    const failed = readTranscript([...events, { type: "error", error: { message: "Agent not found" } }])
    expect(gradeTranscript(failed, {}).failures).toEqual(["error event: Agent not found"])
  })
})
