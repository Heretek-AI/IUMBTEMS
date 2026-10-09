// Telemetry schemas for Phase 5 self-improvement (#135, #136). The harvester
// (packages/core/src/improve/telemetry.ts) produces `TelemetrySchema`; the
// distiller (packages/core/src/improve/distill.ts) consumes it. Versioned so
// later phases can evolve the dataset without silently misreading old files.
import { z } from "zod"

/** Current telemetry dataset version. Bump when a field is added or removed. */
export const TELEMETRY_VERSION = 1 as const

export const RunPhaseTelemetrySchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    failures: z.number().int().nonnegative(),
    replanned: z.boolean(),
  })
  .strict()
export type RunPhaseTelemetry = z.infer<typeof RunPhaseTelemetrySchema>

export const GateRejectionSchema = z
  .object({
    rule: z.string().min(1),
    count: z.number().int().positive(),
  })
  .strict()
export type GateRejection = z.infer<typeof GateRejectionSchema>

export const AuditFindingCountSchema = z
  .object({
    kind: z.string().min(1),
    severity: z.string().min(1),
    count: z.number().int().positive(),
  })
  .strict()
export type AuditFindingCount = z.infer<typeof AuditFindingCountSchema>

export const AuditChainTelemetrySchema = z
  .object({
    entries: z.number().int().nonnegative(),
    valid: z.boolean(),
    error: z.string().optional(),
  })
  .strict()
export type AuditChainTelemetry = z.infer<typeof AuditChainTelemetrySchema>

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
