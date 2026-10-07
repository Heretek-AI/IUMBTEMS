// Layered config loading: the user-global file, then the project file
// (.factory/config.json), then plugin options — each layer overrides the
// previous. Unknown keys are rejected (typos surface immediately) and the
// result is validated by the canonical schema.
import { homedir } from "node:os"
import path from "node:path"
import { factoryLayout } from "./layout.ts"
import { type EsConfig, EsConfigSchema } from "./schema/config.ts"
import { readJson } from "./util/fs.ts"

export function globalConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(homedir(), ".config")
  return path.join(base, "epistemic-swarm", "config.json")
}

export interface LoadedConfig {
  readonly config: EsConfig
  /** Files that contributed values, in layer order. */
  readonly sources: readonly string[]
  readonly globalFile: string
  readonly projectFile: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Recursive override merge: later layers win; objects merge per key. */
export function mergeConfig(...layers: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue
      const existing = out[key]
      out[key] = isPlainObject(value) && isPlainObject(existing) ? mergeConfig(existing, value) : value
    }
  }
  return out
}

async function readLayer(file: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readJson<unknown>(file).catch((error: Error) => {
    throw new Error(`invalid config at ${file}: ${error.message}`)
  })
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) throw new Error(`invalid config at ${file}: expected a JSON object`)
  return raw
}

export async function loadEsConfig(
  root: string,
  options: { env?: NodeJS.ProcessEnv; overrides?: Record<string, unknown> } = {},
): Promise<LoadedConfig> {
  const env = options.env ?? process.env
  const globalFile = globalConfigFile(env)
  const projectFile = factoryLayout(root).config
  const [globalLayer, projectLayer] = await Promise.all([readLayer(globalFile), readLayer(projectFile)])
  const merged = mergeConfig(globalLayer ?? {}, projectLayer ?? {}, options.overrides ?? {})
  const parsed = EsConfigSchema.safeParse(merged)
  if (!parsed.success) {
    const where = [
      globalLayer ? globalFile : undefined,
      projectLayer ? projectFile : undefined,
      options.overrides && Object.keys(options.overrides).length ? "plugin options" : undefined,
    ].filter(Boolean)
    throw new Error(
      `invalid config (${where.join(", ")}): ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`,
    )
  }
  return {
    config: parsed.data,
    sources: [globalLayer ? globalFile : undefined, projectLayer ? projectFile : undefined].filter(
      (file): file is string => Boolean(file),
    ),
    globalFile,
    projectFile,
  }
}
