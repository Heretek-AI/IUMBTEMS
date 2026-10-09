// Pluggable web search providers (Brave, Firecrawl, SearXNG) and a plain
// page fetcher. Each provider is available when its credentials/endpoint are
// configured in the environment; DuckDuckGo scraping is deliberately absent.
import { htmlToText } from "./html.ts"

export interface SearchResult {
  readonly url: string
  readonly title: string
  readonly snippet: string
  /** Full page text when the provider returns it (Firecrawl). */
  readonly content?: string
}

export interface SearchProvider {
  readonly id: string
  available(env?: NodeJS.ProcessEnv): boolean
  search(
    query: string,
    options: { limit?: number; signal?: AbortSignal; fetch?: typeof fetch; env?: NodeJS.ProcessEnv },
  ): Promise<SearchResult[]>
}

async function json(response: Response, provider: string) {
  if (!response.ok) {
    // Machine-readable details for the backend chain (#106): the HTTP status
    // classifies the failure, and a 429 Retry-After sets the cooldown.
    const error = new Error(`${provider} search failed: HTTP ${response.status}`) as Error & {
      status?: number
      retryAfterMs?: number
    }
    error.status = response.status
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after")
      if (retryAfter !== null) {
        if (/^\d+$/.test(retryAfter.trim())) error.retryAfterMs = Number(retryAfter.trim()) * 1000
        else {
          const at = Date.parse(retryAfter)
          if (!Number.isNaN(at)) error.retryAfterMs = Math.max(0, at - Date.now())
        }
      }
    }
    throw error
  }
  return response.json() as Promise<any>
}

export const braveProvider: SearchProvider = {
  id: "brave",
  available: (env = process.env) => Boolean(env.BRAVE_API_KEY),
  async search(query, { limit = 8, signal, fetch: doFetch = fetch, env = process.env }) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
    const body = await json(
      await doFetch(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY ?? "" },
        ...(signal ? { signal } : {}),
      }),
      "Brave",
    )
    return (body.web?.results ?? []).slice(0, limit).map((item: any) => ({
      url: item.url,
      title: item.title ?? item.url,
      snippet: htmlToText(item.description ?? "").text,
    }))
  },
}

export const firecrawlProvider: SearchProvider = {
  id: "firecrawl",
  available: (env = process.env) => Boolean(env.FIRECRAWL_API_KEY),
  async search(query, { limit = 8, signal, fetch: doFetch = fetch, env = process.env }) {
    const base = env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev"
    const body = await json(
      await doFetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${env.FIRECRAWL_API_KEY ?? ""}` },
        body: JSON.stringify({ query, limit, scrapeOptions: { formats: ["markdown"] } }),
        ...(signal ? { signal } : {}),
      }),
      "Firecrawl",
    )
    const items: any[] = Array.isArray(body.data) ? body.data : (body.data?.web ?? [])
    return items.slice(0, limit).map((item) => ({
      url: item.url,
      title: item.title ?? item.metadata?.title ?? item.url,
      snippet: item.description ?? "",
      ...(item.markdown ? { content: item.markdown } : {}),
    }))
  },
}

export const searxngProvider: SearchProvider = {
  id: "searxng",
  available: (env = process.env) => Boolean(env.SEARXNG_URL),
  async search(query, { limit = 8, signal, fetch: doFetch = fetch, env = process.env }) {
    const base = (env.SEARXNG_URL ?? "").replace(/\/$/, "")
    const body = await json(
      await doFetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      }),
      "SearXNG",
    )
    return (body.results ?? [])
      .slice(0, limit)
      .map((item: any) => ({ url: item.url, title: item.title ?? item.url, snippet: item.content ?? "" }))
  },
}

export const SEARCH_PROVIDERS: readonly SearchProvider[] = [braveProvider, firecrawlProvider, searxngProvider]

/** The configured provider: an explicit id, else the first with credentials. */
export function selectProvider(preferred?: string, env: NodeJS.ProcessEnv = process.env): SearchProvider | undefined {
  if (preferred) return SEARCH_PROVIDERS.find((provider) => provider.id === preferred && provider.available(env))
  return SEARCH_PROVIDERS.find((provider) => provider.available(env))
}

export interface FetchedPage {
  readonly url: string
  readonly title?: string
  readonly text: string
  readonly contentType: string
}

const MAX_FETCH_BYTES = 3_000_000

/** A fetchPage refusal on safety grounds (SSRF/policy): the chain must never route around it (#106). */
const blocked = (message: string) => {
  const error = new Error(message) as Error & { code?: string }
  error.code = "blocked"
  return error
}

/** Fetch a page and convert it to text. Only http(s); HTML is converted, text formats are kept. */
export async function fetchPage(
  url: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<FetchedPage> {
  if (!/^https?:\/\//i.test(url)) throw blocked("Only http(s) URLs can be fetched")
  const response = await (options.fetch ?? fetch)(url, {
    headers: {
      "User-Agent": "epistemic-swarm/1.0 (+research cache)",
      Accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
    },
    redirect: "follow",
    signal: options.signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Fetching ${url} failed: HTTP ${response.status}`)
  const contentType = response.headers.get("content-type") ?? "text/plain"
  if (/pdf|octet-stream|image\/|video\/|audio\//.test(contentType))
    throw blocked(`Cannot cache ${contentType} content as text`)
  const buffer = await response.arrayBuffer()
  const raw = new TextDecoder().decode(buffer.byteLength > MAX_FETCH_BYTES ? buffer.slice(0, MAX_FETCH_BYTES) : buffer)
  if (/html|xml/.test(contentType)) {
    const page = htmlToText(raw)
    return { url: response.url || url, ...(page.title ? { title: page.title } : {}), text: page.text, contentType }
  }
  return { url: response.url || url, text: raw, contentType }
}
