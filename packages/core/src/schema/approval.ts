import { z } from "zod"

/** Stages a human must approve. Frontier: end of grill (sets the spend ceiling). Spec: roadmap + all GOAL.md, after which the run is autonomous. */
export const ApprovalStageSchema = z.enum(["frontier", "spec"])
export type ApprovalStage = z.infer<typeof ApprovalStageSchema>

export const ApprovalChannelSchema = z.enum(["cli", "tui"])
export type ApprovalChannel = z.infer<typeof ApprovalChannelSchema>

export const ApprovalSubjectSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64),
})

export const ApprovalSchema = z.object({
  version: z.literal(1),
  stage: ApprovalStageSchema,
  subject: z.array(ApprovalSubjectSchema).min(1),
  approvedBy: z.string().min(1),
  host: z.string().min(1),
  approvedAt: z.string().datetime(),
  channel: ApprovalChannelSchema,
  /** Audit-log head at approval time; anchors the log against truncation. */
  auditHead: z.object({ seq: z.number().int().nonnegative(), hash: z.string().length(64) }).nullable(),
  spendCeilingUSD: z.number().positive().optional(),
  notes: z.string().optional(),
  /** HMAC-SHA256 over the canonical record (minus mac) with the user-global signing key. */
  mac: z.string().length(64),
})

export type Approval = z.infer<typeof ApprovalSchema>
