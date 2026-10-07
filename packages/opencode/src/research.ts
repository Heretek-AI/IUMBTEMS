// Research integration: the configured search provider becomes the host's
// websearch, and host web results are cached content-addressed so they can be
// cited. Caching is for Epistemic Swarm seats in a project that already has a
// .factory/ directory: the user's own agents get plain results, and no
// project gains a .factory/ because someone searched the web.
import { stat } from "node:fs/promises"
import { factoryLayout, researchCache, seatOf, selectProvider } from "@heretek-ai/es-core"
import type { Runtime } from "./runtime.ts"

interface SearchHit {
  readonly url: string
  readonly title?: string
  readonly text: string
}

/** Results the provider returned, waiting for the tool hook (which knows the agent) to cache them. */
export class PendingSearches {
  private readonly entries: Array<{ query: string; provider: string; hits: readonly SearchHit[]; at: number }> = []
  private static readonly TTL_MS = 5 * 60_000

  add(query: string, provider: string, hits: readonly SearchHit[]) {
    this.prune()
    this.entries.push({ query, provider, hits, at: Date.now() })
  }

  /** The oldest unclaimed results for this query (each search is claimed once). */
  take(query: string) {
    this.prune()
    const index = this.entries.findIndex((entry) => entry.query === query)
    return index < 0 ? undefined : this.entries.splice(index, 1)[0]
  }

  private prune() {
    const cutoff = Date.now() - PendingSearches.TTL_MS
    while (this.entries.length && this.entries[0]!.at < cutoff) this.entries.shift()
  }
}

/** Host web results are cached only for an ES seat, in a project that already has .factory/. */
async function cacheable(runtime: Runtime, agent: string | undefined): Promise<boolean> {
  if (!seatOf(agent)) return false
  return stat(factoryLayout(runtime.root).dir).then(
    (info) => info.isDirectory(),
    () => false,
  )
}

export function registerWebsearch(
  editor: { add(definition: any): void; default: { get(): unknown; set(id: string): void } },
  runtime: Runtime,
  pending: PendingSearches,
) {
  const searxng = runtime.config.research?.searxngUrl
  const env = searxng ? { ...process.env, SEARXNG_URL: searxng } : process.env
  const provider = selectProvider(runtime.options.searchProvider, env)
  if (!provider) return
  editor.add({
    id: "epistemic-swarm",
    name: `Epistemic Swarm (${provider.id})`,
    execute: async (input: { query: string; limit?: number }, context: { signal: AbortSignal }) => {
      const results = await provider.search(input.query, { limit: input.limit ?? 8, signal: context.signal, env })
      const hits = results.map((result) => ({
        url: result.url,
        title: result.title,
        text: result.content ?? result.snippet,
      }))
      pending.add(input.query, provider.id, hits)
      return hits.map((hit) => ({ url: hit.url, title: hit.title, content: hit.text, time: {} }))
    },
  })
  // Additive: become the default only when nothing else is selected.
  if (editor.default.get() === undefined) editor.default.set("epistemic-swarm")
}

const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: any) => part?.text ?? "").join("\n")
      : ""

const prepend = (result: any, note: string) => {
  const content = result?.content
  return {
    ...result,
    content: typeof content === "string" ? `${note}\n${content}` : [{ type: "text", text: note }, ...(content ?? [])],
  }
}

/**
 * Cache a seat's host webfetch and websearch results so they can be cited as
 * [VERIFIED: sha256:… "quote"]. Other agents' results pass through untouched.
 */
export function createWebCache(runtime: Runtime, pending: PendingSearches) {
  const cache = researchCache(runtime.root, runtime.stateDir)
  return async (event: { tool: string; status: string; agent?: string; input: unknown; result?: any }) => {
    if (event.tool === "websearch") {
      const query = (event.input as { query?: string } | undefined)?.query
      const search = typeof query === "string" ? pending.take(query) : undefined
      if (!search || event.status !== "completed" || !(await cacheable(runtime, event.agent))) return
      const lines: string[] = []
      for (const hit of search.hits) {
        if (!hit.text?.trim()) continue
        const cached = await cache.put({
          url: hit.url,
          title: hit.title,
          text: hit.text,
          provider: search.provider,
          query: search.query,
        })
        lines.push(`[cached sha256:${cached.meta.sha256}] ${hit.url}`)
      }
      if (lines.length)
        event.result = prepend(event.result, `${lines.join("\n")}\n(cite with [VERIFIED: sha256:<hash> "exact words"])`)
      return
    }
    if (event.tool !== "webfetch" || event.status !== "completed") return
    const url = (event.input as { url?: string } | undefined)?.url
    const text = contentText(event.result?.content)
    if (!url || text.trim().length < 40 || !(await cacheable(runtime, event.agent))) return
    const cached = await cache.put({ url, text, provider: "webfetch" })
    event.result = prepend(
      event.result,
      `[cached as sha256:${cached.meta.sha256}; cite with [VERIFIED: sha256:${cached.meta.sha256} "exact words"]]`,
    )
  }
}
