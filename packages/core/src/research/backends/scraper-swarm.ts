// Scraper-Swarm gateway backend (#107): the user's self-hosted
// search-and-scrape gateway behind one authenticated JSON-RPC endpoint
// (POST /mcp). ADR 0001 keeps the gateway its own repo; this client speaks
// the versioned protocol only, and the contract tests replay the vendored
// golden fixtures without running the stack.
//
// The token comes only from ES_SCRAPER_SWARM_TOKEN (masked in seat sandboxes
// via SECRET_ENV) and never leaves the Authorization header: it is never
// written to .factory/, logs or error messages.
import { sha256 } from "../../util/hash.ts"
import type { FetchedPage, SearchResult } from "../providers.ts"
import {
  BackendError,
  type BackendFetchOptions,
  type BackendSearchOptions,
  parseRetryAfterMs,
  type SourceBackend,
} from "./index.ts"

/** The gateway contract major this client speaks (fixtures pin the same). */
export const SCRAPER_SWARM_CONTRACT_VERSION = 1 as const
export const SCRAPER_SWARM_BACKEND_ID = "scraper-swarm" as const
export const SCRAPER_SWARM_URL_ENV = "ES_SCRAPER_SWARM_URL" as const
export const SCRAPER_SWARM_TOKEN_ENV = "ES_SCRAPER_SWARM_TOKEN" as const

export interface ScraperSwarmConfig {
  readonly url: string
  readonly token: string
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
}

/** Read the gateway config from the environment; undefined unless fully configured. */
export function scraperSwarmConfig(env: NodeJS.ProcessEnv = process.env): ScraperSwarmConfig | undefined {
  const url = env[SCRAPER_SWARM_URL_ENV]
  const token = env[SCRAPER_SWARM_TOKEN_ENV]
  if (!url || !token) return undefined
  return { url, token }
}

interface JsonRpcOk {
  readonly id: unknown
  readonly result: {
    readonly content?: ReadonlyArray<{ readonly text?: string }>
    readonly structuredContent?: Record<string, any>
    readonly isError?: boolean
  }
}
interface JsonRpcError {
  readonly id: unknown
  readonly error: { readonly code: number; readonly message: string }
}

const contractMajor = (header: string | null): number | undefined => {
  if (!header) return undefined
  const major = Number(header.trim().split(".")[0])
  return Number.isInteger(major) && major >= 0 ? major : undefined
}

export class ScraperSwarmClient {
  private readonly endpoint: string
  private readonly token: string
  private readonly doFetch: typeof fetch
  private readonly signal?: AbortSignal
  private id = 0

  constructor(config: ScraperSwarmConfig) {
    this.endpoint = config.url.replace(/\/+$/, "")
    this.token = config.token
    this.doFetch = config.fetch ?? fetch
    if (config.signal) this.signal = config.signal
  }

  private async call(tool: "web_search" | "fetch_page", args: Record<string, unknown>): Promise<JsonRpcOk["result"]> {
    this.id += 1
    let response: Response
    try {
      response = await this.doFetch(`${this.endpoint}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.id,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
        ...(this.signal ? { signal: this.signal } : {}),
      })
    } catch {
      // Never let the token leak into a network error message.
      throw new BackendError("unavailable", "Scraper-Swarm gateway is unreachable")
    }
    if (response.status === 401 || response.status === 403)
      throw new BackendError("auth", `Scraper-Swarm gateway refused the call: HTTP ${response.status}`)
    if (response.status === 429)
      throw new BackendError("rate_limited", "Scraper-Swarm gateway rate limit exceeded", {
        ...(parseRetryAfterMs(response.headers.get("retry-after")) !== undefined
          ? { retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"))! }
          : {}),
        status: response.status,
      })
    if (!response.ok) throw new BackendError("upstream", `Scraper-Swarm gateway failed: HTTP ${response.status}`)
    const major = contractMajor(response.headers.get("x-swarm-contract"))
    if (major !== SCRAPER_SWARM_CONTRACT_VERSION)
      throw new BackendError(
        "upstream",
        `Scraper-Swarm gateway speaks contract ${response.headers.get("x-swarm-contract") ?? "unknown"}; this client speaks v${SCRAPER_SWARM_CONTRACT_VERSION} — re-vendor the fixtures and update the client`,
      )
    const body = (await response.json().catch(() => undefined)) as JsonRpcOk | JsonRpcError | undefined
    if (!body || typeof body !== "object" || !("jsonrpc" in body)) {
      // A FastAPI error body ({"detail"}) on an unexpected status lands here.
      const detail = (body as { detail?: unknown } | undefined)?.detail
      throw new BackendError(
        "upstream",
        typeof detail === "string"
          ? `Scraper-Swarm gateway: ${detail}`
          : "Scraper-Swarm gateway returned no JSON-RPC body",
      )
    }
    if ("error" in body)
      throw new BackendError("upstream", `Scraper-Swarm gateway: ${body.error.message} (${body.error.code})`)
    if (body.id !== this.id) throw new BackendError("upstream", "Scraper-Swarm gateway echoed the wrong JSON-RPC id")
    const result = body.result
    if (result.isError) {
      const code = result.structuredContent?.code
      const message = result.structuredContent?.message ?? result.content?.[0]?.text ?? "gateway tool error"
      if (code === "ssrf_denied" || code === "blocked_by_policy")
        throw new BackendError("blocked", `Scraper-Swarm gateway: ${message}`)
      if (code === "upstream_timeout") throw new BackendError("timeout", `Scraper-Swarm gateway: ${message}`)
      throw new BackendError("upstream", `Scraper-Swarm gateway: ${message}${code ? ` (${code})` : ""}`)
    }
    return result
  }

  async search(query: string, limit = 8): Promise<SearchResult[]> {
    const result = await this.call("web_search", { query, limit })
    const items = result.structuredContent?.results
    if (!Array.isArray(items)) throw new BackendError("upstream", "Scraper-Swarm gateway returned no search results")
    return items.flatMap((item): SearchResult[] => {
      const url = typeof item?.url === "string" ? item.url : undefined
      if (!url) return []
      return [
        {
          url,
          title: typeof item?.title === "string" && item.title ? item.title : url,
          snippet: typeof item?.snippet === "string" ? item.snippet : "",
        },
      ]
    })
  }

  async fetchPage(url: string): Promise<FetchedPage> {
    const result = await this.call("fetch_page", { url })
    const page = result.structuredContent
    const content = typeof page?.content === "string" ? page.content : undefined
    if (!content) throw new BackendError("upstream", "Scraper-Swarm gateway returned no page content")
    // Fail closed: the bytes must hash to the gateway's attested digest before anything caches them.
    if (typeof page?.content_sha256 === "string" && sha256(content) !== page.content_sha256)
      throw new BackendError("upstream", "Scraper-Swarm gateway content_sha256 mismatch: refusing the page")
    const finalUrl = typeof page?.final_url === "string" && page.final_url ? page.final_url : url
    const contentType =
      typeof page?.content_type === "string" && page.content_type
        ? page.content_type
        : page?.format === "markdown"
          ? "text/markdown"
          : "text/plain"
    return {
      url: finalUrl,
      ...(typeof page?.title === "string" && page.title ? { title: page.title } : {}),
      text: content,
      contentType,
    }
  }
}

const clientFor = (options: BackendSearchOptions | BackendFetchOptions): ScraperSwarmClient | undefined => {
  const fromEnv = scraperSwarmConfig(options.env ?? process.env)
  if (!fromEnv) return undefined
  return new ScraperSwarmClient({
    ...fromEnv,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

export const scraperSwarmBackend: SourceBackend = {
  id: SCRAPER_SWARM_BACKEND_ID,
  capabilities: { search: true, fetch: true },
  available: (env = process.env) => scraperSwarmConfig(env) !== undefined,
  search: async (query, options) => {
    const client = clientFor(options)
    if (!client) throw new BackendError("unavailable", "Scraper-Swarm gateway is not configured")
    return client.search(query, options.limit ?? 8)
  },
  fetch: async (url, options) => {
    const client = clientFor(options)
    if (!client) throw new BackendError("unavailable", "Scraper-Swarm gateway is not configured")
    return client.fetchPage(url)
  },
}
