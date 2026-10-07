// Cross-asset drift: the agent registry (code) and the shipped prompt and
// skill assets (files) must agree in both directions. `docs:check` runs
// `findAssetDrift` on the repo, so an orphaned prompt, a renamed seat, a
// missing skill or an unknown tool/spawn fails CI; the drift canary in
// test/drift.test.ts feeds it deliberately drifted corpora and expects each
// class to be caught. Schema/capability/config drift lives in scripts/docs.ts.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { parseFrontmatter } from "../util/yaml.ts"
import { AGENTS, ALL_ES_TOOLS } from "./registry.ts"

/** The registry fields the drift checks reason about (AgentSpec satisfies this). */
export interface DriftAgent {
  readonly id: string
  readonly prompt: string
  readonly seat: string
  readonly skills: readonly string[]
  readonly spawns: readonly string[]
  readonly tools: readonly string[]
}

export interface DriftCorpus {
  /** Prompt id (file name without .md) to its raw content. */
  readonly prompts: ReadonlyMap<string, string>
  /** Skill directory names (each is expected to hold a SKILL.md). */
  readonly skills: readonly string[]
  readonly agents: readonly DriftAgent[]
  /** The tool catalog seat tools are drawn from. */
  readonly tools: readonly string[]
}

/** Every way the corpus disagrees with itself, sorted for stable output. */
export function assetDrift(corpus: DriftCorpus): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const agent of corpus.agents) {
    if (ids.has(agent.id)) problems.push(`duplicate agent id: ${agent.id}`)
    ids.add(agent.id)
  }
  for (const agent of corpus.agents) {
    const content = corpus.prompts.get(agent.prompt)
    if (content === undefined) problems.push(`${agent.id}: missing prompt file ${agent.prompt}.md`)
    else {
      const data = parseFrontmatter(content).data as Record<string, unknown>
      if (String(data.id) !== agent.prompt)
        problems.push(`${agent.id}: prompt ${agent.prompt}.md declares id "${String(data.id)}"`)
      if (String(data.seat) !== agent.seat)
        problems.push(
          `${agent.id}: prompt ${agent.prompt}.md declares seat "${String(data.seat)}", registry says "${agent.seat}"`,
        )
    }
    for (const skill of agent.skills)
      if (!corpus.skills.includes(skill)) problems.push(`${agent.id}: missing skill ${skill}/`)
    for (const spawn of agent.spawns) if (!ids.has(spawn)) problems.push(`${agent.id}: spawns unknown agent ${spawn}`)
    for (const tool of agent.tools)
      if (tool.startsWith("es_") && !corpus.tools.includes(tool)) problems.push(`${agent.id}: unknown tool ${tool}`)
  }
  const referencedPrompts = new Set(corpus.agents.map((agent) => agent.prompt))
  for (const prompt of corpus.prompts.keys())
    if (!referencedPrompts.has(prompt)) problems.push(`orphan prompt file: ${prompt}.md`)
  const referencedSkills = new Set(corpus.agents.flatMap((agent) => [...agent.skills]))
  for (const skill of corpus.skills)
    if (!referencedSkills.has(skill)) problems.push(`orphan skill directory: ${skill}/`)
  return problems.sort()
}

export interface DriftPaths {
  readonly promptsDir: string
  readonly skillsDir: string
  /** Defaults to the shipped registry; tests inject their own. */
  readonly agents?: readonly DriftAgent[]
  /** Defaults to ALL_ES_TOOLS; tests inject their own. */
  readonly tools?: readonly string[]
}

/** Read a prompt/skill tree off disk and check it against the registry. */
export async function findAssetDrift(paths: DriftPaths): Promise<string[]> {
  const problems: string[] = []
  const prompts = new Map<string, string>()
  for (const file of (await readdir(paths.promptsDir)).sort()) {
    if (!file.endsWith(".md")) continue
    prompts.set(file.slice(0, -3), await readFile(path.join(paths.promptsDir, file), "utf8"))
  }
  const skills: string[] = []
  for (const entry of await readdir(paths.skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    skills.push(entry.name)
    const skillFile = await readFile(path.join(paths.skillsDir, entry.name, "SKILL.md"), "utf8").catch(() => undefined)
    if (skillFile === undefined) problems.push(`skill ${entry.name}: SKILL.md is missing`)
  }
  skills.sort()
  return [
    ...problems,
    ...assetDrift({
      prompts,
      skills,
      agents: paths.agents ?? AGENTS,
      tools: paths.tools ?? ALL_ES_TOOLS,
    }),
  ].sort()
}
