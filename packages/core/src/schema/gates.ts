import { z } from "zod"

export const GateFindingSchema = z.object({
  file: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  rule: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  fixHint: z.string().optional(),
})

export type GateFinding = z.infer<typeof GateFindingSchema>

export const GateCommandsSchema = z.object({
  format: z
    .object({
      command: z.string(),
      extensions: z.array(z.string()).default([]),
    })
    .optional(),
  lint: z
    .object({
      command: z.string(),
      extensions: z.array(z.string()).default([]),
    })
    .optional(),
  typecheck: z
    .object({
      command: z.string(),
    })
    .optional(),
  test: z
    .object({
      command: z.string(),
      fullCommand: z.string().optional(),
    })
    .optional(),
})

export type GateCommands = z.infer<typeof GateCommandsSchema>

export const GateBudgetsSchema = z.object({
  maxDiffLines: z.number().int().positive().default(500),
  maxFileLines: z.number().int().positive().default(800),
  requireDepJustification: z.boolean().default(true),
})

export type GateBudgets = z.infer<typeof GateBudgetsSchema>

export const GateSecuritySchema = z.object({
  secrets: z.boolean().default(true),
  osv: z.boolean().default(false),
})

export type GateSecurity = z.infer<typeof GateSecuritySchema>

export const GatesConfigSchema = z.object({
  version: z.literal("1.0").default("1.0"),
  commands: GateCommandsSchema.default({}),
  budgets: GateBudgetsSchema.default({
    maxDiffLines: 500,
    maxFileLines: 800,
    requireDepJustification: true,
  }),
  security: GateSecuritySchema.default({
    secrets: true,
    osv: false,
  }),
})

export type GatesConfig = z.infer<typeof GatesConfigSchema>

export const GateResultSchema = z.object({
  passed: z.boolean(),
  findings: z.array(GateFindingSchema),
  waiverCount: z.number().int().nonnegative().default(0),
  summary: z.string(),
})

export type GateResult = z.infer<typeof GateResultSchema>
