// Telemetry schemas for Phase 5 self-improvement (#135, #136). The harvester
// (packages/core/src/improve/telemetry.ts) produces `TelemetrySchema`; the
// distiller (packages/core/src/improve/distill.ts) consumes it. Versioned so
// later phases can evolve the dataset without silently misreading old files.
import { z } from "zod"

/** Current telemetry dataset version. Bump when a field is added or removed. */
export const TELEMETRY_VERSION = 2 as const

/**
 * One phase failure (S3.4, #135): who failed, how, and why. `seat` is the
 * seat the source data names (chain actor, audit record) — never a default:
 * run-level signals with no seat (gate findings) omit it, and the distiller
 * keys them without one. `reason` is scrubbed by the harvester (S3.1).
 */
export const FailureEntrySchema = z
  .object({
    seat: z.string().min(1).optional(),
    kind: z.string().min(1),
    rule: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict()
export type FailureEntry = z.infer<typeof FailureEntrySchema>

export const RunPhaseTelemetrySchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    /** Attempts so far: failures + 1 once the phase started (0 while pending). */
    attempts: z.number().int().nonnegative(),
    /** Replans so far: the replanned flag plus replan events in the history. */
    replans: z.number().int().nonnegative(),
    failures: z.array(FailureEntrySchema),
  })
  .strict()
export type RunPhaseTelemetry = z.infer<typeof RunPhaseTelemetrySchema>

export const GateRejectionSchema = z
  .object({
    rule: z.string().min(1),
    count: z.number().int().positive(),
    /** Gate summary paths (run-root-relative) carrying the rule, sorted. */
    logs: z.array(z.string().min(1)).default([]),
  })
  .strict()
export type GateRejection = z.infer<typeof GateRejectionSchema>

export const AuditFindingCountSchema = z
  .object({
    kind: z.string().min(1),
    severity: z.string().min(1),
    count: z.number().int().positive(),
    /** Audit records paths (run-root-relative) carrying the kind, sorted. */
    sources: z.array(z.string().min(1)).default([]),
  })
  .strict()
export type AuditFindingCount = z.infer<typeof AuditFindingCountSchema>

/**
 * One audit-chain entry, minimally: sequence, hash and action, plus the
 * phase and reason when the payload names them. Evidence strings link to
 * these hashes (S3.5) instead of synthesizing quotes.
 */
export const ChainTrailEntrySchema = z
  .object({
    seq: z.number().int().nonnegative(),
    hash: z.string().length(64),
    action: z.string().min(1),
    phase: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict()
export type ChainTrailEntry = z.infer<typeof ChainTrailEntrySchema>

export const AuditChainTelemetrySchema = z
  .object({
    entries: z.number().int().nonnegative(),
    valid: z.boolean(),
    error: z.string().optional(),
    trail: z.array(ChainTrailEntrySchema).default([]),
  })
  .strict()
export type AuditChainTelemetry = z.infer<typeof AuditChainTelemetrySchema>

/**
 * The run-state sidecar seal (S3.2, #135). Engine-owned run state is
 * sidecar-signed; a missing or forged seal is reported here and the run's
 * state-derived content (mode, stage, halt, spend, phases) is untrusted.
 */
export const RunStateSealSchema = z
  .object({
    valid: z.boolean(),
    error: z.string().min(1).optional(),
  })
  .strict()
export type RunStateSeal = z.infer<typeof RunStateSealSchema>

export const RunTelemetrySchema = z
  .object({
    /** Project-root-relative run id (the harvested directory's base name). */
    id: z.string().min(1),
    mode: z.string(),
    stage: z.string(),
    halt: z.object({ reason: z.string(), from: z.string() }).strict().optional(),
    spend: z.object({ usd: z.number().nonnegative(), estimated: z.boolean(), events: z.number().int() }).strict(),
    phases: z.array(RunPhaseTelemetrySchema),
    gateRejections: z.array(GateRejectionSchema),
    auditFindings: z.array(AuditFindingCountSchema),
    auditChain: AuditChainTelemetrySchema,
    seal: RunStateSealSchema,
  })
  .strict()
export type RunTelemetry = z.infer<typeof RunTelemetrySchema>

export const EvalTelemetrySchema = z
  .object({
    case: z.string().min(1),
    pass: z.boolean(),
    failures: z.array(z.string()),
    steps: z.number().int().nonnegative(),
    model: z.string().optional(),
    modelLimited: z.boolean().optional(),
    /** Aggregate file (base name) the result came from: the evidence link. */
    source: z.string().min(1),
  })
  .strict()
export type EvalTelemetry = z.infer<typeof EvalTelemetrySchema>

export const TelemetrySchema = z
  .object({
    version: z.literal(TELEMETRY_VERSION),
    harvestedAt: z.string().min(1),
    runs: z.array(RunTelemetrySchema),
    evals: z.array(EvalTelemetrySchema),
  })
  .strict()
export type Telemetry = z.infer<typeof TelemetrySchema>

// ------------------------------------------------- distillation (#136)

export const ClusterKindSchema = z.enum(["gate", "audit", "qa", "replan", "eval"])
export type ClusterKind = z.infer<typeof ClusterKindSchema>

/** One recurring signal: the same failure keyed across runs, with its evidence. */
export const ClusterSchema = z
  .object({
    key: z.string().min(1),
    kind: ClusterKindSchema,
    /** Human-readable label (the rule, category or failing case). */
    label: z.string().min(1),
    /** The seat the failures name, when they name one — never defaulted. */
    seat: z.string().min(1).optional(),
    occurrences: z.number().int().nonnegative(),
    runIds: z.array(z.string().min(1)),
    /** Verbatim evidence strings, each present in the source telemetry. */
    evidence: z.array(z.string().min(1)),
  })
  .strict()
export type Cluster = z.infer<typeof ClusterSchema>

export const ProposalKindSchema = z.enum(["prompt-guidance", "gate-tuning", "domain-pack"])
export type ProposalKind = z.infer<typeof ProposalKindSchema>

/** A reviewable proposal: rationale plus evidence-linked files, never applied. */
export const ProposalSchema = z
  .object({
    id: z.string().min(1),
    kind: ProposalKindSchema,
    cluster: ClusterSchema,
    rationale: z.string().min(1),
    /** Proposal-dir-relative files this proposal writes (patch, explanation, pack). */
    files: z.array(z.string().min(1)),
  })
  .strict()
export type Proposal = z.infer<typeof ProposalSchema>
