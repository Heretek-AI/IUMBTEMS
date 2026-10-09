// Harness-neutral research tools: search (provider), fetch (cache a page),
// and audit (verify tags and quotes, optionally prune).
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { seatMayUse } from "../agents/registry.ts"
import { stateDir as defaultStateDir, factoryLayout } from "../layout.ts"
import type { EsToolDef } from "../ops/tools.ts"
import { ToolRefusal } from "../ops/tools.ts"
import type { EsConfig } from "../schema/config.ts"
import { evaluateWrite, type PolicyContext } from "../trust/policy.ts"
import { auditMarkdown, formatCoverage, pruneClaims } from "./auditor.ts"
import {
  type BackendErrorKind,
  getBackend,
  isFetchedSnapshot,
  resolveBackendOrder,
  runFetchChain,
  runSearchChain,
  type SourceBackend,
} from "./backends/index.ts"
import { researchSourcesDir, SourceCache } from "./cache.ts"
import { isFresh } from "./url.ts"

export interface ResearchOpsContext {
  readonly root: string
  readonly policy: () => Promise<PolicyContext>
  /** Engine-key dir for sealing cached sources (#52); seats get the runtime state dir. */
  readonly stateDir?: string
  readonly provider?: string
  readonly fetch?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
  /** Freshness override for cached pages (config research.cacheTtlDays); default 7 days, 30 for doc hosts. */
  readonly cacheTtlDays?: number
  /** Per-request search timeout in seconds (config research.searchTimeoutS). */
  readonly searchTimeoutS?: number
  /** SearXNG instance (config research.searxngUrl); overrides SEARXNG_URL. */
  readonly searxngUrl?: string
  /** Pack tierDomains override for source classification at ingestion (#113). */
  readonly tierDomains?: Record<string, string[]>
  /** Ordered backend ids (config research.backends); overrides searchProvider. */
  readonly backends?: string[]
  /**
   * Full backend chain override (tests and embedders): when set, the order is
   * these backends in this order, and availability is still checked per call.
   */
  readonly chain?: readonly SourceBackend[]
  readonly now?: () => Date
}

/** The research-tool options a loaded config sets. */
export function researchOptions(
  config: Pick<EsConfig, "searchProvider" | "research">,
): Pick<ResearchOpsContext, "provider" | "backends" | "cacheTtlDays" | "searchTimeoutS" | "searxngUrl"> {
  const research = config.research
  return {
    ...(config.searchProvider ? { provider: config.searchProvider } : {}),
    ...(research?.backends ? { backends: [...research.backends] } : {}),
    ...(research?.cacheTtlDays !== undefined ? { cacheTtlDays: research.cacheTtlDays } : {}),
    ...(research?.searchTimeoutS !== undefined ? { searchTimeoutS: research.searchTimeoutS } : {}),
    ...(research?.searxngUrl ? { searxngUrl: research.searxngUrl } : {}),
  }
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

/** Providers whose snapshots hold the whole page: legacy ids plus every fetch-capable backend. */
const fetchedSnapshot = (providerId: string): boolean => isFetchedSnapshot(providerId)

/**
 * The engine cache for a project. Entries are sealed with the engine key
 * (#52); `stateDir` defaults to the global state dir, like every other core
 * function that takes it. Tests pass an isolated dir.
 */
export function researchCache(root: string, stateDir: string = defaultStateDir()) {
  return new SourceCache(researchSourcesDir(root), stateDir)
}

/** The CLI operator runs research tools as "human" (no registry seat); seats keep the registry check. */
const mayResearch = (agent: string | undefined, tool: string): boolean => agent === "human" || seatMayUse(agent, tool)

export function researchTools(context: ResearchOpsContext): EsToolDef[] {
  const cache = researchCache(context.root, context.stateDir ?? defaultStateDir())
  const env = context.searxngUrl ? { ...(context.env ?? process.env), SEARXNG_URL: context.searxngUrl } : context.env
  const order = resolveBackendOrder({
    ...(context.backends ? { backends: context.backends } : {}),
    ...(context.provider ? { provider: context.provider } : {}),
  })
  const chain: readonly SourceBackend[] =
    context.chain ?? order.map((id) => getBackend(id)).filter((backend) => backend !== undefined)
  // One cooldown map per tools instance (one per plugin process): a down
  // backend is skipped for a while instead of retried on every call (#106).
  const cooldowns = new Map<string, { until: number; kind: BackendErrorKind }>()
  const signals = (toolContext: { signal?: AbortSignal }): AbortSignal | undefined => {
    const list = [
      ...(toolContext.signal ? [toolContext.signal] : []),
      ...(context.searchTimeoutS ? [AbortSignal.timeout(context.searchTimeoutS * 1000)] : []),
    ]
    return list.length ? (list.length === 1 ? list[0]! : AbortSignal.any(list)) : undefined
  }
  return [
    {
      name: "es_research_search",
      description:
        "Search the web with the configured provider. Results are cached; fetch a result with es_research_fetch before quoting it.",
      input: object({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
      execute: async ({ query, limit }, toolContext) => {
        if (!mayResearch(toolContext.agent, "es_research_search"))
          throw new ToolRefusal("Only the research and scout seats may search the web.")
        const signal = signals(toolContext)
        const found = await runSearchChain(
          chain,
          query,
          {
            limit: limit ?? 8,
            ...(signal ? { signal } : {}),
            ...(context.fetch ? { fetch: context.fetch } : {}),
            ...(env ? { env } : {}),
          },
          { cooldowns },
        )
        const lines: string[] = []
        for (const result of found.value) {
          const cached = result.content
            ? await cache.put({
                url: result.url,
                title: result.title,
                text: result.content,
                provider: found.backend,
                query,
                ...(context.tierDomains ? { tierDomains: context.tierDomains } : {}),
              })
            : undefined
          lines.push(
            `- ${result.title} <${result.url}>${cached ? ` [cached sha256:${cached.meta.sha256}]` : ""}\n  ${result.snippet.slice(0, 300)}`,
          )
        }
        return lines.length
          ? `${found.backend} results for "${query}":\n${lines.join("\n")}`
          : `No results for "${query}". Record it as [NEGATIVE_KNOWLEDGE: ${query}] if it matters.`
      },
    },
    {
      name: "es_research_fetch",
      description:
        'Fetch a URL, cache its text content-addressed, and return the sha256 to cite: [VERIFIED: sha256:<hash> "verbatim quote"]. A fresh cached copy is served without a network request (refresh:true fetches again).',
      input: object(
        {
          url: { type: "string" },
          offset: { type: "number", description: "Character offset into the cached text" },
          refresh: { type: "boolean", description: "Fetch again even when a fresh cached copy exists" },
        },
        ["url"],
      ),
      execute: async ({ url, offset, refresh }, toolContext) => {
        if (!mayResearch(toolContext.agent, "es_research_fetch"))
          throw new ToolRefusal("Only the research and scout seats may fetch a page.")
        // The webcache gate: a fresh full-page snapshot of the same canonical URL
        // is served from the cache. Search results cached under a page's URL are
        // snippets, not the page, so only fetched snapshots count.
        const fresh =
          refresh === true
            ? undefined
            : await cache.byUrl(url).then((hit) =>
                hit &&
                fetchedSnapshot(hit.meta.provider) &&
                isFresh(hit.meta.retrieved, url, {
                  ...(context.cacheTtlDays !== undefined ? { ttlDays: context.cacheTtlDays } : {}),
                  ...(context.now ? { now: context.now() } : {}),
                })
                  ? hit
                  : undefined,
              )
        const fetched =
          fresh === undefined
            ? await runFetchChain(chain, url, {
                ...(toolContext.signal ? { signal: toolContext.signal } : {}),
                ...(context.fetch ? { fetch: context.fetch } : {}),
                ...(env ? { env } : {}),
                cooldowns,
              })
            : undefined
        const page = fetched?.value
        const cached =
          fresh ??
          (await cache.put({
            url: page!.url,
            ...(page!.title ? { title: page!.title } : {}),
            text: page!.text,
            provider: fetched!.backend,
            ...(context.tierDomains ? { tierDomains: context.tierDomains } : {}),
          }))
        const title = cached.meta.title
        const start = Math.max(0, offset ?? 0)
        const window = cached.text.slice(start, start + 12_000)
        return [
          fresh
            ? `Served ${url} from the cache: sha256:${cached.meta.sha256} (retrieved ${cached.meta.retrieved}; refresh:true fetches again).`
            : `Cached ${page!.url} as sha256:${cached.meta.sha256} (${cached.meta.bytes} bytes${title ? `, "${title}"` : ""}).`,
          `Cite it as [VERIFIED: sha256:${cached.meta.sha256} "<exact words from the text below>"].`,
          start + 12_000 < cached.text.length
            ? `Showing ${start}–${start + 12_000}; call again with offset ${start + 12_000} for more.`
            : "",
          "---",
          window,
        ]
          .filter(Boolean)
          .join("\n")
      },
    },
    {
      name: "es_research_audit",
      description:
        "Audit a research artifact: every claim needs an epistemic tag, and every VERIFIED quote must appear verbatim in its cached source. prune:true moves failing claims to a 'Pruned claims' section.",
      input: object({
        path: { type: "string", description: "Default .factory/research/REPORT.md" },
        prune: { type: "boolean" },
      }),
      execute: async ({ path: target, prune }, toolContext) => {
        if (!mayResearch(toolContext.agent, "es_research_audit"))
          throw new ToolRefusal("Only the research seats and factory may audit a research artifact.")
        const file = path.resolve(
          context.root,
          target ?? path.relative(context.root, factoryLayout(context.root).researchReport),
        )
        const text = await readFile(file, "utf8").catch(() => undefined)
        if (text === undefined) return `${path.relative(context.root, file)} does not exist yet.`
        const report = await auditMarkdown(text, cache)
        if (prune && !report.passed) {
          const decision = evaluateWrite(await context.policy(), toolContext.agent, file)
          if (decision.effect !== "allow")
            throw new Error(decision.effect === "deny" ? decision.reason : "Pruning needs approval to write this file.")
          await writeFile(file, pruneClaims(text, report))
          return `${formatCoverage(report)}\nPruned ${report.claims.filter((claim) => claim.status !== "grounded").length} claim(s) into "## Pruned claims".`
        }
        return formatCoverage(report)
      },
    },
  ]
}
