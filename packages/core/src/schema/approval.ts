import { z } from "zod"

export const ApprovalSchema = z.object({
  stage: z.string().min(1),
  phaseId: z.string().optional(),
  artifactPath: z.string().min(1),
  artifactHash: z.string().min(1),
  approvedBy: z.string().min(1),
  approvedAt: z.string(),
  spendCeilingConfirmed: z.number().positive().optional(),
  notes: z.string().optional(),
})

export type Approval = z.infer<typeof ApprovalSchema>
