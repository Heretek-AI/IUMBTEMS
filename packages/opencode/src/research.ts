// Research integration: the configured search provider becomes the host's
// websearch (results cached content-addressed, so they can be cited), and the
// host's own webfetch results are cached too.
import { researchCache, selectProvider } from "@heretek-ai/es-core"
import type { Runtime } from "./runtime.ts"

export function registerWebsearch(
  editor: { add(definition: any): void; default: { get(): unknown; set(id: string): void } },
  runtime: Runtime,
) {
  const provider = selectProvider(runtime.options.searchProvider)
  if (!provider) return
  const cache = researchCache(runtime.root)
  editor.add({
    id: "epistemic-swarm",
    name: `Epistemic Swarm (${provider.id}, cached)`,
    execute: async (input: { query: string; limit?: number }, context: { signal: AbortSignal }) => {
      const results = await provider.search(input.query, { limit: input.limit ?? 8, signal: context.signal })
      const out = []
      for (const result of results) {
        const cached = await cache.put({
          url: result.url,
          title: result.title,
          text: result.content ?? result.snippet,
          provider: provider.id,
          query: input.query,
        })
        out.push({
          url: result.url,
          title: result.title,
          content: `[cached sha256:${cached.meta.sha256}]\n${result.content ?? result.snippet}`,
          time: {},
        })
      }
      return out
    },
  })
  // Additive: become the default only when nothing else is selected.
  if (editor.default.get() === undefined) editor.default.set("epistemic-swarm")
}

/** Cache host webfetch results so they can be cited as [VERIFIED: sha256:… "quote"]. */
export function createWebfetchCache(runtime: Runtime) {
  const cache = researchCache(runtime.root)
  return async (event: { tool: string; status: string; input: unknown; result?: any }) => {
    if (event.tool !== "webfetch" || event.status !== "completed") return
    const url = (event.input as { url?: string } | undefined)?.url
    const content = event.result?.content
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part: any) => part?.text ?? "").join("\n")
          : ""
    if (!url || text.trim().length < 40) return
    const cached = await cache.put({ url, text, provider: "webfetch" })
    const note = `[cached as sha256:${cached.meta.sha256}; cite with [VERIFIED: sha256:${cached.meta.sha256} "exact words"]]`
    event.result = {
      ...event.result,
      content: typeof content === "string" ? `${note}\n${content}` : [{ type: "text", text: note }, ...(content ?? [])],
    }
  }
}
