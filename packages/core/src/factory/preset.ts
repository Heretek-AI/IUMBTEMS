// Factory presets (#137): named starting points for runs. The first preset
// is `self-dogfood`, where the factory builds this repository — one issue in
// an isolated worktree under the real merge gate, released as a draft PR a
// human reviews. `initFromPreset` is human-only at the CLI (it writes factory
// control files no agent may touch); the preset files themselves are read-only
// assets validated against their schemas here.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PROJECT_FORBIDDEN_KEYS } from "../config.ts"
import { EsConfigSchema } from "../schema/config.ts"
import { GatesConfigSchema } from "../schema/gates.ts"
import { RoadmapSchema } from "../schema/roadmap.ts"

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
 */
export async function initFromPreset(
  root: string,
  preset: string,
  idea: PresetIdea,
): Promise<{ written: string[]; baseBranch: string }> {
  const files = await readPreset(preset)
  const roadmap = RoadmapSchema.parse({
    version: 1,
    title: `Self-dogfood #${idea.issue}: ${idea.title}`,
    baseBranch: SELF_DOGFOOD_BASE_BRANCH,
    phases: [{ id: "dogfood", title: `Build issue #${idea.issue}` }],
  })
  const written: Array<{ rel: string; content: string }> = [
    { rel: ".factory/config.json", content: `${JSON.stringify(JSON.parse(files.config), null, 2)}\n` },
    { rel: ".factory/gates.json", content: `${JSON.stringify(JSON.parse(files.gates), null, 2)}\n` },
    { rel: ".factory/roadmap.json", content: `${JSON.stringify(roadmap, null, 2)}\n` },
    {
      rel: `.factory/notes/idea-${idea.issue}.md`,
      content: `# #${idea.issue}: ${idea.title}\n\n${idea.body.trim()}\n`,
    },
  ]
  await Promise.all(
    written.map(async (file) => {
      await mkdir(path.dirname(path.join(root, file.rel)), { recursive: true })
      await writeFile(path.join(root, file.rel), file.content)
    }),
  )
  return { written: written.map((file) => file.rel), baseBranch: SELF_DOGFOOD_BASE_BRANCH }
}

/** The exact `gh` argv a self-dogfood release drafts with (base pinned, never `main`). */
export function selfDogfoodPrArgs(options: { branch: string; title: string; body: string }): string[] {
  return [
    "gh",
    "pr",
    "create",
    "--draft",
    "--head",
    options.branch,
    "--base",
    SELF_DOGFOOD_BASE_BRANCH,
    "--title",
    options.title,
    "--body",
    options.body,
  ]
}
