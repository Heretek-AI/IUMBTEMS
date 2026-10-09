// Compile the canonical agent registry into OpenCode v2 agents. Additive only:
// we add our own agents and never edit built-ins, default_agent or models.
// Per-agent tool/skill/MCP scoping is expressed as wildcard-deny permission
// rules (proven in M0: denied tools, MCP tools and skills are not advertised).
import { AGENTS, type AgentSpec, ALL_ES_TOOLS, loadPrompt, parseModelRef } from "@heretek-ai/es-core"
import type { PluginOptions } from "./runtime.ts"

export interface CompiledAgent {
  readonly spec: AgentSpec
  readonly system: string
  readonly permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
  readonly model?: { providerID: string; id: string }
}

/** The host's own web tools, denied to seats whose web access is "cached". */
export const HOST_WEB_TOOLS = ["websearch", "webfetch"] as const

export function permissionRules(spec: AgentSpec, mcpServers: readonly string[]): CompiledAgent["permissions"] {
  const rules: CompiledAgent["permissions"] = [
    { action: "es_*", resource: "*", effect: "deny" },
    ...spec.tools.map((tool) => ({ action: tool, resource: "*", effect: "allow" as const })),
    { action: "subagent", resource: "*", effect: "deny" },
    ...spec.spawns.map((agent) => ({ action: "subagent", resource: agent, effect: "allow" as const })),
    { action: "skill", resource: "*", effect: "deny" },
    ...spec.skills.map((skill) => ({ action: "skill", resource: skill, effect: "allow" as const })),
    // Code Mode (`execute`) reaches host tools no seat needs, including MCP
    // resources outside the seat's MCP scope.
    { action: "execute", resource: "*", effect: "deny" },
  ]
  for (const server of mcpServers)
    if (!spec.mcp.includes(server))
      rules.push({ action: `${server.replace(/[^\w-]/g, "_")}_*`, resource: "*", effect: "deny" })
  if (spec.mode === "subagent") {
    // Autonomous seats never wait on a human: no questions, no paths outside the project except /tmp.
    rules.push({ action: "question", resource: "*", effect: "deny" })
    rules.push({ action: "external_directory", resource: "*", effect: "deny" })
    // Sonar S5443 flags the /tmp literal; it governs creating temp files, while
    // this only grants autonomous seats access to a scratch directory.
    rules.push({ action: "external_directory", resource: "/tmp/*", effect: "allow" }) // NOSONAR
  }
  if (spec.web === "cached")
    // Search as policy: web facts only through the cached, citable es_research_* tools.
    for (const action of HOST_WEB_TOOLS) rules.push({ action, resource: "*", effect: "deny" })
  if (spec.writes.length === 0) rules.push({ action: "edit", resource: "*", effect: "deny" })
  if (spec.lsp === "none") rules.push({ action: "lsp", resource: "*", effect: "deny" })
  if (spec.lsp !== "full") rules.push({ action: "lsp_rename", resource: "*", effect: "deny" })
  return rules
}

export function modelFor(spec: AgentSpec, options: PluginOptions) {
  const ref = options.models?.agents?.[spec.id] ?? options.models?.[spec.tier]
  if (!ref) return undefined
  return parseModelRef(ref)
}

/** A configured model ref the host does not have: the seat is refused at launch (#96). */
export interface ModelProblem {
  readonly agent: string
  /** The config key to fix: models.<tier> or models.agents.<id>. */
  readonly key: string
  readonly ref: string
  /** Remediation for the user (es config set is human-only). */
  readonly message: string
}

/** Remediation text for an unusable seat model (es config set is human-only). */
export function modelProblemMessage(agent: string, key: string, ref: string, wellFormed: boolean): string {
  return (
    `Seat "${agent}" cannot launch: its model "${ref}" (${key}) is ` +
    (wellFormed ? "not on this host." : 'malformed (want "provider/model").') +
    ` Set ${key} to "provider/model" from the host model list with \`es config set\`, or unset it to use the session default.`
  )
}

/** Every configured ref, per seat, that `exists` cannot find on the host. */
export function modelProblems(
  options: PluginOptions,
  specs: readonly AgentSpec[],
  exists: (providerID: string, modelID: string) => boolean,
): ModelProblem[] {
  const problems: ModelProblem[] = []
  for (const spec of specs) {
    const ref = options.models?.agents?.[spec.id] ?? options.models?.[spec.tier]
    if (ref === undefined) continue
    const key = options.models?.agents?.[spec.id] !== undefined ? `models.agents.${spec.id}` : `models.${spec.tier}`
    const parsed = parseModelRef(ref)
    if (parsed === undefined || !exists(parsed.providerID, parsed.id))
      problems.push({
        agent: spec.id,
        key,
        ref,
        message: modelProblemMessage(spec.id, key, ref, parsed !== undefined),
      })
  }
  return problems
}

/** es_status lines for the runtime's model problems (empty when healthy). */
export function modelProblemLines(problems: ReadonlyMap<string, ModelProblem>): string[] {
  if (problems.size === 0) return []
  return [
    `Model problems (${problems.size}): configured models missing on this host — those seats refuse to launch.`,
    ...[...problems.values()].map((problem) => `- ${problem.message}`),
  ]
}

export async function compileAgents(options: PluginOptions, mcpServers: readonly string[]): Promise<CompiledAgent[]> {
  return Promise.all(
    AGENTS.map(async (spec) => {
      const prompt = await loadPrompt(spec.prompt)
      const model = modelFor(spec, options)
      return {
        spec,
        system: `${prompt.body}\n\n<!-- epistemic-swarm prompt ${prompt.meta.id} v${prompt.meta.version} -->`,
        permissions: permissionRules(spec, mcpServers),
        ...(model ? { model } : {}),
      }
    }),
  )
}

/** es_* tools an agent may see. Agents outside the registry get only the read-only ones. */
export function visibleEsTools(agentId: string | undefined): readonly string[] {
  const spec = AGENTS.find((agent) => agent.id === agentId)
  return spec ? spec.tools : ["es_status", "es_gates_run"]
}

export { ALL_ES_TOOLS }
