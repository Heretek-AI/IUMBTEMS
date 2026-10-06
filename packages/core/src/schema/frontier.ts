import { z } from "zod"

export const FrontierNodeSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().optional(),
  justification: z.string().optional(),
  status: z.enum(["open", "settled"]).default("open"),
  choices: z.array(z.string()).optional(),
})

export type FrontierNode = z.infer<typeof FrontierNodeSchema>

export const SpendCeilingSchema = z.object({
  currency: z.literal("USD"),
  maxAmount: z.number().positive("Spend ceiling must be a positive number"),
})

export type SpendCeiling = z.infer<typeof SpendCeilingSchema>

export const FrontierSchema = z.object({
  version: z.literal("1.0").default("1.0"),
  spendCeiling: SpendCeilingSchema,
  settled: z.boolean().default(false),
  settledAt: z.string().optional(),
  nodes: z.array(FrontierNodeSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type Frontier = z.infer<typeof FrontierSchema>
