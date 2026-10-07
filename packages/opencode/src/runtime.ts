// Per-location runtime shared by the plugin's hooks, tools, commands and RPC.
// Options are layered: the canonical config (global file → project file) with
// plugin options as the most specific override.
import {
  stateDir as defaultStateDir,
  type EsConfig,
  Factory,
  gateRunner,
  LspManager,
  loadEsConfig,
  type PolicyContext,
} from "@heretek-ai/es-core"
import { ghPrOpener } from "./pr.ts"

/** Raw plugin options from opencode.json; every field is optional. */
export interface RawPluginOptions {
  /** Override the user-global state dir (signing key, trust store). Tests only. */
  readonly stateDir?: string
  /** Model per tier, "provider/model". */
  readonly models?: {
    readonly fast?: string
    readonly balanced?: string
    readonly deep?: string
    readonly agents?: Readonly<Record<string, string>>
  }
  readonly afterEdit?: "fast" | "off"
  readonly estimate?: { readonly inputPerM?: number; readonly outputPerM?: number }
  readonly pr?: "gh" | "off"
  readonly lspAfterEdit?: boolean
  readonly searchProvider?: "brave" | "firecrawl" | "searxng"
}

/** Resolved options: config defaults applied; consumers read this shape. */
export interface PluginOptions {
  readonly stateDir?: string
  readonly models?: EsConfig["models"]
  readonly afterEdit: "fast" | "off"
  readonly estimate?: { readonly inputPerM: number; readonly outputPerM: number }
  readonly pr: "gh" | "off"
  readonly lspAfterEdit: boolean
  readonly searchProvider?: "brave" | "firecrawl" | "searxng"
}

export interface Runtime {
  readonly root: string
  readonly options: PluginOptions
  readonly config: EsConfig
  /** Config files that contributed values, in layer order. */
  readonly configSources: readonly string[]
  readonly stateDir: string
  readonly factory: Factory
  readonly lsp: LspManager
  policy(): Promise<PolicyContext>
}

export async function createRuntime(root: string, raw: RawPluginOptions): Promise<Runtime> {
  // stateDir is runtime-only; everything else can come from config files.
  const { stateDir: rawStateDir, ...overrides } = raw
  const loaded = await loadEsConfig(root, { overrides })
  const config = loaded.config
  const options: PluginOptions = {
    ...(rawStateDir ? { stateDir: rawStateDir } : {}),
    ...(config.models ? { models: config.models } : {}),
    afterEdit: config.afterEdit,
    ...(config.estimate ? { estimate: config.estimate } : {}),
    pr: config.pr,
    lspAfterEdit: config.lspAfterEdit,
    ...(config.searchProvider ? { searchProvider: config.searchProvider } : {}),
  }
  const stateDir = options.stateDir ?? defaultStateDir()
  const lsp = new LspManager({ root, stateDir })
  const factory = new Factory(root, {
    gates: gateRunner({ stateDir }),
    ...(options.pr === "off" ? {} : { pr: ghPrOpener }),
    stateDir,
    researchDepth: config.research.depth,
  })
  return {
    root,
    options,
    config,
    configSources: loaded.sources,
    stateDir,
    factory,
    lsp,
    async policy() {
      const worktree = await factory.activeWorktree().catch(() => undefined)
      return { root, stateDir, ...(worktree ? { worktree } : {}) }
    },
  }
}

/** Keep only the keys the user actually set, so config files are not clobbered. */
export function parseOptions(raw: Record<string, unknown> | undefined): RawPluginOptions {
  const options = raw ?? {}
  const models =
    typeof options.models === "object" && options.models ? (options.models as RawPluginOptions["models"]) : undefined
  const estimate =
    typeof options.estimate === "object" && options.estimate
      ? (options.estimate as RawPluginOptions["estimate"])
      : undefined
  return {
    ...(typeof options.stateDir === "string" ? { stateDir: options.stateDir } : {}),
    ...(models ? { models } : {}),
    ...(options.afterEdit === "fast" || options.afterEdit === "off" ? { afterEdit: options.afterEdit } : {}),
    ...(estimate ? { estimate } : {}),
    ...(options.pr === "gh" || options.pr === "off" ? { pr: options.pr } : {}),
    ...(typeof options.lspAfterEdit === "boolean" ? { lspAfterEdit: options.lspAfterEdit } : {}),
    ...(typeof options.searchProvider === "string"
      ? { searchProvider: options.searchProvider as RawPluginOptions["searchProvider"] }
      : {}),
  }
}
