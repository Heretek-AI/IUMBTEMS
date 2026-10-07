import type { Frontier } from "../schema/frontier.ts"
import type { Audit, FactoryState } from "./state.ts"
import { treeLine } from "./tree.ts"

export interface SummaryExtras {
  /** The design tree, for its progress line (read it with readFrontier). */
  readonly frontier?: Frontier
  /** Config research.depth, shown during RESEARCH. */
  readonly researchDepth?: number
  /** Config domainPack: the active constitution, shown during RESEARCH. */
  readonly domainPack?: string
}

/** `open r2 t:pass a:- x:-` — status, round, thesis/antithesis/tiebreak verdicts. */
const auditBits = (audit: Audit) =>
  `${audit.status} r${audit.round} t:${audit.thesis?.verdict ?? "-"} a:${audit.antithesis?.verdict ?? "-"}${audit.tiebreak ? ` x:${audit.tiebreak.verdict}` : ""}`

const DEPTH = ["", "a brief", "thesis + antithesis", "thesis + antithesis, then a verification pass", "exhaustive"]

/** Compact factory-state block for system-context injection and compaction. */
export function factorySummary(state: FactoryState | undefined, extras: SummaryExtras = {}): string {
  if (!state) return "<factory-state>No factory run in this project. Start one with /grill.</factory-state>"
  const lines = [`run ${state.runId} · stage ${state.stage}`]
  if (extras.frontier) lines.push(treeLine(extras.frontier))
  if (state.stage === "RESEARCH" && extras.researchDepth !== undefined)
    lines.push(`research depth ${extras.researchDepth}: ${DEPTH[extras.researchDepth] ?? "custom"}`)
  if (state.stage === "RESEARCH" && extras.domainPack !== undefined) lines.push(`domain pack: ${extras.domainPack}`)
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
      `${marker} ${phase.id} ${phase.status}${phase.failures ? ` failures:${phase.failures}` : ""}${phase.replanned ? " replanned" : ""}${qa}${phase.audit ? ` audit[${phase.audit.id} ${auditBits(phase.audit)}]` : ""}${phase.id === state.activePhase && phase.worktree ? ` worktree:${phase.worktree}` : ""}`,
    )
  }
  for (const audit of state.audits)
    if (audit.target.kind === "path") lines.push(`audit ${audit.id} path:${audit.target.path} ${auditBits(audit)}`)
  if (state.release?.prUrl) lines.push(`PR: ${state.release.prUrl}`)
  return `<factory-state>\n${lines.join("\n")}\n</factory-state>`
}
