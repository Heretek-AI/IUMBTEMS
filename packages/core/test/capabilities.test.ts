// The capability matrix contract: every harness declares every capability
// once, ENFORCED rows name a proof that exists, and the 1.1–1.3 adapters are
// declared gaps rather than silently missing.
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { CAPABILITIES, CAPABILITY_MATRIX, degradedRows, enforcedWithoutProof, hookCapabilities } from "../src/index.ts"

const repoRoot = path.resolve(import.meta.dir, "../../..")

describe("the capability matrix", () => {
  test("every harness declares every capability exactly once", () => {
    const harnesses = Object.keys(CAPABILITY_MATRIX)
    expect(harnesses).toEqual(["opencode", "claude", "pi", "antigravity"])
    for (const rows of Object.values(CAPABILITY_MATRIX)) {
      expect(rows.map((row) => row.capability)).toEqual([...CAPABILITIES])
      expect(new Set(rows.map((row) => row.capability)).size).toBe(rows.length)
      for (const row of rows) expect(row.detail.length).toBeGreaterThan(20)
    }
  })

  test("ENFORCED rows name a proof that exists in the repo", () => {
    for (const harness of Object.keys(CAPABILITY_MATRIX) as Array<keyof typeof CAPABILITY_MATRIX>) {
      expect(enforcedWithoutProof(harness)).toEqual([])
      for (const row of CAPABILITY_MATRIX[harness])
        if (row.support === "enforced") expect(existsSync(path.join(repoRoot, row.test!))).toBe(true)
    }
  })

  test("opencode is fully enforced; the later adapters are declared gaps", () => {
    expect(degradedRows("opencode")).toEqual([])
    for (const harness of ["claude", "pi", "antigravity"] as const) {
      expect(degradedRows(harness)).toHaveLength(CAPABILITIES.length)
      expect(degradedRows(harness).every((row) => row.support === "unsupported")).toBe(true)
    }
  })

  test("hook capabilities expose the per-harness detail", () => {
    expect(hookCapabilities("opencode").events.PreToolUse).toBe("enforced")
    expect(hookCapabilities("opencode").events.Stop).toBe("advisory")
    // No adapter ships for the later harnesses, so nothing is enforced yet.
    expect(hookCapabilities("claude").events.Stop).toBe("unsupported")
    expect(hookCapabilities("pi").events.PreToolUse).toBe("unsupported")
    expect(hookCapabilities("antigravity").events.PreToolUse).toBe("unsupported")
  })

  test("enforced hook rows require an enforced, proven matrix row (no overclaiming)", () => {
    for (const harness of Object.keys(CAPABILITY_MATRIX) as Array<keyof typeof CAPABILITY_MATRIX>) {
      const hooksRow = CAPABILITY_MATRIX[harness].find((row) => row.capability === "hooks")!
      const caps = hookCapabilities(harness)
      const enforced = [...Object.values(caps.events), ...Object.values(caps.handlerTypes)].filter(
        (support) => support === "enforced",
      )
      if (hooksRow.support === "enforced") {
        // An enforced hooks capability must name a proof that exists.
        expect(hooksRow.test).toBeTruthy()
        expect(existsSync(path.join(repoRoot, hooksRow.test!))).toBe(true)
      } else {
        // A harness without an enforced hooks capability must not claim any enforced event or type.
        expect(enforced).toEqual([])
      }
      expect(caps.notes.length).toBeGreaterThan(0)
    }
  })
})
