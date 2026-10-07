// The grill decision tree, ported from legacy skills/grilling/socratic_tree.py.
// The frontier is every open node whose ancestors are all settled: the grill
// asks the whole frontier as one round. Unlike legacy (where add_node could
// silently un-settle a node and settle could rewrite an answer, bug B6),
// writes are checked against the previous tree: nodes are never deleted, a
// settled answer only changes after an explicit reopen, rounds never go back,
// and the idea is fixed once anything is settled.
import { factoryLayout } from "../layout.ts"
import { type Frontier, type FrontierNode, FrontierSchema } from "../schema/frontier.ts"
import { readJson } from "../util/fs.ts"

/** Open nodes whose whole ancestor chain is settled, in tree order. */
export function computeFrontier(frontier: Frontier): FrontierNode[] {
  const byId = new Map(frontier.nodes.map((node) => [node.id, node]))
  const ready = (node: FrontierNode): boolean => {
    const seen = new Set<string>()
    for (let up = node.parent; up !== undefined; up = byId.get(up)?.parent) {
      if (seen.has(up)) return false
      seen.add(up)
      if (byId.get(up)?.status !== "settled") return false
    }
    return true
  }
  return frontier.nodes.filter((node) => node.status === "open" && ready(node))
}

export interface TreeCounts {
  readonly round: number
  readonly total: number
  readonly settled: number
  readonly open: number
  readonly deferred: number
  /** Deferred fact nodes: questions the RESEARCH stage must answer. */
  readonly facts: number
  /** Open nodes askable now. */
  readonly frontier: number
}

export function treeCounts(frontier: Frontier): TreeCounts {
  const count = (status: FrontierNode["status"]) => frontier.nodes.filter((node) => node.status === status).length
  return {
    round: frontier.round,
    total: frontier.nodes.length,
    settled: count("settled"),
    open: count("open"),
    deferred: count("deferred"),
    facts: deferredFacts(frontier).length,
    frontier: computeFrontier(frontier).length,
  }
}

/** Fact nodes deferred to research. */
export const deferredFacts = (frontier: Frontier) =>
  frontier.nodes.filter((node) => node.kind === "fact" && node.status === "deferred")

/** Nodes that were settled before and are no longer (an explicit reopen). */
export function reopenedNodes(previous: Frontier | undefined, next: Frontier): string[] {
  if (!previous) return []
  const after = new Map(next.nodes.map((node) => [node.id, node]))
  return previous.nodes
    .filter((node) => node.status === "settled" && after.get(node.id) && after.get(node.id)!.status !== "settled")
    .map((node) => node.id)
}

/** Why `next` may not replace `previous` (empty when it may). */
export function diffFrontier(previous: Frontier | undefined, next: Frontier): string[] {
  if (!previous) return []
  const problems: string[] = []
  const after = new Map(next.nodes.map((node) => [node.id, node]))
  for (const before of previous.nodes) {
    const now = after.get(before.id)
    if (!now) {
      problems.push(`node "${before.id}" was removed; nodes are never deleted (mark it deferred instead)`)
      continue
    }
    if (before.status !== "settled" || now.status !== "settled") continue
    const changed = (["question", "answer", "kind", "parent"] as const).filter((field) => before[field] !== now[field])
    if (changed.length)
      problems.push(
        `settled node "${before.id}" changed its ${changed.join(" and ")}; reopen it first (save it with status "open"), then settle it again`,
      )
  }
  if (next.round < previous.round) problems.push(`round went back from ${previous.round} to ${next.round}`)
  if (next.idea !== previous.idea && previous.nodes.some((node) => node.status === "settled"))
    problems.push("the idea changed after decisions were settled; start a new run for a different idea")
  return problems
}

/** The frontier on disk, if it is a valid 1.1 tree. Throws (with the reason) when it exists but is not. */
export async function readFrontier(root: string): Promise<Frontier | undefined> {
  const raw = await readJson(factoryLayout(root).frontier)
  if (raw === undefined) return undefined
  const parsed = FrontierSchema.safeParse(raw)
  if (!parsed.success)
    throw new Error(
      `.factory/frontier.json is not a valid 1.1 frontier (${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "frontier"}: ${issue.message}`)
        .join("; ")}). 1.1 needs a fresh run: a human removes the old frontier and runs /grill again.`,
    )
  return parsed.data
}

/** One summary line: `tree r2: 5 settled · 2 open · 1 deferred (1 fact for research)`. */
export function treeLine(frontier: Frontier): string {
  const counts = treeCounts(frontier)
  const facts = counts.facts ? ` (${counts.facts} fact${counts.facts === 1 ? "" : "s"} for research)` : ""
  return `tree r${counts.round}: ${counts.settled} settled · ${counts.open} open · ${counts.deferred} deferred${facts}`
}
