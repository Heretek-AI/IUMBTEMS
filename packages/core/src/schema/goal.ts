import { z } from "zod"
import { parseFrontmatter } from "../util/yaml.ts"

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  testCommand: z.string().min(1),
})

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>

export const GoalFrontmatterSchema = z.object({
  phase: z.string().min(1),
  title: z.string().min(1),
  verticalSlice: z.boolean().default(true),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1, "At least one acceptance criterion is required"),
  dependencies: z.array(z.string()).default([]),
  spendBudget: z.number().positive().optional(),
})

export type GoalFrontmatter = z.infer<typeof GoalFrontmatterSchema>

export interface ParsedGoal {
  readonly frontmatter: GoalFrontmatter
  readonly body: string
}

export function parseGoalMarkdown(content: string): ParsedGoal {
  const { data, body } = parseFrontmatter(content)
  const frontmatter = GoalFrontmatterSchema.parse(data)
  return { frontmatter, body }
}
