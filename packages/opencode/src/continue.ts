// Factory continuation: when the factory's own session finishes a turn while
// work remains (not halted, not waiting on a human approval or the grill), we
// re-prompt it to continue. Progress-aware: three idle turns without any state
// change stop the loop so a confused agent cannot spin on budget.
import { pendingApprovals } from "@heretek-ai/es-core"
import type { Runtime } from "./runtime.ts"

const ACTIVE = new Set(["RESEARCH", "SPEC", "BUILD", "QA", "RELEASE"])
const STALL_LIMIT = 3

export function createFactoryContinuation(
  ctx: { session: { prompt(input: any): Promise<unknown> } },
  runtime: Runtime,
) {
  const stalls = new Map<string, { print: string; count: number }>()
  return async (
    event: { type: string; data?: { sessionID?: string } },
    agentOf: (sessionID: string) => Promise<string | undefined>,
  ) => {
    const sessionID = event.data?.sessionID
    if (event.type !== "session.execution.succeeded" || !sessionID) return
    if ((await agentOf(sessionID)) !== "factory") return
    const state = await runtime.factory.read()
    if (!state || !ACTIVE.has(state.stage)) return
    if ((await pendingApprovals(runtime.root)).length) return
    const print = JSON.stringify([
      state.stage,
      state.activePhase,
      state.phases.map((phase) => [phase.status, phase.failures, phase.history.length]),
    ])
    const previous = stalls.get(sessionID)
    const count = previous?.print === print ? previous.count + 1 : 0
    stalls.set(sessionID, { print, count })
    if (count >= STALL_LIMIT) return
    await ctx.session.prompt({
      sessionID,
      text: `${await runtime.factory.summary(state)}\nThe factory run is not finished. Continue from the current stage (no human is needed unless an approval is due).`,
    })
  }
}
