// Factory presets (#137): named starting points for runs. The first preset
// is `self-dogfood`, where the factory builds this repository — one issue in
// an isolated worktree under the real merge gate, released as a draft PR a
// human reviews. `initFromPreset` is human-only at the CLI (it writes factory
// control files no agent may touch); the preset files themselves are read-only
// assets validated against their schemas here.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { appendAuditEntry } from "../audit/chain.ts"
import { PROJECT_FORBIDDEN_KEYS } from "../config.ts"
import { factoryLayout } from "../layout.ts"
import { EsConfigSchema } from "../schema/config.ts"
import { GatesConfigSchema } from "../schema/gates.ts"
import { RoadmapSchema } from "../schema/roadmap.ts"
import { rebaseline } from "../trust/control.ts"
import { atomicWrite, readJson, withLock, writeJson } from "../util/fs.ts"

const PRESETS = fileURLToPath(new URL("../../assets/presets/", import.meta.url))

/** The only preset so far: the factory builds this repo. */
export const SELF_DOGFOOD_PRESET = "self-dogfood" as const
/** Self-dogfood release PRs target `rewrite`, never `main`. */
export const SELF_DOGFOOD_BASE_BRANCH = "rewrite" as const
/** Default spend ceiling (USD) the runbook sets on the grill frontier. */
export const SELF_DOGFOOD_SPEND_CEILING_USD = 15 as const

export const KNOWN_PRESETS = [SELF_DOGFOOD_PRESET] as const
export type PresetName = (typeof KNOWN_PRESETS)[number]

export const presetsDir = () => PRESETS

export interface PresetFiles {
  readonly config: string
  readonly gates: string
}

/** Read and schema-validate a preset's control files (throws on unknown presets or invalid files). */
export async function readPreset(name: string): Promise<PresetFiles> {
  if (!(KNOWN_PRESETS as readonly string[]).includes(name)) throw new Error(`unknown preset "${name}"`)
  const dir = path.join(PRESETS, name)
  const [config, gates] = await Promise.all([
    readFile(path.join(dir, "config.json"), "utf8").catch(() => {
      throw new Error(`preset "${name}" is missing config.json`)
    }),
    readFile(path.join(dir, "gates.json"), "utf8").catch(() => {
      throw new Error(`preset "${name}" is missing gates.json`)
    }),
  ])
  const configParsed = EsConfigSchema.safeParse(JSON.parse(config))
  if (!configParsed.success)
    throw new Error(`preset "${name}" config.json is invalid: ${configParsed.error.issues[0]?.message}`)
  const forbidden = PROJECT_FORBIDDEN_KEYS.filter(
    (key: string) => JSON.parse(config) && hasPath(JSON.parse(config), key),
  )
  if (forbidden.length)
    throw new Error(`preset "${name}" config.json sets project-forbidden keys: ${forbidden.join(", ")}`)
  const gatesParsed = GatesConfigSchema.safeParse(JSON.parse(gates))
  if (!gatesParsed.success)
    throw new Error(`preset "${name}" gates.json is invalid: ${gatesParsed.error.issues[0]?.message}`)
  return { config, gates }
}

const hasPath = (layer: Record<string, unknown>, dotted: string): boolean => {
  let node: unknown = layer
  for (const segment of dotted.split(".")) {
    if (typeof node !== "object" || node === null || !(segment in node)) return false
    node = (node as Record<string, unknown>)[segment]
  }
  return true
}

export interface PresetIdea {
  /** GitHub issue number the run builds. */
  readonly issue: number
  readonly title: string
  readonly body: string
}

/**
 * Seed `.factory/` from a preset for a human-driven run: control files, a
 * roadmap seed pinning the release base branch, and the issue as the idea
 * note. The grill still owns the roadmap and frontier from here — it must
 * keep `baseBranch` when it rewrites the roadmap.
 *
 * Every write is atomic and lock-protected (`withLock` + `writeJson` /
 * `atomicWrite`), as the `.factory/` runtime invariant requires. Afterwards
 * the control baseline is re-recorded and the seeding is audit-logged, so a
 * project with a prior baseline reports no drift. `actor` is the human
 * caller (the CLI threads `human:<user>` through).
 */
export async function initFromPreset(
  root: string,
  preset: string,
  idea: PresetIdea,
  options: { actor?: string } = {},
): Promise<{ written: string[]; baseBranch: string }> {
  const actor = options.actor ?? "human:unknown"
  const files = await readPreset(preset)
  const roadmap = RoadmapSchema.parse({
    version: 1,
    title: `Self-dogfood #${idea.issue}: ${idea.title}`,
    baseBranch: SELF_DOGFOOD_BASE_BRANCH,
    phases: [{ id: "dogfood", title: `Build issue #${idea.issue}` }],
  })
  const layout = factoryLayout(root)
  const noteRel = `.factory/notes/idea-${idea.issue}.md`
  const noteFile = path.join(root, noteRel)
  await Promise.all([
    withLock(layout.config, () => writeJson(layout.config, JSON.parse(files.config))),
    withLock(layout.gates, () => writeJson(layout.gates, JSON.parse(files.gates))),
    withLock(layout.roadmap, () => writeJson(layout.roadmap, roadmap)),
    withLock(noteFile, () => atomicWrite(noteFile, `# #${idea.issue}: ${idea.title}\n\n${idea.body.trim()}\n`)),
    writePresetSeed(root, { preset, issue: idea.issue, baseBranch: SELF_DOGFOOD_BASE_BRANCH }),
  ])
  await rebaseline(root, `${actor} (es factory init --preset ${preset})`)
  await appendAuditEntry(root, { actor, action: "factory.preset", payload: { preset, issue: idea.issue } })
  return {
    written: [".factory/config.json", ".factory/gates.json", ".factory/roadmap.json", noteRel],
    baseBranch: SELF_DOGFOOD_BASE_BRANCH,
  }
}

/** Which preset seeded a run: written at init, consumed into sealed run state at begin. */
export interface PresetSeed {
  readonly preset: string
  readonly issue: number
  readonly baseBranch: string
}

const seedFile = (root: string) => path.join(factoryLayout(root).runtime, "preset.json")

/** Record the seeding preset (atomic, lock-protected; runtime state is agent deny-write). */
export const writePresetSeed = (root: string, seed: PresetSeed): Promise<void> =>
  withLock(seedFile(root), () => writeJson(seedFile(root), seed))

/** The seeding preset, if this project was started with `es factory init --preset`. */
export const readPresetSeed = (root: string): Promise<PresetSeed | undefined> => readJson<PresetSeed>(seedFile(root))

/**
 * The single argv builder every PR opener uses for `gh pr create --draft`.
 * For a preset-seeded run the base is pinned: `--base main` (or anything
 * other than the preset's base) is refused here, before anything is pushed.
 */
export function buildPrArgs(options: {
  branch: string
  base: string
  title: string
  body: string
  preset?: string
}): string[] {
  if (options.preset === SELF_DOGFOOD_PRESET && options.base !== SELF_DOGFOOD_BASE_BRANCH)
    throw new Error(
      `refusing --base "${options.base}" for a preset "${SELF_DOGFOOD_PRESET}" run (release PRs target "${SELF_DOGFOOD_BASE_BRANCH}", never "main")`,
    )
  return [
    "gh",
    "pr",
    "create",
    "--draft",
    "--head",
    options.branch,
    "--base",
    options.base,
    "--title",
    options.title,
    "--body",
    options.body,
  ]
}
