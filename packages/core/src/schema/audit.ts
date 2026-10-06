import { z } from "zod"

export const AuditEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.string(),
  prevHash: z.string().length(64),
  actor: z.string().min(1),
  action: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  hash: z.string().length(64),
})

export type AuditEntry = z.infer<typeof AuditEntrySchema>
