// Per-location runtime shared by the plugin's hooks, tools, commands and RPC.
import { stateDir as defaultStateDir, Factory, gateRunner, type PolicyContext } from "@heretek-ai/es-core"
import { ghPrOpener } from "./pr.ts"

export interface PluginOptions {
  /** Override the user-global state dir (signing key, trust store). Tests only. */
  readonly stateDir?: string
  /** Model per tier, "provider/model". Unset tiers inherit the session default. */
  readonly models?: Partial<Record<"fast" | "balanced" | "deep", string>>
  /** Gates after each programmer edit: "fast" (built-ins + format + lint), "off". */
  readonly afterEdit?: "fast" | "off"
  /** USD per million tokens when the host reports no cost (labelled estimated). */
  readonly estimate?: { readonly inputPerM?: number; readonly outputPerM?: number }
  /** Disable the gh-based PR opener (tests). */
  readonly pr?: "gh" | "off"
}

export interface Runtime {
  readonly root: string
  readonly options: PluginOptions
  readonly stateDir: string
  readonly factory: Factory
  policy(): Promise<PolicyContext>
}

export function createRuntime(root: string, options: PluginOptions): Runtime {
  const stateDir = options.stateDir ?? defaultStateDir()
  const factory = new Factory(root, {
    gates: gateRunner({ stateDir }),
    ...(options.pr === "off" ? {} : { pr: ghPrOpener }),
    stateDir,
  })
  return {
    root,
    options,
    stateDir,
    factory,
    async policy() {
      const worktree = await factory.activeWorktree().catch(() => undefined)
      return { root, stateDir, ...(worktree ? { worktree } : {}) }
    },
  }
}

export function parseOptions(raw: Record<string, unknown> | undefined): PluginOptions {
  const options = raw ?? {}
  const models =
    typeof options.models === "object" && options.models ? (options.models as PluginOptions["models"]) : undefined
  return {
    ...(typeof options.stateDir === "string" ? { stateDir: options.stateDir } : {}),
    ...(models ? { models } : {}),
    afterEdit: options.afterEdit === "off" ? "off" : "fast",
    ...(typeof options.estimate === "object" && options.estimate
      ? { estimate: options.estimate as PluginOptions["estimate"] }
      : {}),
    pr: options.pr === "off" ? "off" : "gh",
  }
}
