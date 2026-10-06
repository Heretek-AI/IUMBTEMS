import { describe, expect, test } from "bun:test"
import {
  AuditEntrySchema,
  FrontierSchema,
  GatesConfigSchema,
  parseGoalMarkdown,
  RoadmapSchema,
} from "../src/schema/index.ts"
import { stringifyFrontmatter } from "../src/util/yaml.ts"

describe("schemas", () => {
  test("frontier: positive ceiling, known parents, settled needs answers and no open nodes", () => {
    const base = { idea: "x", spendCeiling: { currency: "USD", maxAmount: 50 } }
    expect(FrontierSchema.parse({ ...base, nodes: [{ id: "a", question: "q?" }] }).settled).toBe(false)
    expect(() => FrontierSchema.parse({ ...base, spendCeiling: { currency: "USD", maxAmount: -1 } })).toThrow()
    expect(() => FrontierSchema.parse({ ...base, nodes: [{ id: "a", question: "q?", parent: "zz" }] })).toThrow(
      "unknown parent",
    )
    expect(() => FrontierSchema.parse({ ...base, settled: true, nodes: [{ id: "a", question: "q?" }] })).toThrow(
      "still open",
    )
    expect(() => FrontierSchema.parse({ ...base, nodes: [{ id: "a", question: "q?", status: "settled" }] })).toThrow(
      "needs an answer",
    )
  })

  test("roadmap: kebab ids, ≤20 phases, dependencies point backwards", () => {
    const phase = (id: string, dependsOn: string[] = []) => ({ id, title: id, dependsOn })
    expect(
      RoadmapSchema.parse({ version: 1, title: "t", phases: [phase("a"), phase("b", ["a"])] }).phases,
    ).toHaveLength(2)
    expect(() => RoadmapSchema.parse({ version: 1, title: "t", phases: [phase("a", ["b"]), phase("b")] })).toThrow(
      "earlier phase",
    )
    expect(() => RoadmapSchema.parse({ version: 1, title: "t", phases: [phase("Bad Id")] })).toThrow()
    expect(() =>
      RoadmapSchema.parse({ version: 1, title: "t", phases: Array.from({ length: 21 }, (_, i) => phase(`p${i}`)) }),
    ).toThrow("20")
  })

  test("GOAL.md: typed acceptance criteria, unique ids, a body", () => {
    const goal = (acceptance: unknown[], body = "Slice body.\n") =>
      stringifyFrontmatter({ phase: "p1", title: "Phase 1", acceptance }, body)
    const parsed = parseGoalMarkdown(
      goal([
        { kind: "command", id: "c", description: "builds", command: "bun run build" },
        { kind: "test", id: "t", description: "unit", path: "test/a.test.ts" },
        { kind: "file", id: "f", description: "doc", path: "docs/a.md", contains: "Usage" },
      ]),
    )
    expect(parsed.frontmatter.acceptance.map((item) => item.kind)).toEqual(["command", "test", "file"])
    expect(() => parseGoalMarkdown(goal([]))).toThrow("at least one")
    expect(() => parseGoalMarkdown(goal([{ kind: "vibes", id: "v", description: "x" }]))).toThrow()
    const dup = { kind: "file", id: "x", description: "d", path: "a" }
    expect(() => parseGoalMarkdown(goal([dup, dup]))).toThrow("duplicate")
    expect(() => parseGoalMarkdown(goal([dup], "\n"))).toThrow("body")
  })

  test("gates config defaults", () => {
    const config = GatesConfigSchema.parse({})
    expect(config.security.secrets).toBe(true)
  })

  test("audit entry hashes are 64 hex chars", () => {
    expect(() =>
      AuditEntrySchema.parse({
        seq: 0,
        timestamp: "t",
        prevHash: "0",
        actor: "a",
        action: "b",
        payload: {},
        hash: "c",
      }),
    ).toThrow()
  })
})
