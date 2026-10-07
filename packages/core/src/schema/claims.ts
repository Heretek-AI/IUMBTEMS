// The evidential claim stack: claims (one tagged assertion each), the witness
// that re-checks one against the cache or the code on disk, dossiers (the
// shared shape research, code audit and scout emit), retractions (sources
// that went bad) and the signed research brief (PCRB).
import { z } from "zod"

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256")

export const ClaimTagSchema = z.enum(["VERIFIED", "INFERRED", "HYPOTHESIS", "NEGATIVE_KNOWLEDGE"])
export type ClaimTag = z.infer<typeof ClaimTagSchema>

/** LIVE until a source is retracted (STALE) or revised (SUSPECT); REJECTED by an audit. */
export const ClaimStatusSchema = z.enum(["LIVE", "STALE", "SUSPECT", "REJECTED"])
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>

export const WitnessSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  reason: z.string().optional(),
})
export type Witness = z.infer<typeof WitnessSchema>

export const ClaimLocationSchema = z
  .object({
    /** POSIX path relative to the audited target's root. */
    file: z.string().min(1),
    /** Inclusive 1-based line range. */
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    /** Verbatim code from those lines. */
    excerpt: z.string().min(1),
  })
  .refine((location) => location.lines[0] <= location.lines[1], { message: "line range starts after it ends" })
export type ClaimLocation = z.infer<typeof ClaimLocationSchema>

export const ClaimSchema = z.object({
  /** sha256 of the claim's content fields (see claimId); never "UNKNOWN". */
  id: Sha256,
  tag: ClaimTagSchema,
  statement: z.string().min(1),
  status: ClaimStatusSchema.default("LIVE"),
  /** VERIFIED evidence from the source cache. */
  source: z
    .object({
      sha256: Sha256,
      quote: z.string().min(1),
      /** The snapshot's URL, for domain packs (banned-domain checks). */
      url: z.string().optional(),
    })
    .optional(),
  /** VERIFIED evidence from the code itself (code-audit findings). */
  location: ClaimLocationSchema.optional(),
  /** Claim ids an INFERRED claim reasons from. */
  parents: z.array(Sha256).optional(),
  /** INFERRED: the reasoning. */
  reasoning: z.string().optional(),
  /** HYPOTHESIS: how it would be tested or refuted. */
  falsification: z.string().optional(),
  /** NEGATIVE_KNOWLEDGE: what was searched, and what (nothing) was found. */
  query: z.string().optional(),
  finding: z.string().optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  witness: WitnessSchema.optional(),
})
export type Claim = z.infer<typeof ClaimSchema>

export const DossierModeSchema = z.enum(["research", "code-audit", "oss-scout"])
export type DossierMode = z.infer<typeof DossierModeSchema>

export const DossierVerdictSchema = z.object({
  by: z.string(),
  verdict: z.enum(["pass", "fail"]),
  at: z.string(),
  notes: z.string().default(""),
})

export const DossierSchema = z.object({
  version: z.literal("1.1"),
  mode: DossierModeSchema,
  /** What the dossier is about: the research idea, the audit target, the scouted feature. */
  subject: z.string().min(1),
  createdAt: z.string(),
  claims: z.array(ClaimSchema),
  verdicts: z.array(DossierVerdictSchema).default([]),
  /** sha256 over the sorted claim ids and cited source hashes. */
  evidenceHash: Sha256,
})
export type Dossier = z.infer<typeof DossierSchema>

export const RetractionSchema = z.object({
  source: Sha256,
  event: z.enum(["RETRACTED", "REVISED"]),
  at: z.string(),
  note: z.string().default(""),
  by: z.string(),
  /** The cached source that replaces it, when there is one. */
  supersedes: Sha256.optional(),
})
export type Retraction = z.infer<typeof RetractionSchema>

export const RetractionLedgerSchema = z.object({
  version: z.literal(1),
  retractions: z.array(RetractionSchema),
})
export type RetractionLedger = z.infer<typeof RetractionLedgerSchema>

/** Proof-Carrying Research Brief: the report, its ranked claims and their sources, signed. */
export const BriefSchema = z.object({
  pcrbVersion: z.literal("1.1"),
  objective: z.string(),
  exportedAt: z.string(),
  synthesis: z.string(),
  claims: z.array(ClaimSchema.extend({ witness: WitnessSchema })),
  sources: z.record(
    Sha256,
    z.object({ url: z.string(), title: z.string().optional(), retrieved: z.string(), content: z.string() }),
  ),
  manifest: z.object({
    synthesis: Sha256,
    claims: z.record(Sha256, Sha256),
    sources: z.record(Sha256, Sha256),
    /** Every member key, sorted, so a deleted or added member is detected. */
    members: z.array(z.string()),
  }),
  signature: z.object({
    alg: z.literal("hmac-sha256"),
    /** Public fingerprint of the signing key (not the key). */
    keyId: z.string(),
    mac: z.string(),
  }),
})
export type Brief = z.infer<typeof BriefSchema>
