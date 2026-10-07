// Per-location runtime shared by the plugin's hooks, tools, commands and RPC.
// Options are layered: the canonical config (global file → project file) with
// plugin options as the most specific override. Plugin options are config
// keys validated by the same strict schema; unknown keys are ignored with a
// warning the TUI shows once.
import {
  stateDir as defaultStateDir,
  type EsConfig,
  EsConfigSchema,
  Factory,
  gateRunner,
  LspManager,
  loadEsConfig,
  type PolicyContext,
} from "@heretek-ai/es-core"
import { ghPrOpener } from "./pr.ts"

/** Plugin options from opencode.json, split into config keys and the rest. */
export interface ParsedOptions {
  /** Override the user-global state dir (signing key, trust store). Tests only. */
  readonly stateDir?: string
  /** Config keys (docs/CONFIG.md), layered over the config files and validated with them. */
  readonly overrides: Readonly<Record<string, unknown>>
  /** Keys that are not config keys, sorted; ignored with a warning. */
  readonly unknown: readonly string[]
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
  /** Human-facing load warnings (e.g. ignored plugin options), shown once by the TUI. */
  readonly warnings: readonly string[]
  readonly stateDir: string
  readonly factory: Factory
  readonly lsp: LspManager
  policy(): Promise<PolicyContext>
}

export async function createRuntime(root: string, parsed: ParsedOptions): Promise<Runtime> {
  // stateDir is runtime-only; everything else can come from config files.
  const rawStateDir = parsed.stateDir
  const loaded = await loadEsConfig(root, { overrides: { ...parsed.overrides } })
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
    ...(config.domainPack ? { domainPack: config.domainPack } : {}),
  })
  return {
    root,
    options,
    config,
    configSources: loaded.sources,
    warnings: parsed.unknown.length ? [unknownOptionsWarning(parsed.unknown)] : [],
    stateDir,
    factory,
    lsp,
    async policy() {
      const worktree = await factory.activeWorktree().catch(() => undefined)
      return { root, stateDir, ...(worktree ? { worktree } : {}) }
    },
  }
}

const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(EsConfigSchema.shape))

/**
 * Split raw plugin options into config keys and the rest. Only keys the user
 * set are passed on, so config files are not clobbered; their values are
 * validated by the strict config schema (an invalid value fails the load, as
 * it would in a config file).
 */
export function parseOptions(raw: Record<string, unknown> | undefined): ParsedOptions {
  const overrides: Record<string, unknown> = {}
  const unknown: string[] = []
  let stateDir: string | undefined
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key === "stateDir" && typeof value === "string") stateDir = value
    else if (CONFIG_KEYS.has(key)) overrides[key] = value
    else unknown.push(key)
  }
  return { ...(stateDir ? { stateDir } : {}), overrides, unknown: unknown.sort() }
}

export function unknownOptionsWarning(keys: readonly string[]): string {
  return (
    `Ignored unknown plugin option${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}. ` +
    "Plugin options take the config keys in docs/CONFIG.md (es config show); " +
    "0.7-era options such as search_engine, max_iterations and mode were removed in 1.0."
  )
}
