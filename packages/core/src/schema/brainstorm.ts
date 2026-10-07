// Brainstorm artifacts: the plan (lenses and caps), recorded ideas, rubric
// scores, and the completed result (duplicate collapsing, ranking, and a
// diversified shortlist with a forced outlier slot).
import { z } from "zod"

export const BRAINSTORM_VERSION = 1 as const

export const BrainstormBriefSchema = z.object({
  idea: z.string().min(1),
  context: z.string().optional(),
  constraints: z.array(z.string()).optional(),
})
export type BrainstormBrief = z.infer<typeof BrainstormBriefSchema>

export const BrainstormPlanSchema = z.object({
  version: z.literal(BRAINSTORM_VERSION),
  brief: BrainstormBriefSchema,
  /** Built-in lens ids, in run order. */
  lenses: z.array(z.string()).min(1),
  /** Hard cap of recorded ideas per lens. */
  ideasPerLens: z.number().int().min(1).max(10),
  /** Hard cap of characters per idea text. */
  maxIdeaChars: z.number().int().min(120),
  /** Shortlist size, including the forced outlier slot. */
  shortlistSize: z.number().int().min(2).max(12),
  /** Similarity at or above which an idea is collapsed as a duplicate. */
  dedupeThreshold: z.number().min(0.5).max(0.95),
  createdAt: z.string(),
})
export type BrainstormPlan = z.infer<typeof BrainstormPlanSchema>

export const BrainstormIdeaSchema = z.object({
  id: z.string(),
  lens: z.string(),
  title: z.string().min(1),
  text: z.string().min(1),
  notes: z.string().optional(),
  /** Id of the earlier idea this one duplicates (collapsed at completion). */
  duplicateOf: z.string().optional(),
  /** Similarity to the idea it duplicates. */
  similarity: z.number().optional(),
  recordedAt: z.string(),
})
export type BrainstormIdea = z.infer<typeof BrainstormIdeaSchema>

/** The scoring rubric: four criteria, 1-5, equal weight. */
export const RUBRIC = [
  {
    id: "novelty",
    question: "How new is this against what already exists?",
    low: "an obvious variant",
    high: "a genuinely different approach",
  },
  {
    id: "upside",
    question: "If it worked, how much would it matter?",
    low: "marginal",
    high: "a step change",
  },
  {
    id: "feasibility",
    question: "How plausible is it within the stated constraints?",
    low: "needs a breakthrough",
    high: "a small spike could prove it",
  },
  {
    id: "fit",
    question: "How directly does it serve the brief?",
    low: "off-brief",
    high: "directly on-brief",
  },
] as const

const rating = z.number().int().min(1).max(5)

export const BrainstormScoreSchema = z.object({
  id: z.string(),
  novelty: rating,
  upside: rating,
  feasibility: rating,
  fit: rating,
  note: z.string().optional(),
  scoredAt: z.string(),
})
export type BrainstormScore = z.infer<typeof BrainstormScoreSchema>

export const BrainstormPriorArtSchema = z.object({
  title: z.string(),
  url: z.string(),
  relation: z.enum(["novel", "similar", "existing"]),
  note: z.string().optional(),
})
export type BrainstormPriorArt = z.infer<typeof BrainstormPriorArtSchema>

export const BrainstormShortlistEntrySchema = z.object({
  id: z.string(),
  total: z.number(),
  outlier: z.boolean(),
  reason: z.string().optional(),
})
export type BrainstormShortlistEntry = z.infer<typeof BrainstormShortlistEntrySchema>

export const BrainstormResultSchema = z.object({
  version: z.literal(BRAINSTORM_VERSION),
  brief: BrainstormBriefSchema,
  lenses: z.array(z.string()),
  /** Surviving (non-duplicate) ideas. */
  ideas: z.array(BrainstormIdeaSchema),
  duplicates: z.array(
    z.object({
      id: z.string(),
      duplicateOf: z.string(),
      similarity: z.number(),
      lens: z.string(),
      title: z.string(),
    }),
  ),
  ranked: z.array(z.object({ id: z.string(), total: z.number() })),
  shortlist: z.array(BrainstormShortlistEntrySchema),
  /** Surviving ideas per planned lens. */
  coverage: z.record(z.string(), z.number()),
  /** Planned lenses that produced no surviving idea. */
  gaps: z.array(z.string()),
  priorArt: z.array(BrainstormPriorArtSchema).optional(),
  stats: z.object({
    lenses: z.number().int(),
    ideas: z.number().int(),
    duplicates: z.number().int(),
    scored: z.number().int(),
  }),
  completedAt: z.string(),
})
export type BrainstormResult = z.infer<typeof BrainstormResultSchema>
