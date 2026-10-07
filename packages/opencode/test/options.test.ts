// Plugin options go through the strict config schema: every config key works
// from opencode.json, and unknown keys (such as 0.7-era options) are ignored
// with one visible warning instead of vanishing silently.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { EsRpc } from "../src/rpc-def.ts"
import { parseOptions } from "../src/runtime.ts"

const pluginDir = path.resolve(import.meta.dir, "..")

describe("parseOptions", () => {
  test("keeps every config key, separates stateDir, and reports unknown keys", () => {
    const parsed = parseOptions({
      stateDir: "/tmp/state",
      pr: "off",
      domainPack: "quant",
      licenseWhitelist: ["MIT"],
      research: { depth: 3 },
      embeddings: { url: "http://localhost:1/v1/embeddings", model: "e" },
      search_engine: "duckduckgo",
      max_iterations: 2,
      mode: "research",
    })
    expect(parsed.stateDir).toBe("/tmp/state")
    expect(parsed.overrides).toEqual({
      pr: "off",
      domainPack: "quant",
      licenseWhitelist: ["MIT"],
      research: { depth: 3 },
      embeddings: { url: "http://localhost:1/v1/embeddings", model: "e" },
    })
    expect(parsed.unknown).toEqual(["max_iterations", "mode", "search_engine"])
  })

  test("no options is an empty, warning-free parse", () => {
    expect(parseOptions(undefined)).toEqual({ overrides: {}, unknown: [] })
  })
})

describe("plugin options on the real host", () => {
  let h: Harness
  let state: string
  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-options-state-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [
        {
          path: pluginDir,
          options: { stateDir: state, pr: "off", domainPack: "quant", search_engine: "duckduckgo", max_iterations: 2 },
        },
      ],
      files: { "README.md": "# demo\n" },
    })
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("a config key set as a plugin option takes effect; unknown keys come back as one warning", async () => {
    const rpc = (h.opencode as any).rpc(EsRpc)
    const view = await rpc.configState({}, { location: h.location })
    expect(JSON.parse(view.config).domainPack).toBe("quant")
    expect(view.warnings).toHaveLength(1)
    expect(view.warnings[0]).toContain("max_iterations, search_engine")
    expect(view.warnings[0]).toContain("docs/CONFIG.md")
  })
})
