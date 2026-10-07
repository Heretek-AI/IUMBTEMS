// The opt-in eval grader: contains / notContains, case-insensitive.
import { describe, expect, test } from "bun:test"
import { gradeOutput } from "../src/index.ts"

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
