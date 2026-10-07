// The drift canary: feed the checker deliberately drifted corpora and expect
// every class of drift to be caught, then run it on the repo and expect none.
// `bun run docs:check` runs the same checker in CI, so an orphaned prompt or
// skill, a seat rename without a frontmatter update, a skill without its
// SKILL.md, an unknown spawn or tool all turn the pipeline red.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { assetDrift, findAssetDrift } from "../src/index.ts"

const prompt = (fields: Record<string, string | number>, body = "The alpha prompt body text.") =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n${body}\n`

const validPrompt = () => prompt({ id: "alpha", version: 1, seat: "programmer", description: "The alpha seat prompt." })

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "alpha",
  prompt: "alpha",
  seat: "programmer",
  skills: ["grill"],
  spawns: [],
  tools: ["es_status"],
  ...overrides,
})

const corpus = (overrides: Record<string, unknown> = {}) => ({
  prompts: new Map([["alpha", validPrompt()]]),
  skills: ["grill"],
  agents: [agent()],
  tools: ["es_status"],
  ...overrides,
})

describe("asset drift", () => {
  test("a consistent corpus has no drift", () => {
    expect(assetDrift(corpus())).toEqual([])
  })

  test("every planted drift class is caught", () => {
    expect(assetDrift(corpus({ prompts: new Map() }))).toContain("alpha: missing prompt file alpha.md")
    expect(
      assetDrift(corpus({ prompts: new Map([["alpha", prompt({ id: "beta", version: 1, seat: "programmer" })]]) })),
    ).toContain('alpha: prompt alpha.md declares id "beta"')
    expect(
      assetDrift(corpus({ prompts: new Map([["alpha", prompt({ id: "alpha", version: 1, seat: "qa-functional" })]]) })),
    ).toContain('alpha: prompt alpha.md declares seat "qa-functional", registry says "programmer"')
    expect(
      assetDrift(
        corpus({
          prompts: new Map([
            ["alpha", validPrompt()],
            ["orphan", validPrompt()],
          ]),
        }),
      ),
    ).toContain("orphan prompt file: orphan.md")
    expect(assetDrift(corpus({ skills: [] }))).toContain("alpha: missing skill grill/")
    expect(assetDrift(corpus({ agents: [agent({ skills: [] })] }))).toContain("orphan skill directory: grill/")
    expect(assetDrift(corpus({ agents: [agent({ spawns: ["es-ghost"] })] }))).toContain(
      "alpha: spawns unknown agent es-ghost",
    )
    expect(assetDrift(corpus({ agents: [agent({ tools: ["es_imaginary"] })] }))).toContain(
      "alpha: unknown tool es_imaginary",
    )
    expect(assetDrift(corpus({ agents: [agent(), agent({ prompt: "beta", skills: [] })] }))).toContain(
      "duplicate agent id: alpha",
    )
  })

  test("a skill directory without a SKILL.md is drift; reading the tree finds it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-drift-"))
    try {
      const promptsDir = path.join(dir, "prompts")
      const skillsDir = path.join(dir, "skills")
      await mkdir(promptsDir, { recursive: true })
      await mkdir(path.join(skillsDir, "grill"), { recursive: true })
      await writeFile(path.join(promptsDir, "alpha.md"), validPrompt())
      const drift = await findAssetDrift({
        promptsDir,
        skillsDir,
        agents: [agent()],
        tools: ["es_status"],
      })
      expect(drift).toContain("skill grill: SKILL.md is missing")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the repository itself has no asset drift", async () => {
    const repo = path.resolve(import.meta.dir, "../../..")
    expect(
      await findAssetDrift({
        promptsDir: path.join(repo, "packages/core/assets/prompts"),
        skillsDir: path.join(repo, "packages/core/assets/skills"),
      }),
    ).toEqual([])
  })
})
