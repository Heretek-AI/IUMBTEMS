// Audit #203 — layered model tiers, global → project → plugin options.
//
// The full three-layer conflict (each layer wins a different tier) through
// loadEsConfig, the strict side of the unknown-key contract (config files
// reject unknowns, including 0.7-era keys — plugin options only warn, proven
// in packages/opencode/test/config-layers-203.test.ts), and the human-only
// boundary for `es config set` through the shell policy.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadEsConfig } from "../src/index.ts"
import { evaluateShell, invokesHumanOnly } from "../src/trust/index.ts"

let root: string
let env: NodeJS.ProcessEnv
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-203-layers-"))
  env = { XDG_CONFIG_HOME: path.join(root, "xdg") }
})
afterEach(() => rm(root, { recursive: true, force: true }))

const writeGlobal = async (value: unknown) => {
  const file = path.join(env.XDG_CONFIG_HOME!, "epistemic-swarm", "config.json")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value))
  return file
}
const writeProject = async (value: unknown) => {
  await mkdir(path.join(root, ".factory"), { recursive: true })
  const file = path.join(root, ".factory", "config.json")
  await writeFile(file, JSON.stringify(value))
  return file
}

describe("three-layer tier precedence (#203)", () => {
  test("each layer wins a different tier: options > project > global", async () => {
    const global = await writeGlobal({
      models: { fast: "global/fast", balanced: "global/balanced", deep: "global/deep" },
    })
    const project = await writeProject({ models: { fast: "project/fast", deep: "project/deep" } })
    const loaded = await loadEsConfig(root, { env, overrides: { models: { fast: "options/fast" } } })
    expect(loaded.sources).toEqual([global, project])
    expect(loaded.config.models).toEqual({
      fast: "options/fast",
      balanced: "global/balanced",
      deep: "project/deep",
    })
  })

  test("a lower layer survives wherever a higher layer is silent", async () => {
    await writeGlobal({ models: { deep: "global/deep" }, pr: "off" })
    await writeProject({ pr: "gh" })
    const loaded = await loadEsConfig(root, { env, overrides: { afterEdit: "off" } })
    expect(loaded.config.models).toEqual({ deep: "global/deep" })
    expect(loaded.config.pr).toBe("gh")
    expect(loaded.config.afterEdit).toBe("off")
  })
})

describe("config-file unknowns are rejected, strictly (#203)", () => {
  test.each(["search_engine", "max_iterations", "mode"])(
    "project file: 0.7-era key %s is rejected, naming it",
    async (key: string) => {
      await writeProject({ [key]: key === "max_iterations" ? 2 : "x" })
      await expect(loadEsConfig(root, { env })).rejects.toThrow(new RegExp(`invalid config.*${key}`))
    },
  )

  test("project file: a typo key is rejected with the source named", async () => {
    const project = await writeProject({ modles: { fast: "a/fast" } })
    await expect(loadEsConfig(root, { env })).rejects.toThrow(new RegExp(`invalid config.*${project}.*modles|modles`))
  })

  test("global file: unknown keys are rejected too", async () => {
    await writeGlobal({ search_engine: "duckduckgo" })
    await expect(loadEsConfig(root, { env })).rejects.toThrow(/invalid config.*search_engine/)
  })

  test("control: known keys in both files still load", async () => {
    await writeGlobal({ research: { depth: 1 } })
    await writeProject({ research: { depth: 3 } })
    expect((await loadEsConfig(root, { env })).config.research).toEqual({ depth: 3 })
  })
})

describe("es config set stays human-only (#203)", () => {
  const shell = (agent: string | undefined, command: string) =>
    evaluateShell({ root, stateDir: path.join(root, "state") }, agent, command, { sandboxAvailable: true })

  test("invokesHumanOnly reads config set, however flagged; config show stays a read", () => {
    expect(invokesHumanOnly("es config set models.deep x/y")).toBe(true)
    expect(invokesHumanOnly("es --cwd . config set models.deep x/y")).toBe(true)
    expect(invokesHumanOnly("es config set models.deep x/y --global")).toBe(true)
    expect(invokesHumanOnly("es config show")).toBe(false)
    expect(invokesHumanOnly("es --cwd . config show")).toBe(false)
  })

  test("every agent shell is denied config set; config show is allowed", () => {
    for (const agent of ["build", "factory", "es-programmer", undefined])
      expect([agent, shell(agent, "es config set models.deep x/y").effect]).toEqual([agent, "deny"])
    const denied = shell("build", "es config set models.deep x/y")
    expect(denied.effect).toBe("deny")
    if (denied.effect === "deny") expect(denied.reason).toContain("human-only")
    expect(shell("build", "es config show").effect).toBe("allow")
  })
})
