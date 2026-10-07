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

/** What a code audit examines: the active phase's worktree, or a path inside the project. */
export const AuditTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("phase"), phase: z.string().min(1) }),
  z.object({ kind: z.literal("path"), path: z.string().min(1) }),
])
export type AuditTarget = z.infer<typeof AuditTargetSchema>

export const describeTarget = (target: AuditTarget) =>
  target.kind === "phase" ? `phase ${target.phase}` : `path ${target.path}`

/**
 * A code audit by the thesis/antithesis auditor pair. It settles like QA
 * (equal verdicts, or the manager's tiebreak) and blocks: a phase audit holds
 * passPhase, any other audit refuses the next stage transition while open or
 * failed. With `audit.phase: required` (Factory `auditPhase` dep) a missing
 * phase audit holds passPhase too; the default `optional` merges QA-passed
 * phases with no audit opened. Re-opening bumps the round and clears the
 * verdicts.
 */
export const AuditSchema = z.object({
  id: z.string().min(1),
  target: AuditTargetSchema,
  round: z.number().int().positive().default(1),
  status: z.enum(["open", "passed", "failed", "dismissed"]).default("open"),
  openedAt: z.string(),
  openedBy: z.string(),
  thesis: VerdictSchema.optional(),
  antithesis: VerdictSchema.optional(),
  tiebreak: VerdictSchema.optional(),
  dismissed: z.object({ by: z.string(), at: z.string(), reason: z.string() }).optional(),
})
export type Audit = z.infer<typeof AuditSchema>

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
  /** A code audit of this phase, when one was opened. */
  audit: AuditSchema.optional(),
  history: z.array(z.object({ at: z.string(), event: z.string(), notes: z.string().default("") })).default([]),
})
export type PhaseRuntime = z.infer<typeof PhaseRuntimeSchema>

export const FACTORY_STATE_VERSION = 2 as const

export const FactoryStateSchema = z.object({
  version: z.literal(FACTORY_STATE_VERSION),
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
  /** Audits not tied to a phase (a path in the project). */
  audits: z.array(AuditSchema).default([]),
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
