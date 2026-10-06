// Harness-neutral research tools: search (provider), fetch (cache a page),
// and audit (verify tags and quotes, optionally prune).
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import type { EsToolDef } from "../ops/tools.ts"
import { evaluateWrite, type PolicyContext } from "../trust/policy.ts"
import { auditMarkdown, formatCoverage, pruneClaims } from "./auditor.ts"
import { researchSourcesDir, SourceCache } from "./cache.ts"
import { fetchPage, type SearchProvider, selectProvider } from "./providers.ts"

export interface ResearchOpsContext {
  readonly root: string
  readonly policy: () => Promise<PolicyContext>
  readonly provider?: string
  readonly fetch?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

export function researchCache(root: string) {
  return new SourceCache(researchSourcesDir(root))
}

export function researchTools(context: ResearchOpsContext): EsToolDef[] {
  const cache = researchCache(context.root)
  const provider = (): SearchProvider => {
    const selected = selectProvider(context.provider, context.env)
    if (!selected)
      throw new Error(
        "No search provider is configured: set BRAVE_API_KEY, FIRECRAWL_API_KEY or SEARXNG_URL (or fetch known URLs directly).",
      )
    return selected
  }
  return [
    {
      name: "es_research_search",
      description:
        "Search the web with the configured provider. Results are cached; fetch a result with es_research_fetch before quoting it.",
      input: object({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
      execute: async ({ query, limit }, toolContext) => {
        const chosen = provider()
        const results = await chosen.search(query, {
          limit: limit ?? 8,
          ...(toolContext.signal ? { signal: toolContext.signal } : {}),
          ...(context.fetch ? { fetch: context.fetch } : {}),
          ...(context.env ? { env: context.env } : {}),
        })
        const lines: string[] = []
        for (const result of results) {
          const cached = result.content
            ? await cache.put({
                url: result.url,
                title: result.title,
                text: result.content,
                provider: chosen.id,
                query,
              })
            : undefined
          lines.push(
            `- ${result.title} <${result.url}>${cached ? ` [cached sha256:${cached.meta.sha256}]` : ""}\n  ${result.snippet.slice(0, 300)}`,
          )
        }
        return lines.length
          ? `${chosen.id} results for "${query}":\n${lines.join("\n")}`
          : `No results for "${query}". Record it as [NEGATIVE_KNOWLEDGE: ${query}] if it matters.`
      },
    },
    {
      name: "es_research_fetch",
      description:
        'Fetch a URL, cache its text content-addressed, and return the sha256 to cite: [VERIFIED: sha256:<hash> "verbatim quote"].',
      input: object(
        { url: { type: "string" }, offset: { type: "number", description: "Character offset into the cached text" } },
        ["url"],
      ),
      execute: async ({ url, offset }, toolContext) => {
        const page = await fetchPage(url, {
          ...(toolContext.signal ? { signal: toolContext.signal } : {}),
          ...(context.fetch ? { fetch: context.fetch } : {}),
        })
        const cached = await cache.put({
          url: page.url,
          ...(page.title ? { title: page.title } : {}),
          text: page.text,
          provider: "fetch",
        })
        const start = Math.max(0, offset ?? 0)
        const window = cached.text.slice(start, start + 12_000)
        return [
          `Cached ${page.url} as sha256:${cached.meta.sha256} (${cached.meta.bytes} bytes${page.title ? `, "${page.title}"` : ""}).`,
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
