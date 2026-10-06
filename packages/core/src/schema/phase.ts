import { z } from "zod"

export const PhaseStateSchema = z.enum(["PENDING", "RUNNING", "QA", "APPROVED", "FAILED", "HALTED"])

export type PhaseState = z.infer<typeof PhaseStateSchema>

export const AssignedSeatsSchema = z.object({
  programmer: z.string().default("programmer"),
  qa_a: z.string().default("qa-a"),
  qa_b: z.string().default("qa-b"),
  manager: z.string().default("manager"),
})

export type AssignedSeats = z.infer<typeof AssignedSeatsSchema>

export const PhaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  state: PhaseStateSchema.default("PENDING"),
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  replanCount: z.number().int().nonnegative().default(0),
  assignedSeats: AssignedSeatsSchema.default({
    programmer: "programmer",
    qa_a: "qa-a",
    qa_b: "qa-b",
    manager: "manager",
  }),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
})

export type Phase = z.infer<typeof PhaseSchema>
