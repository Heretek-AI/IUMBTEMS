import type { FactoryState } from "./state.ts"

/** Compact factory-state block for system-context injection and compaction. */
export function factorySummary(state: FactoryState | undefined): string {
  if (!state) return "<factory-state>No factory run in this project. Start one with /grill.</factory-state>"
  const lines = [`run ${state.runId} · stage ${state.stage}`]
  if (state.spendCeilingUSD !== undefined)
    lines.push(
      `spend $${state.spend.usd.toFixed(2)}${state.spend.estimated ? " (est.)" : ""} / ceiling $${state.spendCeilingUSD}`,
    )
  if (state.halt) lines.push(`HALTED: ${state.halt.reason} (a human must resume)`)
  for (const phase of state.phases) {
    const marker =
      phase.id === state.activePhase ? "▶" : phase.status === "passed" ? "✓" : phase.status === "failed" ? "✗" : "·"
    const qa =
      phase.qa.functional || phase.qa.adversarial
        ? ` qa[f:${phase.qa.functional?.verdict ?? "-"} a:${phase.qa.adversarial?.verdict ?? "-"}${phase.qa.tiebreak ? ` t:${phase.qa.tiebreak.verdict}` : ""}]`
        : ""
    lines.push(
      `${marker} ${phase.id} ${phase.status}${phase.failures ? ` failures:${phase.failures}` : ""}${phase.replanned ? " replanned" : ""}${qa}${phase.id === state.activePhase && phase.worktree ? ` worktree:${phase.worktree}` : ""}`,
    )
  }
  if (state.release?.prUrl) lines.push(`PR: ${state.release.prUrl}`)
  return `<factory-state>\n${lines.join("\n")}\n</factory-state>`
}
