import { z } from "zod"

export const StageSchema = z.enum(["GRILL", "RESEARCH", "SPEC", "BUILD", "QA", "RELEASE", "DONE", "HALTED"])
export type Stage = z.infer<typeof StageSchema>

export const VerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  by: z.string(),
  at: z.string(),
  notes: z.string().default(""),
})
export type Verdict = z.infer<typeof VerdictSchema>

export const PhaseStatusSchema = z.enum(["pending", "building", "qa", "replanning", "passed", "failed"])
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>

export const PhaseRuntimeSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: PhaseStatusSchema,
  /** GOAL.md hash the factory accepted (from the spec approval, or a recorded replan). */
  goalHash: z.string().length(64),
  failures: z.number().int().nonnegative().default(0),
  replanned: z.boolean().default(false),
  branch: z.string().optional(),
  /** Worktree path relative to the project root. */
  worktree: z.string().optional(),
  baseCommit: z.string().optional(),
  headCommit: z.string().optional(),
  qa: z
    .object({
      functional: VerdictSchema.optional(),
      adversarial: VerdictSchema.optional(),
      tiebreak: VerdictSchema.optional(),
    })
    .default({}),
  history: z.array(z.object({ at: z.string(), event: z.string(), notes: z.string().default("") })).default([]),
})
export type PhaseRuntime = z.infer<typeof PhaseRuntimeSchema>

export const FactoryStateSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  stage: StageSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  spendCeilingUSD: z.number().positive().optional(),
  autonomyStartedAt: z.string().optional(),
  spend: z.object({ usd: z.number().nonnegative(), estimated: z.boolean(), events: z.number().int() }).default({
    usd: 0,
    estimated: false,
    events: 0,
  }),
  baseBranch: z.string().optional(),
  runBranch: z.string().optional(),
  phases: z.array(PhaseRuntimeSchema).default([]),
  activePhase: z.string().optional(),
  release: z
    .object({ prUrl: z.string().optional(), at: z.string().optional(), head: z.string().optional() })
    .optional(),
  halt: z.object({ reason: z.string(), at: z.string(), from: StageSchema }).optional(),
})
export type FactoryState = z.infer<typeof FactoryStateSchema>

export interface FactoryLimits {
  readonly maxPhases: number
  /** Failures before halting: 3 attempts, one replan, 2 more attempts. */
  readonly maxFailuresPerPhase: number
  readonly replanAfterFailures: number
  readonly maxRuntimeMs: number
}

export const DEFAULT_LIMITS: FactoryLimits = {
  maxPhases: 20,
  maxFailuresPerPhase: 5,
  replanAfterFailures: 3,
  maxRuntimeMs: 8 * 60 * 60 * 1000,
}
