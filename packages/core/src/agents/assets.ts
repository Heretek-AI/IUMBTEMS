// Versioned prompt and skill assets shipped with es-core. Prompts carry typed
// frontmatter (id, version, seat) checked against the agent registry; skills
// are one shared SKILL.md tree every harness adapter registers.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { parseFrontmatter } from "../util/yaml.ts"

const ASSETS = fileURLToPath(new URL("../../assets/", import.meta.url))

export const PromptFrontmatterSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  seat: z.string(),
  description: z.string().min(1),
})
export type PromptFrontmatter = z.infer<typeof PromptFrontmatterSchema>

export interface PromptAsset {
  readonly meta: PromptFrontmatter
  readonly body: string
}

export async function loadPrompt(id: string): Promise<PromptAsset> {
  const { data, body } = parseFrontmatter(await readFile(path.join(ASSETS, "prompts", `${id}.md`), "utf8"))
  const meta = PromptFrontmatterSchema.parse(data)
  if (meta.id !== id) throw new Error(`prompt ${id}.md declares id "${meta.id}"`)
  return { meta, body: body.trim() }
}

export const SkillFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(20),
})

export interface SkillAsset {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string
  readonly content: string
}

export async function loadSkills(): Promise<SkillAsset[]> {
  const dir = path.join(ASSETS, "skills")
  const out: SkillAsset[] = []
  for (const id of (await readdir(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const file = path.join(dir, id, "SKILL.md")
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const { data, body } = parseFrontmatter(text)
    const meta = SkillFrontmatterSchema.parse(data)
    if (meta.name !== id) throw new Error(`skill ${id} declares name "${meta.name}"`)
    out.push({ id, name: meta.name, description: meta.description, path: file, content: body.trim() })
  }
  return out
}

export const assetsDir = () => ASSETS
