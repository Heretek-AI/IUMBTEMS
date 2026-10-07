// The minimal-dependency rule for `@heretek-ai/es-core`, enforced on this
// repository by `bun run deps:check` (the plan: "anything else needs a recorded
// justification, enforced by our own gate"). Pure, so it is unit-testable.
import { describe, expect, test } from "bun:test"
import { CORE_DEPENDENCY_ALLOWLIST, checkDependencies } from "../src/index.ts"

describe("the core minimal-dependency gate", () => {
  test("allowlisted dependencies pass", () => {
    const deps = Object.fromEntries(CORE_DEPENDENCY_ALLOWLIST.map((name) => [name, "1.0.0"]))
    expect(checkDependencies(deps)).toEqual({ ok: true, violations: [] })
  })

  test("a dependency outside the allowlist is a violation without a justification", () => {
    const check = checkDependencies({ zod: "4.6.5", leftpad: "1.0.0" })
    expect(check.ok).toBe(false)
    expect(check.violations).toEqual([
      { name: "leftpad", reason: "not in the allowlist and has no recorded justification" },
    ])
  })

  test("a recorded justification clears the violation", () => {
    const check = checkDependencies({ leftpad: "1.0.0" }, { leftpad: "needed for X; MIT; maintained" })
    expect(check).toEqual({ ok: true, violations: [] })
  })

  test("a blank justification does not clear the violation", () => {
    expect(checkDependencies({ leftpad: "1.0.0" }, { leftpad: "   " }).ok).toBe(false)
  })
})
