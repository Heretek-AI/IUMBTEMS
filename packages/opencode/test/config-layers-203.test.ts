// Audit #203 — layered config on the real host: the project file and the
// plugin options set conflicting tiers, the effective model per tier resolves
// options > project, and the 0.7-era keys are ignored with exactly one
// combined warning. The strict side (config files reject unknowns) is proven
// in packages/core/test/config-layers-203.test.ts. `es config set` itself is
// never run here (human-only); the agent-shell denial goes through the
// plugin's own policy hook.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENTS } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { modelFor } from "../src/agents.ts"
import { createPolicyHooks } from "../src/policy.ts"
import { EsRpc } from "../src/rpc-def.ts"
import { parseOptions, type Runtime, unknownOptionsWarning } from "../src/runtime.ts"

const pluginDir = path.resolve(import.meta.dir, "..")

describe("plugin-option unknowns warn, once and combined (#203)", () => {
  test("0.7-era keys land in sorted unknown, never in overrides", () => {
    const parsed = parseOptions({
      stateDir: "/tmp/state",
      models: { fast: "o/fast" },
      search_engine: "duckduckgo",
      max_iterations: 2,
      mode: "research",
    })
    expect(parsed.overrides).toEqual({ models: { fast: "o/fast" } })
    expect(parsed.unknown).toEqual(["max_iterations", "mode", "search_engine"])
  })

  test("the warning is a single string naming every key and the config docs", () => {
    const warning = unknownOptionsWarning(["max_iterations", "mode", "search_engine"])
    expect(warning).toContain("max_iterations, mode, search_engine")
    expect(warning).toContain("docs/CONFIG.md")
    expect(warning).toContain("search_engine, max_iterations and mode were removed in 1.0")
  })

  test("no unknown keys means no warning", () => {
    expect(parseOptions({ stateDir: "/tmp/state", pr: "off" }).unknown).toEqual([])
  })
})

describe("layered tiers on the real host (#203)", () => {
  let h: Harness
  let state: string
  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-203-layers-state-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [
        {
          path: pluginDir,
          options: {
            stateDir: state,
            models: { fast: "options/fast", balanced: "options/balanced" },
            search_engine: "duckduckgo",
            max_iterations: 2,
            mode: "research",
          },
        },
      ],
      files: {
        "README.md": "# layered config\n",
        ".factory/config.json": JSON.stringify({ models: { fast: "project/fast", deep: "project/deep" } }),
      },
    })
  }, 120_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("plugin options win per tier; the project file fills the gaps", async () => {
    const rpc = (h.opencode as any).rpc(EsRpc)
    const view = await rpc.configState({}, { location: h.location })
    expect(view.sources).toEqual([path.join(h.directory, ".factory", "config.json")])
    expect(JSON.parse(view.config).models).toEqual({
      fast: "options/fast",
      balanced: "options/balanced",
      deep: "project/deep",
    })
  })

  test("the effective model per tier parses to provider/model", async () => {
    const rpc = (h.opencode as any).rpc(EsRpc)
    const config = JSON.parse((await rpc.configState({}, { location: h.location })).config)
    for (const [tier, ref] of [
      ["fast", "options/fast"],
      ["balanced", "options/balanced"],
      ["deep", "project/deep"],
    ] as const) {
      const spec = AGENTS.find((agent) => agent.tier === tier)!
      expect([tier, modelFor(spec, config)]).toEqual([tier, { providerID: ref.split("/")[0], id: ref.split("/")[1] }])
    }
  })

  test("the legacy keys warn exactly once, as one combined string", async () => {
    const rpc = (h.opencode as any).rpc(EsRpc)
    const view = await rpc.configState({}, { location: h.location })
    expect(view.warnings).toHaveLength(1)
    expect(view.warnings[0]).toContain("max_iterations, mode, search_engine")
    expect(view.warnings[0]).toContain("docs/CONFIG.md")
    expect(view.warnings[0]).toContain("0.7-era options")
  })
})

describe("agent shells cannot run es config set (#203)", () => {
  test("the plugin policy hook refuses it; config show passes the gate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-203-policy-"))
    const stateDir = await mkdtemp(path.join(tmpdir(), "es-203-policy-state-"))
    try {
      const hooks = createPolicyHooks({
        root,
        stateDir,
        modelProblems: new Map(),
        factory: { read: async () => undefined },
        policy: async () => ({ root, stateDir }),
      } as unknown as Runtime)
      await expect(
        hooks.before({ tool: "shell", agent: "build", id: "t1", input: { command: "es config set models.deep x/y" } }),
      ).rejects.toThrow("human-only")
      await expect(
        hooks.before({
          tool: "shell",
          agent: "es-programmer",
          id: "t2",
          input: { command: "es config set audit.phase required" },
        }),
      ).rejects.toThrow("human-only")
      await hooks.before({ tool: "shell", agent: "build", id: "t3", input: { command: "es config show" } })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
