// Session-level integration: factory-state injection for factory agents,
// per-agent es_* tool visibility (without touching built-in agents' config),
// compaction that preserves the factory state, and spend accounting from
// the host's per-step cost.
import { AGENTS, ALL_ES_TOOLS, factorySummary } from "@heretek-ai/es-core"
import { visibleEsTools } from "./agents.ts"
import type { Runtime } from "./runtime.ts"

const FACTORY_AGENTS = new Set(AGENTS.map((agent) => agent.id))

export function createSessionHooks(runtime: Runtime) {
  const context = async (event: { agent: string; system: any[]; tools: Record<string, unknown> }) => {
    const visible = new Set(visibleEsTools(event.agent))
    for (const name of ALL_ES_TOOLS) if (!visible.has(name)) delete event.tools[name]
    if (!FACTORY_AGENTS.has(event.agent)) return
    const state = await runtime.factory.read().catch(() => undefined)
    event.system.push({ type: "text", text: factorySummary(state) })
  }

  const compaction = async (event: { agent: string; system: any[] }) => {
    if (!FACTORY_AGENTS.has(event.agent)) return
    const state = await runtime.factory.read().catch(() => undefined)
    event.system.push({
      type: "text",
      text: `Preserve this factory state verbatim at the top of your summary; the run continues from it:\n${factorySummary(state)}`,
    })
  }

  return { context, compaction }
}

interface StepEnded {
  readonly type: string
  readonly data?: {
    sessionID?: string
    cost?: number
    tokens?: { input?: number; output?: number; reasoning?: number }
  }
}

/** Accumulate factory spend from session.step.ended events of factory-agent sessions. */
export function createSpendTracker(runtime: Runtime, lookupAgent: (sessionID: string) => Promise<string | undefined>) {
  const agents = new Map<string, string | undefined>()
  const inputPerM = runtime.options.estimate?.inputPerM ?? 3
  const outputPerM = runtime.options.estimate?.outputPerM ?? 15
  return async (event: StepEnded) => {
    if (event.type !== "session.step.ended" || !event.data?.sessionID) return
    const sessionID = event.data.sessionID
    if (!agents.has(sessionID)) agents.set(sessionID, await lookupAgent(sessionID).catch(() => undefined))
    if (!FACTORY_AGENTS.has(agents.get(sessionID) ?? "")) return
    const cost = Number(event.data.cost ?? 0)
    if (cost > 0) {
      await runtime.factory.recordSpend(cost, false)
      return
    }
    const tokens = event.data.tokens ?? {}
    const estimate =
      ((tokens.input ?? 0) * inputPerM + ((tokens.output ?? 0) + (tokens.reasoning ?? 0)) * outputPerM) / 1_000_000
    if (estimate > 0) await runtime.factory.recordSpend(estimate, true)
  }
}
