// Darkharvest artifacts: candidate sources, per-project profiles with
// per-field provenance, deterministic SPDX license findings, and the feature
// matrix whose verdicts are enforced by the license policy (fail-closed).
import { z } from "zod"

export const HARVEST_VERSION = 1 as const

export const LicenseFindingSchema = z.object({
  /** SPDX id, or "unknown". */
  spdx: z.string(),
  family: z.enum(["permissive", "public-domain", "weak-copyleft", "copyleft", "unknown"]),
  source: z.enum(["license-file", "spdx-header", "manifest", "registry", "api"]),
  file: z.string().optional(),
  /** sha256 of the license file bytes (provenance for depend/vendor). */
  sha256: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  /** True only for a deterministic match on local bytes (file or header). */
  verified: z.boolean(),
  note: z.string().optional(),
})
export type LicenseFinding = z.infer<typeof LicenseFindingSchema>

export const ProvenanceSchema = z.object({
  kind: z.enum(["local", "clone", "api", "registry", "inferred"]),
  source: z.string().optional(),
  verified: z.boolean(),
  note: z.string().optional(),
})
export type Provenance = z.infer<typeof ProvenanceSchema>

export const HarvestProfileSchema = z.object({
  version: z.literal(HARVEST_VERSION),
  id: z.string(),
  name: z.string(),
  origin: z.string().optional(),
  commit: z.string().optional(),
  /** Registry release, when the source is a package. */
  release: z.string().optional(),
  license: LicenseFindingSchema,
  /** Language → file count (from the structural index). */
  languages: z.record(z.string(), z.number()),
  dependencies: z.object({
    runtime: z.array(z.string()),
    dev: z.array(z.string()),
  }),
  size: z.object({
    files: z.number().int(),
    bytes: z.number().int(),
    /** Approximate tokens (bytes / 4). */
    tokens: z.number().int(),
  }),
  graph: z.object({
    internalEdges: z.number().int(),
    external: z.number().int(),
    parsers: z.object({ treeSitter: z.number().int(), regex: z.number().int() }),
  }),
  /** Field name → where its value came from. */
  provenance: z.record(z.string(), ProvenanceSchema),
  warnings: z.array(z.string()),
  scannedAt: z.string(),
})
export type HarvestProfile = z.infer<typeof HarvestProfileSchema>

export const HARVEST_VERDICTS = ["depend", "vendor", "clean-room", "skip"] as const
export const HarvestVerdictSchema = z.enum(HARVEST_VERDICTS)
export type HarvestVerdict = z.infer<typeof HarvestVerdictSchema>

export const HarvestCellSchema = z.object({
  candidate: z.string(),
  verdict: HarvestVerdictSchema,
  evidence: z.string().optional(),
  /** SPDX attribution line, required for depend/vendor. */
  attribution: z.string().optional(),
  /** Reason the policy forced a different verdict (set by the engine). */
  downgraded: z.string().optional(),
})
export type HarvestCell = z.infer<typeof HarvestCellSchema>

export const HarvestRowSchema = z.object({
  feature: z.string().min(1),
  cells: z.array(HarvestCellSchema),
})
export type HarvestRow = z.infer<typeof HarvestRowSchema>

export const HarvestMatrixSchema = z.object({
  version: z.literal(HARVEST_VERSION),
  candidates: z.array(z.string()),
  rows: z.array(HarvestRowSchema),
  licensePolicy: z.object({
    whitelist: z.array(z.string()),
    failClosed: z.literal(true),
  }),
  builtAt: z.string(),
})
export type HarvestMatrix = z.infer<typeof HarvestMatrixSchema>

export const HarvestPlanSchema = z.object({
  version: z.literal(HARVEST_VERSION),
  objective: z.string().min(1),
  candidates: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      source: z.string(),
    }),
  ),
  /** Read budget per candidate, in approximate tokens. */
  readTokensPerCandidate: z.number().int().min(1_000),
  whitelist: z.array(z.string()),
  createdAt: z.string(),
})
export type HarvestPlan = z.infer<typeof HarvestPlanSchema>

export const HarvestResultSchema = z.object({
  version: z.literal(HARVEST_VERSION),
  objective: z.string(),
  profiles: z.array(HarvestProfileSchema),
  matrix: HarvestMatrixSchema,
  completedAt: z.string(),
})
export type HarvestResult = z.infer<typeof HarvestResultSchema>

/** Licenses whose verified, text-matched use may depend/vendor by default. */
export const DEFAULT_LICENSE_WHITELIST = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
] as const
