// Self-dogfood preset (#137): the factory builds this repo. Preset files
// validate against their schemas, init seeds the run with the release base
// pinned to `rewrite`, and the PR argv never names `main`.
import { describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  EsConfigSchema,
  factoryLayout,
  GatesConfigSchema,
  initFromPreset,
  invokesHumanOnly,
  KNOWN_PRESETS,
  presetsDir,
  RoadmapSchema,
  readPreset,
  SELF_DOGFOOD_BASE_BRANCH,
  selfDogfoodPrArgs,
} from "../src/index.ts"

describe("self-dogfood preset files", () => {
  test("the preset is known and its control files validate", async () => {
    expect(KNOWN_PRESETS).toContain("self-dogfood")
    const preset = await readPreset("self-dogfood")
    const config = EsConfigSchema.parse(JSON.parse(preset.config))
    expect(config.audit?.phase).toBe("required")
    expect(config.pr).toBe("gh")
    const gates = GatesConfigSchema.parse(JSON.parse(preset.gates))
    expect(gates.commands.map((command) => command.command)).toEqual([
      "bun install --frozen-lockfile",
      "bun run check",
      "bun run docs:check",
    ])
  })

  test("unknown presets are refused", async () => {
    await expect(readPreset("no-such-preset")).rejects.toThrow('unknown preset "no-such-preset"')
  })

  test("the idea-from-issue helper exists and is executable", async () => {
    const script = path.join(presetsDir(), "self-dogfood", "idea-from-issue.sh")
    await access(script)
    const proc = Bun.spawn(["sh", "-n", script], { stdout: "pipe", stderr: "pipe" })
    expect(await proc.exited).toBe(0)
  })
})

describe("initFromPreset", () => {
  test("seeds control files, a rewrite-based roadmap and the issue idea", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-preset-"))
    try {
      const { written, baseBranch } = await initFromPreset(root, "self-dogfood", {
        issue: 137,
        title: "Self-dogfood preset",
        body: "The factory builds this repo.",
      })
      expect(baseBranch).toBe("rewrite")
      expect(written).toEqual([
        ".factory/config.json",
        ".factory/gates.json",
        ".factory/roadmap.json",
        ".factory/notes/idea-137.md",
      ])
      const layout = factoryLayout(root)
      expect(RoadmapSchema.parse(JSON.parse(await readFile(layout.roadmap, "utf8"))).baseBranch).toBe("rewrite")
      expect(GatesConfigSchema.parse(JSON.parse(await readFile(layout.gates, "utf8"))).commands).toHaveLength(3)
      expect(await readFile(path.join(root, ".factory/notes/idea-137.md"), "utf8")).toContain(
        "# #137: Self-dogfood preset",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("self-dogfood PR base", () => {
  test("the draft PR targets rewrite, never main", () => {
    expect(SELF_DOGFOOD_BASE_BRANCH).toBe("rewrite")
    const argv = selfDogfoodPrArgs({ branch: "factory/x/integration", title: "t", body: "b" })
    expect(argv).toContain("--draft")
    expect(argv.slice(argv.indexOf("--base") + 1, argv.indexOf("--base") + 2)).toEqual(["rewrite"])
    expect(argv).not.toContain("main")
  })
})

describe("factory init is human-only", () => {
  test("agents are refused the init verb", () => {
    expect(invokesHumanOnly("es factory init --preset self-dogfood --issue 137")).toBe(true)
    expect(invokesHumanOnly("es factory begin")).toBe(false)
  })
})
