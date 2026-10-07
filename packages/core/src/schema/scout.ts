// OSS scout artifacts (.factory/scout/, control files written only by the
// es_scout_* tools): the plan, one assessment per candidate, and the result
// whose verdicts core recomputes from the verified license, not the agent.
import { z } from "zod"
import { ClaimSchema } from "./claims.ts"
import { LicenseFindingSchema } from "./harvest.ts"

export const SCOUT_VERSION = 1 as const

export const ScoutPlanSchema = z.object({
  version: z.literal(SCOUT_VERSION),
  /** The feature we want to adopt or rebuild, and why. */
  objective: z.string().min(1),
  /** Our own license posture (e.g. "Apache-2.0, commercial"), for the contamination red-team. */
  posture: z.string().optional(),
  candidates: z.array(z.object({ id: z.string(), name: z.string(), source: z.string() })).min(1),
  /** SPDX ids that may be adopted (a plan may only narrow the configured whitelist). */
  whitelist: z.array(z.string()),
  createdAt: z.string(),
})
export type ScoutPlan = z.infer<typeof ScoutPlanSchema>

export const ScoutProposalSchema = z.enum(["adopt", "clean-room", "reject"])
export type ScoutProposal = z.infer<typeof ScoutProposalSchema>

export const ScoutAdvisorySchema = z.object({
  id: z.string(),
  summary: z.string(),
  aliases: z.array(z.string()).default([]),
  severity: z.string().optional(),
  fixed: z.array(z.string()).default([]),
  /** The cached OSV response it came from. */
  source: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})
export type ScoutAdvisory = z.infer<typeof ScoutAdvisorySchema>

export const ScoutAssessmentSchema = z.object({
  candidate: z.string(),
  stars: z.number().int().nonnegative().optional(),
  lastRelease: z.string().optional(),
  releasesPerYear: z.number().nonnegative().optional(),
  maintenance: z.enum(["vibrant", "stable", "slow", "abandoned"]),
  advisories: z.array(ScoutAdvisorySchema).default([]),
  proposal: ScoutProposalSchema,
  rationale: z.string().min(8),
  /** For clean-room: interfaces, the algorithm in prose, test fixtures (never copied code). */
  blueprint: z.string().optional(),
  /** Tagged, witnessed claims (benchmarks, API shape, maintenance facts). */
  claims: z.array(ClaimSchema),
  recordedAt: z.string(),
})
export type ScoutAssessment = z.infer<typeof ScoutAssessmentSchema>

export const ScoutVerdictSchema = z.object({
  candidate: z.string(),
  name: z.string(),
  license: LicenseFindingSchema,
  proposal: ScoutProposalSchema,
  /** The verdict after the license policy: adopt only for verified, whitelisted, permissive licenses. */
  verdict: ScoutProposalSchema,
  downgraded: z.string().optional(),
  attribution: z.string().optional(),
  warnings: z.array(z.string()),
  rank: z.number().int().positive(),
})
export type ScoutVerdict = z.infer<typeof ScoutVerdictSchema>

export const ScoutResultSchema = z.object({
  version: z.literal(SCOUT_VERSION),
  objective: z.string(),
  verdicts: z.array(ScoutVerdictSchema),
  completedAt: z.string(),
})
export type ScoutResult = z.infer<typeof ScoutResultSchema>
