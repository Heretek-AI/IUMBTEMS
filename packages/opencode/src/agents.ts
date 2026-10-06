// Compile the canonical agent registry into OpenCode v2 agents. Additive only:
// we add our own agents and never edit built-ins, default_agent or models.
// Per-agent tool/skill/MCP scoping is expressed as wildcard-deny permission
// rules (proven in M0: denied tools, MCP tools and skills are not advertised).
import { AGENTS, type AgentSpec, ALL_ES_TOOLS, loadPrompt } from "@heretek-ai/es-core"
import type { PluginOptions } from "./runtime.ts"

export interface CompiledAgent {
  readonly spec: AgentSpec
  readonly system: string
  readonly permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
  readonly model?: { providerID: string; id: string }
}

export function permissionRules(spec: AgentSpec, mcpServers: readonly string[]): CompiledAgent["permissions"] {
  const rules: CompiledAgent["permissions"] = [
    { action: "es_*", resource: "*", effect: "deny" },
    ...spec.tools.map((tool) => ({ action: tool, resource: "*", effect: "allow" as const })),
    { action: "subagent", resource: "*", effect: "deny" },
    ...spec.spawns.map((agent) => ({ action: "subagent", resource: agent, effect: "allow" as const })),
    { action: "skill", resource: "*", effect: "deny" },
    ...spec.skills.map((skill) => ({ action: "skill", resource: skill, effect: "allow" as const })),
  ]
  for (const server of mcpServers)
    if (!spec.mcp.includes(server))
      rules.push({ action: `${server.replace(/[^\w-]/g, "_")}_*`, resource: "*", effect: "deny" })
  if (spec.mode === "subagent") {
    // Autonomous seats never wait on a human: no questions, no paths outside the project except /tmp.
    rules.push({ action: "question", resource: "*", effect: "deny" })
    rules.push({ action: "external_directory", resource: "*", effect: "deny" })
    rules.push({ action: "external_directory", resource: "/tmp/*", effect: "allow" })
  }
  if (spec.writes.length === 0) rules.push({ action: "edit", resource: "*", effect: "deny" })
  return rules
}

function modelFor(spec: AgentSpec, options: PluginOptions) {
  const ref = options.models?.[spec.tier]
  const slash = ref?.indexOf("/") ?? -1
  if (!ref || slash <= 0) return undefined
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
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
