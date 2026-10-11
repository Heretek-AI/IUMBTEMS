// Issue #205 integration (self-dogfood preset): seed a temp clone through
// library calls only and prove the gates stay untrusted until a human trusts
// them. Never runs a human-only verb (`es factory init`, `es trust`): the only
// human-only assertions are pipe-level policy checks via `invokesHumanOnly`,
// and no trust entry is ever written.
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  commandSetHash,
  EsConfigSchema,
  factoryLayout,
  GatesConfigSchema,
  initFromPreset,
  invokesHumanOnly,
  isTrusted,
  RoadmapSchema,
  runGates,
  SELF_DOGFOOD_BASE_BRANCH,
} from "../src/index.ts"
import { gitRepo } from "./helpers.ts"

describe("self-dogfood preset integration (#205)", () => {
  test("init seeds config, gates, roadmap and the issue note in a temp clone", async () => {
    const fx = await gitRepo("es-205-preset-")
    try {
      const { written, baseBranch } = await initFromPreset(
        fx.root,
        "self-dogfood",
        { issue: 205, title: "Self-dogfood preset", body: "The factory builds this repo." },
        { actor: "human:tester" },
      )
      // Current behavior (#281 owns the base-selection question): the seed
      // pins the release base to `rewrite`.
      expect(baseBranch).toBe("rewrite")
      expect(SELF_DOGFOOD_BASE_BRANCH).toBe("rewrite")
      expect(written).toEqual([
        ".factory/config.json",
        ".factory/gates.json",
        ".factory/roadmap.json",
        ".factory/notes/idea-205.md",
      ])
      const layout = factoryLayout(fx.root)
      const config = EsConfigSchema.parse(JSON.parse(await readFile(layout.config, "utf8")))
      expect(config.audit?.phase).toBe("required")
      expect(config.pr).toBe("gh")
      const gates = GatesConfigSchema.parse(JSON.parse(await readFile(layout.gates, "utf8")))
      expect(gates.commands.map((command) => command.command)).toEqual([
        "bun install --frozen-lockfile",
        "bun run check",
        "bun run docs:check",
      ])
      const roadmap = RoadmapSchema.parse(JSON.parse(await readFile(layout.roadmap, "utf8")))
      expect(roadmap.baseBranch).toBe("rewrite")
      expect(roadmap.title).toContain("205")
      expect(await readFile(`${fx.root}/.factory/notes/idea-205.md`, "utf8")).toContain("# #205:")
    } finally {
      await fx.cleanup()
    }
  })

  test("preset gates are untrusted until a human trusts them (no trust performed)", async () => {
    const fx = await gitRepo("es-205-trust-")
    try {
      await initFromPreset(
        fx.root,
        "self-dogfood",
        { issue: 205, title: "Self-dogfood preset", body: "The factory builds this repo." },
        { actor: "human:tester" },
      )
      const layout = factoryLayout(fx.root)
      const gates = GatesConfigSchema.parse(JSON.parse(await readFile(layout.gates, "utf8")))
      // Trust-hash refusal: the fresh state dir holds no entry for this set.
      // No `trustProject` call happens in this test (that stays human-only).
      const { hash } = await commandSetHash(fx.root, gates.commands)
      expect(await isTrusted(fx.root, hash, fx.state)).toBe(false)

      const report = await runGates({ root: fx.root, scope: "full", stateDir: fx.state })
      expect(report.passed).toBe(false)
      expect(report.findings[0]?.rule).toBe("trust/untrusted")
      expect(report.findings[0]?.fixHint).toContain("es trust")
      expect(report.checks.find((check) => check.id === "trust")?.status).toBe("fail")
      // None of the preset commands ran: no per-command checks were recorded.
      for (const id of ["install", "check", "docs-check"])
        expect(report.checks.some((check) => check.id === id)).toBe(false)
    } finally {
      await fx.cleanup()
    }
  })

  test("seeding and trusting stay human-only (policy assert only, nothing executed)", () => {
    expect(invokesHumanOnly("es factory init --preset self-dogfood --issue 205")).toBe(true)
    expect(invokesHumanOnly("es trust")).toBe(true)
    expect(invokesHumanOnly("es factory begin")).toBe(false)
  })
})
