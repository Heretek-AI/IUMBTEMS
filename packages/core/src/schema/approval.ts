import { z } from "zod"

/** Stages a human must approve. Frontier: end of grill (sets the spend ceiling). Spec: roadmap + all GOAL.md, after which the run is autonomous. */
export const ApprovalStageSchema = z.enum(["frontier", "spec"])
export type ApprovalStage = z.infer<typeof ApprovalStageSchema>

export const ChannelSchema = z.enum(["cli", "tui", "web"])
export type Channel = z.infer<typeof ChannelSchema>

/** An Ed25519 signature by the human key (approval/keystore.ts) over the canonical record minus `signature`. */
export const RecordSignatureSchema = z.object({
  alg: z.literal("ed25519"),
  /** Public fingerprint of the human key (not the key). */
  keyId: z.string().length(16),
  sig: z.string().min(1),
})

export const ApprovalSubjectSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64),
})

export const ApprovalSchema = z.object({
  /** 2 since 1.1.1 (Ed25519, passphrase-sealed); version-1 HMAC records are refused. */
  version: z.literal(2),
  stage: ApprovalStageSchema,
  subject: z.array(ApprovalSubjectSchema).min(1),
  approvedBy: z.string().min(1),
  host: z.string().min(1),
  approvedAt: z.string().datetime(),
  channel: ChannelSchema,
  /** Audit-log head at approval time; anchors the log against truncation. */
  auditHead: z.object({ seq: z.number().int().nonnegative(), hash: z.string().length(64) }).nullable(),
  spendCeilingUSD: z.number().positive().optional(),
  notes: z.string().optional(),
  signature: RecordSignatureSchema,
})

export type Approval = z.infer<typeof ApprovalSchema>
