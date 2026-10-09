// Domain packs: pluggable epistemic constitutions for RESEARCH, ported from
// 0.7.25 `runner/refinement.py` (the pack JSON fields are camel-cased here).
// A pack weights verified claims by source tier, taxes rejected claims, and may
// enforce banned domains, mandatory tags and a retraction policy. Selection is
// `config.domainPack`; with no pack the research flow is unchanged.
import { z } from "zod"
import { ClaimTagSchema } from "./claims.ts"

export const RetractionPolicySchema = z.enum(["standard", "zero_tolerance"])
export type RetractionPolicy = z.infer<typeof RetractionPolicySchema>

export const DomainPackSchema = z
  .object({
    packId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "pack ids are lowercase kebab-case")
      .describe("Built-in pack id: the file name under assets/domain-packs/."),
    description: z.string().min(1),
    /** Per-verified-claim weight by source tier; `__default__` covers unlisted tiers (legacy default 1.0). */
    tierWeights: z.record(z.string(), z.number().nonnegative()).default({ __default__: 1 }),
    negBonus: z.number().nonnegative().default(0.5).describe("Score bonus per counted negative-knowledge claim."),
    rejectPenalty: z.number().nonnegative().default(2.5).describe("Score penalty per rejected claim."),
    acceptThreshold: z.number().min(0).max(1).default(0.65).describe("Minimum E(D) score for a pack-gated audit."),
    bannedDomains: z.array(z.string().min(1)).default([]).describe("Source URLs containing any of these are rejected."),
    mandatoryTags: z.array(ClaimTagSchema).default([]).describe("Every claim must carry one of these tags."),
    retractionPolicy: RetractionPolicySchema.default("standard"),
    /** Per-tier host overrides for source classification (checked before the built-in table). */
    tierDomains: z
      .record(z.string(), z.array(z.string().min(1)))
      .optional()
      .describe("Pack host overrides by tier for source classification."),
    /** Legacy metadata; carried so ported pack files round-trip. */
    exportTemplate: z.string().optional(),
  })
  .strict()
export type DomainPack = z.infer<typeof DomainPackSchema>
