// Read-only config preview (#132, preview-only mode): the browser edits
// project config and gates against strict-schema validation with exact
// hash diffs, but applying stays terminal-only (ADR 0002 I7) — nothing in
// this module writes. `get` reads the current layers, hashes and drift;
// `plan` validates proposed file content with the same schemas the terminal
// path uses and previews the new hash, changed keys and the exact `es`
// commands the human runs. There is deliberately no apply: the bus must
// keep refusing `fleet.config.apply` with "unknown method".
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  EsConfigSchema,
  factoryLayout,
  GatesConfigSchema,
  globalConfigFile,
  mergeConfig,
  PROJECT_FORBIDDEN_KEYS,
  verifyControl,
} from "@heretek-ai/es-core"

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex")
/** Canonical bytes `writeJson` would emit: the previewed hash is exact. */
const canon = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

export interface ConfigDrift {
  readonly clean: boolean
  readonly violations: readonly string[]
  readonly hasBaseline: boolean
}

export interface ConfigView {
  readonly config: Record<string, unknown> | null
  readonly configHash: string | null
  readonly gates: Record<string, unknown> | null
  readonly gatesHash: string | null
  readonly drift: ConfigDrift
  readonly forbidden: readonly string[]
}

const readBytes = (file: string): Promise<Buffer | null> =>
  readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === "ENOENT") return null
    throw error
  })

const asObject = (bytes: Buffer, file: string): Record<string, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error(`${file} is not valid JSON; fix it by hand before previewing.`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} must hold a JSON object.`)
  return parsed as Record<string, unknown>
}

const readLayerFile = async (
  file: string,
): Promise<{ content: Record<string, unknown> | null; hash: string | null }> => {
  const bytes = await readBytes(file)
  if (!bytes) return { content: null, hash: null }
  return { content: asObject(bytes, file), hash: sha256(bytes) }
}

/** Read the project config and gates layers, their hashes and drift. Reads only. */
export async function readConfigView(repoRoot: string): Promise<ConfigView> {
  const layout = factoryLayout(repoRoot)
  const [config, gates, drift] = await Promise.all([
    readLayerFile(layout.config),
    readLayerFile(layout.gates),
    verifyControl(repoRoot),
  ])
  return {
    config: config.content,
    configHash: config.hash,
    gates: gates.content,
    gatesHash: gates.hash,
    drift: { clean: drift.clean, violations: [...drift.violations], hasBaseline: drift.hasBaseline },
    forbidden: [...PROJECT_FORBIDDEN_KEYS],
  }
}

export interface ConfigPlanInput {
  readonly file: "config" | "gates"
  readonly content: unknown
}

export interface ConfigPlan {
  readonly ok: boolean
  readonly errors: readonly string[]
  /** Hash of the current file bytes (null when the file is absent). */
  readonly oldHash: string | null
  /** Exact hash the file would have after applying (null when invalid). */
  readonly newHash: string | null
  readonly changedKeys: readonly string[]
  /** Exact terminal commands that apply the preview (empty unless ok and changed). */
  readonly commands: readonly string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const changedKeysOf = (before: Record<string, unknown>, after: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

const forbiddenHit = (key: string): string | undefined =>
  PROJECT_FORBIDDEN_KEYS.find((forbidden) => key === forbidden || key.startsWith(`${forbidden}.`))

/**
 * Validate proposed file content and preview the change. Pure: reads the
 * current layers for the diff, writes nothing.
 */
export async function planConfigFile(
  repoRoot: string,
  input: ConfigPlanInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigPlan> {
  const layout = factoryLayout(repoRoot)
  const fail = (errors: readonly string[], oldHash: string | null): ConfigPlan => ({
    ok: false,
    errors,
    oldHash,
    newHash: null,
    changedKeys: [],
    commands: [],
  })
  if (!isObject(input.content)) return fail(["content must be a JSON object"], null)
  const proposed = input.content
  if (input.file === "gates") {
    const [currentFile, oldBytes] = await Promise.all([readLayerFile(layout.gates), readBytes(layout.gates)])
    const current = currentFile.content ?? {}
    const oldHash = oldBytes ? sha256(oldBytes) : null
    const parsed = GatesConfigSchema.safeParse(proposed)
    if (!parsed.success)
      return fail(
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
        oldHash,
      )
    const changed = changedKeysOf(current, proposed)
    return {
      ok: true,
      errors: [],
      oldHash: oldBytes ? sha256(oldBytes) : null,
      newHash: sha256(canon(proposed)),
      changedKeys: changed,
      commands: changed.length ? ["# save the previewed JSON to .factory/gates.json", "es rebaseline"] : [],
    }
  }
  const [project, globalRaw] = await Promise.all([readLayerFile(layout.config), readBytes(globalConfigFile(env))])
  const current = project.content ?? {}
  let globalLayer: Record<string, unknown> = {}
  if (globalRaw) {
    try {
      const parsed: unknown = JSON.parse(globalRaw.toString("utf8"))
      if (isObject(parsed)) globalLayer = parsed
    } catch {
      // An unreadable global layer fails validation below via the merge.
    }
  }
  const changed = changedKeysOf(current, proposed)
  const errors = changed
    .map((key) => forbiddenHit(key))
    .filter((hit) => hit !== undefined)
    .map((hit) => `"${hit}" may only be set in the global config, not the project file`)
  const merged = mergeConfig(globalLayer, proposed)
  const parsed = EsConfigSchema.safeParse(merged)
  if (!parsed.success)
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join(".") || "<root>"}: ${issue.message}`)
  if (errors.length) return fail(errors, project.hash)
  return {
    ok: true,
    errors: [],
    oldHash: project.hash,
    newHash: sha256(canon(proposed)),
    changedKeys: changed,
    commands: changed.map((key) => `es config set ${key} ${JSON.stringify(proposed[key])}`),
  }
}
