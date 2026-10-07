import { z } from "zod"

/**
 * A node of the grill design tree: one question, its settled answer and why.
 * `parent` is the prerequisite edge (a node is asked once its ancestors are
 * settled). Decisions are the human's; facts are the agent's to look up — a
 * fact the repo cannot settle is deferred to RESEARCH, never asked.
 */
export const FrontierNodeSchema = z.object({
  id: z.string().min(1),
  parent: z.string().optional(),
  kind: z.enum(["decision", "fact"]).default("decision"),
  question: z.string().min(1),
  /** The options offered to the human, and the agent's recommendation. */
  choices: z.array(z.string()).optional(),
  recommended: z.string().optional(),
  answer: z.string().optional(),
  justification: z.string().optional(),
  status: z.enum(["open", "settled", "deferred"]).default("open"),
  /** The round the node was first asked in (1-based). */
  round: z.number().int().positive().optional(),
})

export type FrontierNode = z.infer<typeof FrontierNodeSchema>

export const SpendCeilingSchema = z.object({
  currency: z.literal("USD"),
  maxAmount: z.number().positive("the spend ceiling must be a positive amount"),
})

export type SpendCeiling = z.infer<typeof SpendCeilingSchema>

export const FrontierSchema = z
  .object({
    version: z.literal("1.1").default("1.1"),
    idea: z.string().min(1),
    spendCeiling: SpendCeilingSchema,
    settled: z.boolean().default(false),
    /** The current interview round (0 before the first round is asked). */
    round: z.number().int().nonnegative().default(0),
    nodes: z.array(FrontierNodeSchema).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((frontier, issue) => {
    const ids = new Set(frontier.nodes.map((node) => node.id))
    if (ids.size !== frontier.nodes.length)
      issue.addIssue({ code: "custom", path: ["nodes"], message: "duplicate node id" })
    const parentOf = new Map(frontier.nodes.map((node) => [node.id, node.parent]))
    frontier.nodes.forEach((node, index) => {
      if (node.parent !== undefined && !ids.has(node.parent))
        issue.addIssue({ code: "custom", path: ["nodes", index, "parent"], message: `unknown parent "${node.parent}"` })
      if (node.status === "settled" && !node.answer)
        issue.addIssue({ code: "custom", path: ["nodes", index, "answer"], message: "a settled node needs an answer" })
      if (node.kind === "fact" && node.status === "settled" && !node.justification)
        issue.addIssue({
          code: "custom",
          path: ["nodes", index, "justification"],
          message: "a settled fact needs its evidence (where it was looked up)",
        })
      if (node.round !== undefined && node.round > frontier.round)
        issue.addIssue({
          code: "custom",
          path: ["nodes", index, "round"],
          message: `asked in round ${node.round}, but the frontier is at round ${frontier.round}`,
        })
      // The parent chain must end: no node may be its own ancestor.
      const seen = new Set<string>([node.id])
      for (let up = node.parent; up !== undefined; up = parentOf.get(up)) {
        if (seen.has(up)) {
          issue.addIssue({ code: "custom", path: ["nodes", index, "parent"], message: `parent cycle through "${up}"` })
          break
        }
        seen.add(up)
      }
    })
    if (frontier.settled && frontier.nodes.some((node) => node.status === "open"))
      issue.addIssue({ code: "custom", path: ["settled"], message: "cannot be settled while nodes are still open" })
  })

export type Frontier = z.infer<typeof FrontierSchema>
