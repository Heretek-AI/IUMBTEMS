import { z } from "zod"

/** A node of the grill design tree: one question, its settled answer and why. */
export const FrontierNodeSchema = z.object({
  id: z.string().min(1),
  parent: z.string().optional(),
  question: z.string().min(1),
  answer: z.string().optional(),
  justification: z.string().optional(),
  status: z.enum(["open", "settled", "deferred"]).default("open"),
  choices: z.array(z.string()).optional(),
})

export type FrontierNode = z.infer<typeof FrontierNodeSchema>

export const SpendCeilingSchema = z.object({
  currency: z.literal("USD"),
  maxAmount: z.number().positive("the spend ceiling must be a positive amount"),
})

export type SpendCeiling = z.infer<typeof SpendCeilingSchema>

export const FrontierSchema = z
  .object({
    version: z.literal("1.0").default("1.0"),
    idea: z.string().min(1),
    spendCeiling: SpendCeilingSchema,
    settled: z.boolean().default(false),
    nodes: z.array(FrontierNodeSchema).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((frontier, issue) => {
    const ids = new Set(frontier.nodes.map((node) => node.id))
    if (ids.size !== frontier.nodes.length)
      issue.addIssue({ code: "custom", path: ["nodes"], message: "duplicate node id" })
    frontier.nodes.forEach((node, index) => {
      if (node.parent !== undefined && !ids.has(node.parent))
        issue.addIssue({ code: "custom", path: ["nodes", index, "parent"], message: `unknown parent "${node.parent}"` })
      if (node.status === "settled" && !node.answer)
        issue.addIssue({ code: "custom", path: ["nodes", index, "answer"], message: "a settled node needs an answer" })
    })
    if (frontier.settled && frontier.nodes.some((node) => node.status === "open"))
      issue.addIssue({ code: "custom", path: ["settled"], message: "cannot be settled while nodes are still open" })
  })

export type Frontier = z.infer<typeof FrontierSchema>
