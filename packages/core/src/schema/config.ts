// One canonical config for the Epistemic Swarm plugin: layered global →
// project → plugin options, emitted as JSON Schema for the generated docs.
import { z } from "zod"
import { DEFAULT_LICENSE_WHITELIST } from "./harvest.ts"

export const EsConfigSchema = z
  .object({
    models: z
      .object({
        fast: z.string().describe('Model for fast-tier seats (lenses), "provider/model".').optional(),
        balanced: z.string().describe("Model for balanced-tier seats (programmer, QA, research).").optional(),
        deep: z.string().describe("Model for deep-tier seats (factory, grill, managers, critics).").optional(),
        agents: z.record(z.string(), z.string()).describe("Per-agent model overrides by agent id.").optional(),
      })
      .strict()
      .describe("Abstract model tiers mapped to concrete provider/model ids; unset tiers inherit the session default.")
      .optional(),
    afterEdit: z
      .enum(["fast", "off"])
      .describe("Gates after each programmer edit: fast built-ins or off (the phase-end gates always run).")
      .default("fast"),
    estimate: z
      .object({
        inputPerM: z
          .number()
          .positive()
          .describe("Estimated USD per million input tokens when the host reports no cost.")
          .default(3),
        outputPerM: z.number().positive().describe("Estimated USD per million output tokens.").default(15),
      })
      .strict()
      .describe("Spend estimates used when the host reports no cost; estimates are labelled as such.")
      .optional(),
    pr: z.enum(["gh", "off"]).describe("Release PR opener: the GitHub CLI, or off.").default("gh"),
    lspAfterEdit: z.boolean().describe("Append language-server diagnostics to edit results.").default(true),
    searchProvider: z
      .enum(["brave", "firecrawl", "searxng"])
      .describe("Web search provider; the default is the first one with credentials.")
      .optional(),
    licenseWhitelist: z
      .array(z.string())
      .describe("SPDX ids darkharvest may depend on or vendor; everything else is clean-room only.")
      .default([...DEFAULT_LICENSE_WHITELIST]),
  })
  .strict()

export type EsConfig = z.infer<typeof EsConfigSchema>
export type EsConfigInput = z.input<typeof EsConfigSchema>
