import { z } from "zod"
import { parseFrontmatter } from "../util/yaml.ts"

/** Machine-checkable acceptance criteria. Each is verified by code, not by a model's say-so. */
export const AcceptanceCriterionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    id: z.string().min(1),
    description: z.string().min(1),
    /** argv string (no shell); must exit 0 in the phase worktree. */
    command: z.string().min(1),
  }),
  z.object({
    kind: z.literal("test"),
    id: z.string().min(1),
    description: z.string().min(1),
    /** Test file that must exist in the worktree and pass under the project's test runner. */
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal("file"),
    id: z.string().min(1),
    description: z.string().min(1),
    path: z.string().min(1),
    contains: z.string().optional(),
  }),
])

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>

export const GoalFrontmatterSchema = z.object({
  phase: z.string().min(1),
  title: z.string().min(1),
  acceptance: z.array(AcceptanceCriterionSchema).min(1, "at least one acceptance criterion is required"),
  /** Optional per-phase spend budget (the run-wide ceiling still applies). */
  budgetUSD: z.number().positive().optional(),
})

export type GoalFrontmatter = z.infer<typeof GoalFrontmatterSchema>

export interface ParsedGoal {
  readonly frontmatter: GoalFrontmatter
  readonly body: string
}

export function parseGoalMarkdown(content: string): ParsedGoal {
  const { data, body } = parseFrontmatter(content)
  const frontmatter = GoalFrontmatterSchema.parse(data)
  const ids = new Set<string>()
  for (const criterion of frontmatter.acceptance) {
    if (ids.has(criterion.id)) throw new Error(`duplicate acceptance criterion id "${criterion.id}"`)
    ids.add(criterion.id)
  }
  if (body.trim().length === 0) throw new Error("GOAL.md needs a body describing the vertical slice")
  return { frontmatter, body }
}
