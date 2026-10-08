// Factory continuation: when the factory's own session finishes a turn while
// work remains (not halted, not waiting on a human approval or the grill), we
// re-prompt it to continue. Progress-aware (core's progressPrint: stage
// machine, research artifacts, seat outcomes, audit head): three idle turns
// without progress pause the loop so a confused agent cannot spin on budget,
// and the pause is announced instead of silent. While one of its seats is
// still running the factory is not re-prompted: the host wakes it when the
// seat finishes (#60).
import { headline, pendingApprovals, progressPrint, readLiveness } from "@heretek-ai/es-core"
import type { Runtime } from "./runtime.ts"
import type { SeatTracker } from "./seats.ts"

const ACTIVE = new Set(["RESEARCH", "SPEC", "BUILD", "QA", "RELEASE"])
export const STALL_LIMIT = 3

export interface FactoryContinuation {
  (
    event: { type: string; data?: { sessionID?: string } },
    agentOf: (sessionID: string) => Promise<string | undefined>,
  ): Promise<void>
  /** The pause notice for the current run, if the loop paused and nothing has moved since. */
  paused(): string | undefined
}

export function createFactoryContinuation(
  ctx: { session: { prompt(input: any): Promise<unknown> } },
  runtime: Runtime,
  options: {
    readonly seats?: Pick<SeatTracker, "hasRunningChildren">
    readonly onPause?: (notice: string) => void
  } = {},
): FactoryContinuation {
  const stalls = new Map<string, { print: string; count: number }>()
  let notice: string | undefined

  const continuation = async (
    event: { type: string; data?: { sessionID?: string } },
    agentOf: (sessionID: string) => Promise<string | undefined>,
  ) => {
    const sessionID = event.data?.sessionID
    if (!sessionID) return
    // The human (or the host) set the factory going again: the pause is over,
    // and the restarted factory gets a fresh budget of idle turns.
    if (event.type === "session.execution.started" && notice && (await agentOf(sessionID)) === "factory") {
      notice = undefined
      stalls.delete(sessionID)
      return
    }
    if (event.type !== "session.execution.succeeded") return
    if ((await agentOf(sessionID)) !== "factory") return
    if (options.seats?.hasRunningChildren(sessionID)) return
    const state = await runtime.factory.read()
    if (!state || !ACTIVE.has(state.stage)) return
    if ((await pendingApprovals(runtime.root)).length) return
    const liveness = await readLiveness(runtime.root, state)
    const print = progressPrint(state, liveness)
    const previous = stalls.get(sessionID)
    const count = previous?.print === print ? previous.count + 1 : 0
    stalls.set(sessionID, { print, count })
    if (count >= STALL_LIMIT) {
      if (count === STALL_LIMIT) {
        const text = `Factory paused: ${STALL_LIMIT} turns in ${state.stage} without progress. Check es status, then run /factory to continue.`
        notice = text
        options.onPause?.(text)
      }
      return
    }
    notice = undefined
    await ctx.session.prompt({
      sessionID,
      text: `${await runtime.factory.summary(state)}\n${headline(state, liveness)}\nThe factory run is not finished. Continue from the current stage (no human is needed unless an approval is due).`,
    })
  }

  const paused = () => notice
  return Object.assign(continuation, { paused })
}
