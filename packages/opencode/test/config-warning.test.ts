// Legacy option wording (#240.1): 0.7-era options are ignored, not loaded —
// plugin-options only, while unknown keys in config files are
// strict-rejected; the unknowns collapse into one warning the TUI shows once.
import { describe, expect, test } from "bun:test"
import { parseOptions, unknownOptionsWarning } from "../src/runtime.ts"

describe("legacy option wording", () => {
  test("unknown plugin options are ignored (never loaded), naming the 0.7 removal", () => {
    const warning = unknownOptionsWarning(["search_engine", "max_iterations", "mode"])
    expect(warning).toContain("Ignored unknown plugin option")
    expect(warning).toContain("were removed in 1.0")
    expect(warning).not.toMatch(/load/i)
  })

  test("unknowns collapse into a single warning string", () => {
    const parsed = parseOptions({ search_engine: "x", max_iterations: 2, pr: "off" })
    expect(parsed.unknown).toEqual(["max_iterations", "search_engine"])
    expect(parsed.overrides).toEqual({ pr: "off" })
  })
})
