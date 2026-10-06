import { z } from "zod"

export const WaiverSchema = z.object({
  id: z.string().min(1),
  rule: z.string().min(1),
  filePattern: z.string().min(1),
  reason: z.string().min(1),
  signedBy: z.string().min(1),
  signedAt: z.string(),
  expiresAt: z.string(),
  artifactHash: z.string().min(1),
})

export type Waiver = z.infer<typeof WaiverSchema>

export function isWaiverActive(waiver: Waiver, now: Date = new Date()): boolean {
  const expires = new Date(waiver.expiresAt).getTime()
  return !Number.isNaN(expires) && expires > now.getTime()
}
