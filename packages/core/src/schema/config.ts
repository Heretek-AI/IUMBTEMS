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
      .describe(
        "Spend estimates used when the host reports no cost; estimates are labelled as such. Global config or plugin options only.",
      )
      .optional(),
    pr: z.enum(["gh", "off"]).describe("Release PR opener: the GitHub CLI, or off.").default("gh"),
    embeddings: z
      .object({
        url: z.string().describe("OpenAI-compatible embeddings endpoint (POST {model, input} → {data:[{embedding}]})."),
        model: z.string().describe("Embedding model id."),
        apiKeyEnv: z.string().describe("Environment variable holding the API key, sent as a Bearer token.").optional(),
      })
      .strict()
      .describe(
        "Optional OpenAI-compatible embeddings for brainstorm dedupe; unset uses MinHash/n-gram. Global config or plugin options only.",
      )
      .optional(),
    lspAfterEdit: z.boolean().describe("Append language-server diagnostics to edit results.").default(true),
    searchProvider: z
      .enum(["brave", "firecrawl", "searxng"])
      .describe("Web search provider; the default is the first one with credentials.")
      .optional(),
    research: z
      .object({
        depth: z
          .number()
          .int()
          .min(1)
          .max(4)
          .describe(
            "Research depth (advisory, shown in <factory-state> during RESEARCH): 1 brief, 2 thesis + antithesis, 3 plus a verification pass, 4 exhaustive.",
          )
          .default(2),
        cacheTtlDays: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Days es_research_fetch serves a cached page without refetching; unset: 7, or 30 for documentation hosts.",
          )
          .optional(),
        searchTimeoutS: z.number().min(1).describe("Timeout for one search-provider request, in seconds.").optional(),
        searxngUrl: z
          .string()
          .regex(/^https?:\/\/[^\s/]+\S*$/, "expected an http(s) URL")
          .describe("SearXNG instance (else SEARXNG_URL). Global config or plugin options only.")
          .optional(),
      })
      .strict()
      .describe("Research-stage tunables (ported from the 0.7 configure tool).")
      .default({ depth: 2 }),
    domainPack: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "pack ids are lowercase kebab-case")
      .describe(
        "Active domain-pack constitution for RESEARCH (quant, biopharma or legal); unset keeps the legacy flat behaviour.",
      )
      .optional(),
    licenseWhitelist: z
      .array(z.string())
      .describe(
        "SPDX ids darkharvest may depend on or vendor (a harvest plan may only narrow it); everything else is clean-room only.",
      )
      .default([...DEFAULT_LICENSE_WHITELIST]),
  })
  .strict()

export type EsConfig = z.infer<typeof EsConfigSchema>
export type EsConfigInput = z.input<typeof EsConfigSchema>
