// Layered config loading: the user-global file, then the project file
// (.factory/config.json), then plugin options — each layer overrides the
// previous. Unknown keys are rejected (typos surface immediately) and the
// result is validated by the canonical schema.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { appendAuditEntry } from "./audit/chain.ts"
import { factoryLayout } from "./layout.ts"
import { type EsConfig, EsConfigSchema } from "./schema/config.ts"
import { rebaseline, verifyControl } from "./trust/control.ts"
import { readJson, withLock, writeJson } from "./util/fs.ts"
import { sha256 } from "./util/hash.ts"

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

/**
 * Keys a project file may not set (dotted paths): where brainstorm text and an
 * API key are sent (embeddings), where research queries are sent
 * (research.searxngUrl), and the spend estimate behind the ceiling (estimate).
 * A cloned repository must not be able to choose any of them.
 */
export const PROJECT_FORBIDDEN_KEYS = ["embeddings", "estimate", "research.searxngUrl"] as const

const hasPath = (layer: Record<string, unknown>, dotted: string): boolean => {
  let node: unknown = layer
  for (const segment of dotted.split(".")) {
    if (!isPlainObject(node) || !(segment in node)) return false
    node = node[segment]
  }
  return true
}

/** Whether a dotted config key may only be set globally (or is inside such a key). */
export const projectForbidden = (key: string) =>
  PROJECT_FORBIDDEN_KEYS.find((forbidden) => key === forbidden || key.startsWith(`${forbidden}.`))

export async function loadEsConfig(
  root: string,
  options: { env?: NodeJS.ProcessEnv; overrides?: Record<string, unknown> } = {},
): Promise<LoadedConfig> {
  const env = options.env ?? process.env
  const globalFile = globalConfigFile(env)
  const projectFile = factoryLayout(root).config
  const [globalLayer, projectLayer] = await Promise.all([readLayer(globalFile), readLayer(projectFile)])
  const forbidden = PROJECT_FORBIDDEN_KEYS.filter((key) => projectLayer && hasPath(projectLayer, key))
  if (forbidden.length)
    throw new Error(
      `invalid config (${projectFile}): ${forbidden.map((key) => `"${key}"`).join(", ")} may only be set in the global config (${globalFile}) or plugin options — a project file must not choose where data, queries and API keys are sent, or the spend estimate behind the ceiling`,
    )
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

// ------------------------------------------------------------------ es config set

/** A config change was refused; the message is human-facing. */
export class ConfigError extends Error {}

export type ConfigLayer = "project" | "global"

export interface ConfigSetPlan {
  readonly key: string
  readonly layer: ConfigLayer
  readonly file: string
  readonly before: unknown
  /** undefined means the key is removed (value "null"). */
  readonly after: unknown
  readonly unchanged: boolean
  /** sha256 of the layer file when planned (null when absent): apply refuses if it changed. */
  readonly layerHash: string | null
  readonly next: Record<string, unknown>
  /** Project layer: a hand edit to .factory/config.json that this change accepts along with it. */
  readonly drift: readonly string[]
}

const KEY = /^[A-Za-z][\w]*(\.[\w-]+)*$/

const getPath = (layer: Record<string, unknown>, segments: readonly string[]): unknown => {
  let node: unknown = layer
  for (const segment of segments) {
    if (!isPlainObject(node)) return undefined
    node = node[segment]
  }
  return node
}

function setPath(layer: Record<string, unknown>, segments: readonly string[], value: unknown) {
  const out = structuredClone(layer)
  let node = out
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(node[segment])) node[segment] = {}
    node = node[segment] as Record<string, unknown>
  }
  const last = segments.at(-1)!
  if (value === undefined) delete node[last]
  else node[last] = value
  return out
}

async function fileHash(file: string): Promise<string | null> {
  return readFile(file).then(
    (bytes) => sha256(bytes),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    },
  )
}

/** Drift in pinned control files other than the project config (which this change may accept). */
async function controlDrift(root: string): Promise<{ config: string[]; other: string[] }> {
  const check = await verifyControl(root)
  const config = check.violations.filter((item) => item.startsWith(".factory/config.json "))
  return { config, other: check.violations.filter((item) => !config.includes(item)) }
}

/**
 * Validate `key = value` against the canonical schema and the layering rules,
 * without writing. Values parse as JSON when they can (`2`, `true`,
 * `["MIT"]`), else as strings; `null` removes the key.
 */
export async function planConfigSet(
  root: string,
  input: { key: string; value: string; layer: ConfigLayer; env?: NodeJS.ProcessEnv },
): Promise<ConfigSetPlan> {
  const env = input.env ?? process.env
  if (!KEY.test(input.key)) throw new ConfigError(`"${input.key}" is not a config key (expected a.b.c)`)
  const forbidden = projectForbidden(input.key)
  if (input.layer === "project" && forbidden)
    throw new ConfigError(
      `"${forbidden}" may only be set in the global config: es config set ${input.key} <value> --global`,
    )
  let value: unknown
  try {
    value = JSON.parse(input.value)
  } catch {
    value = input.value
  }
  const after = value === null ? undefined : value
  const globalFile = globalConfigFile(env)
  const projectFile = factoryLayout(root).config
  const file = input.layer === "global" ? globalFile : projectFile
  const [globalLayer, projectLayer] = await Promise.all([readLayer(globalFile), readLayer(projectFile)])
  const current = (input.layer === "global" ? globalLayer : projectLayer) ?? {}
  const segments = input.key.split(".")
  const next = setPath(current, segments, after)
  const merged = input.layer === "global" ? mergeConfig(next, projectLayer ?? {}) : mergeConfig(globalLayer ?? {}, next)
  const parsed = EsConfigSchema.safeParse(merged)
  if (!parsed.success)
    throw new ConfigError(
      `${input.key}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`,
    )
  const drift = input.layer === "project" ? await controlDrift(root) : { config: [], other: [] }
  if (drift.other.length)
    throw new ConfigError(
      `Other control files changed outside a human action (${drift.other.join("; ")}). Review them and run \`es rebaseline\` first; config set will not accept them for you.`,
    )
  const before = getPath(current, segments)
  return {
    key: input.key,
    layer: input.layer,
    file,
    before,
    after,
    unchanged: JSON.stringify(before) === JSON.stringify(after),
    layerHash: await fileHash(file),
    next,
    drift: drift.config,
  }
}

/** Human-only (es config set, after the TTY confirm): write the planned layer, re-pin the project config, audit. */
export async function applyConfigSet(root: string, plan: ConfigSetPlan, options: { actor: string }): Promise<void> {
  await withLock(plan.file, async () => {
    if ((await fileHash(plan.file)) !== plan.layerHash)
      throw new ConfigError(`${plan.file} changed since it was read; run the command again.`)
    if (plan.layer === "project") {
      const drift = await controlDrift(root)
      if (drift.other.length)
        throw new ConfigError(`Other control files changed meanwhile (${drift.other.join("; ")}); nothing was written.`)
    }
    await writeJson(plan.file, plan.next)
  })
  if (plan.layer !== "project") return
  await rebaseline(root, `${options.actor} (es config set ${plan.key})`)
  await appendAuditEntry(root, { actor: options.actor, action: "config.set", payload: { key: plan.key } })
}
