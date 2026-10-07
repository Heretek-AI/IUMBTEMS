// Queereye design-system artifacts: the interview state (resume source), the
// DTCG-shaped token tree, the contrast probe rows and the generated guide.
import { z } from "zod"

/** Any JSON value; the token tree is validated structurally in queereye/tokens. */
const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]),
)

export const DesignAnswersSchema = z.object({
  /** axis → slot → settled answer. */
  values: z.record(z.string(), z.record(z.string(), z.string())),
  /** axis → slots explicitly defaulted. */
  skipped: z.record(z.string(), z.array(z.string())),
  /** Validation errors recorded at save time (partial interviews still persist). */
  token_errors: z.array(z.string()).optional(),
})
export type DesignAnswers = z.infer<typeof DesignAnswersSchema>

export const ProbeRowSchema = z.object({
  name: z.string(),
  fg: z.string(),
  bg: z.string(),
  large_text: z.boolean(),
  ratio: z.number(),
  aa_threshold: z.number(),
  aaa_enhanced: z.number(),
  aaa_pass: z.boolean(),
  pass: z.boolean(),
  errors: z.array(z.string()),
})
export type ProbeRow = z.infer<typeof ProbeRowSchema>

export const QueereyeTokensSchema = z.record(z.string(), json)
export type QueereyeTokens = z.infer<typeof QueereyeTokensSchema>

export const DesignArtifactsSchema = z.object({
  version: z.literal(1),
  answers: DesignAnswersSchema,
  tokens: QueereyeTokensSchema,
  probes: z.array(ProbeRowSchema),
  reuse: z.object({ aliased: z.number().int(), total: z.number().int(), ratio: z.number() }),
  oneOffs: z.array(z.object({ path: z.string(), reason: z.string() })),
  generatedAt: z.string(),
})
export type DesignArtifacts = z.infer<typeof DesignArtifactsSchema>
