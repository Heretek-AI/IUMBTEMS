import { z } from "zod"

/** A human-signed, expiring exception for findings matching `rule` (glob) in `files` (glob). */
export const WaiverSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  rule: z.string().min(1),
  files: z.string().min(1).default("**"),
  reason: z.string().min(10, "explain why the finding is acceptable"),
  approvedBy: z.string().min(1),
  approvedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  channel: z.enum(["cli", "tui"]),
  auditHead: z.object({ seq: z.number().int().nonnegative(), hash: z.string().length(64) }).nullable(),
  mac: z.string().length(64),
})

export type Waiver = z.infer<typeof WaiverSchema>

export function isWaiverActive(waiver: Pick<Waiver, "expiresAt">, now: Date = new Date()): boolean {
  const expires = Date.parse(waiver.expiresAt)
  return !Number.isNaN(expires) && expires > now.getTime()
}
