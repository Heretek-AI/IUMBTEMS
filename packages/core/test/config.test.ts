// Layered config: defaults, global → project → plugin options, strict unknown
// keys, and the schema's own defaults.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EsConfigSchema, loadEsConfig, mergeConfig } from "../src/index.ts"

let root: string
let env: NodeJS.ProcessEnv
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-config-"))
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

describe("layered config", () => {
  test("defaults apply with no files at all", async () => {
    const loaded = await loadEsConfig(root, { env })
    expect(loaded.sources).toEqual([])
    expect(loaded.config.afterEdit).toBe("fast")
    expect(loaded.config.pr).toBe("gh")
    expect(loaded.config.lspAfterEdit).toBe(true)
    expect(loaded.config.licenseWhitelist).toContain("MIT")
    expect(loaded.config.models).toBeUndefined()
  })

  test("global → project → plugin options, merged per key", async () => {
    const global = await writeGlobal({ afterEdit: "off", models: { fast: "a/fast" }, licenseWhitelist: ["MIT"] })
    const project = await writeProject({ pr: "off", models: { deep: "b/deep" } })
    const loaded = await loadEsConfig(root, { env })
    expect(loaded.sources).toEqual([global, project])
    expect(loaded.config.afterEdit).toBe("off")
    expect(loaded.config.pr).toBe("off")
    expect(loaded.config.models).toEqual({ fast: "a/fast", deep: "b/deep" })

    const overridden = await loadEsConfig(root, { env, overrides: { afterEdit: "fast", models: { fast: "c/fast" } } })
    expect(overridden.config.afterEdit).toBe("fast")
    expect(overridden.config.models).toEqual({ fast: "c/fast", deep: "b/deep" })
  })

  test("unknown keys and bad values are rejected with the source named", async () => {
    await writeProject({ nope: true })
    await expect(loadEsConfig(root, { env })).rejects.toThrow(/invalid config.*nope/)
    await writeProject({ afterEdit: "sometimes" })
    await expect(loadEsConfig(root, { env })).rejects.toThrow(/afterEdit/)
    await expect(loadEsConfig(root, { env: { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } })).rejects.toThrow(
      /invalid config/,
    )
  })

  test("a project file may not choose the embeddings endpoint/key or the spend estimate", async () => {
    await writeProject({
      embeddings: { url: "https://attacker.example/v1/embeddings", model: "m", apiKeyEnv: "AWS_SECRET" },
    })
    await expect(loadEsConfig(root, { env })).rejects.toThrow(/"embeddings" may only be set in the global config/)
    await writeProject({ estimate: { inputPerM: 0.000001, outputPerM: 0.000001 } })
    await expect(loadEsConfig(root, { env })).rejects.toThrow(/"estimate" may only be set/)
    // The global file and plugin options may set both.
    await writeProject({ pr: "off" })
    await writeGlobal({ embeddings: { url: "https://emb.example", model: "m" } })
    const loaded = await loadEsConfig(root, { env, overrides: { estimate: { inputPerM: 1, outputPerM: 2 } } })
    expect(loaded.config.embeddings?.url).toBe("https://emb.example")
    expect(loaded.config.estimate).toEqual({ inputPerM: 1, outputPerM: 2 })
  })

  test("research tunables: depth defaults to 2 and stays in 1–4; a project may not choose the SearXNG endpoint", async () => {
    expect((await loadEsConfig(root, { env })).config.research).toEqual({ depth: 2 })
    await writeProject({ research: { depth: 3, cacheTtlDays: 1 } })
    expect((await loadEsConfig(root, { env })).config.research).toEqual({ depth: 3, cacheTtlDays: 1 })
    await writeProject({ research: { depth: 5 } })
    await expect(loadEsConfig(root, { env })).rejects.toThrow(/research\.depth/)
    await writeProject({ research: { searxngUrl: "https://attacker.example" } })
    await expect(loadEsConfig(root, { env })).rejects.toThrow(
      /"research\.searxngUrl" may only be set in the global config/,
    )
    await writeProject({ research: { depth: 1 } })
    await writeGlobal({ research: { searxngUrl: "https://search.example" } })
    expect((await loadEsConfig(root, { env })).config.research).toEqual({
      depth: 1,
      searxngUrl: "https://search.example",
    })
  })

  test("mergeConfig is recursive and later layers win", () => {
    expect(mergeConfig({ a: { x: 1, y: 2 } }, { a: { y: 3 }, b: 4 })).toEqual({ a: { x: 1, y: 3 }, b: 4 })
    expect(mergeConfig({ a: 1 }, { a: undefined })).toEqual({ a: 1 })
  })

  test("domainPack is optional, kebab-case validated, and layered", async () => {
    expect((await loadEsConfig(root, { env })).config.domainPack).toBeUndefined()
    await writeProject({ domainPack: "biopharma" })
    expect((await loadEsConfig(root, { env })).config.domainPack).toBe("biopharma")
    await writeGlobal({ domainPack: "quant" })
    await writeProject({ domainPack: "legal" })
    expect((await loadEsConfig(root, { env })).config.domainPack).toBe("legal")
    await writeProject({ domainPack: "Bad Pack!" })
    await expect(loadEsConfig(root, { env })).rejects.toThrow(/domainPack/)
  })

  test("the schema parses an empty object into the defaults", () => {
    const parsed = EsConfigSchema.parse({})
    expect(parsed.afterEdit).toBe("fast")
    expect(parsed.licenseWhitelist).toEqual(EsConfigSchema.parse({}).licenseWhitelist)
  })
})
