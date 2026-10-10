// The package-boundary gate's type-only rule (scripts/deps.ts): web may import
// fleet only when the import is erased at compile time. The repo compiles with
// `verbatimModuleSyntax: true` (tsconfig.base.json), so only a top-level
// `import type`/`export type` is erased.
import { describe, expect, test } from "bun:test"
import { importsOf } from "../../../scripts/imports.ts"

const only = (source: string) => {
  const refs = importsOf(source)
  expect(refs).toHaveLength(1)
  return refs[0]!
}

describe("importsOf: type-only means erased under verbatimModuleSyntax", () => {
  test("top-level import type / export type forms are type-only", () => {
    for (const source of [
      'import type { FleetSnapshot } from "@heretek-ai/es-fleet"',
      'import type {\n  BusEvent,\n  TaskLiveness,\n} from "@heretek-ai/es-fleet"',
      'import type * as Fleet from "@heretek-ai/es-fleet"',
      'import type Fleet from "@heretek-ai/es-fleet"',
      'export type { FleetSnapshot } from "@heretek-ai/es-fleet"',
    ])
      expect(only(source)).toEqual({ specifier: "@heretek-ai/es-fleet", typeOnly: true })
  })

  test("inline type members still load the module at runtime", () => {
    // verbatimModuleSyntax keeps these as `import {} from "…"` / `export {} from "…"`.
    for (const source of [
      'import { type FleetSnapshot } from "@heretek-ai/es-fleet"',
      'import { type BusEvent, type TaskLiveness } from "@heretek-ai/es-fleet"',
      'export { type FleetSnapshot } from "@heretek-ai/es-fleet"',
    ])
      expect(only(source).typeOnly).toBe(false)
  })

  test("a default import named `type` is a value import", () => {
    expect(only('import type from "@heretek-ai/es-fleet"').typeOnly).toBe(false)
    expect(only('import type, { FleetSnapshot } from "@heretek-ai/es-fleet"').typeOnly).toBe(false)
  })

  test("value, side-effect and dynamic imports are never type-only", () => {
    for (const source of [
      'import { TelemetryServer } from "@heretek-ai/es-fleet"',
      'import "@heretek-ai/es-fleet"',
      'const fleet = await import("@heretek-ai/es-fleet")',
      'export * from "@heretek-ai/es-fleet"',
    ])
      expect(only(source)).toEqual({ specifier: "@heretek-ai/es-fleet", typeOnly: false })
  })
})
