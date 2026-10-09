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
const MAX_FETCH_REDIRECTS = 5

/** A fetchPage refusal on safety grounds (SSRF/policy): the chain must never route around it (#106). */
const blocked = (message: string) => {
  const error = new Error(message) as Error & { code?: string }
  error.code = "blocked"
  return error
}

/** An IPv4 dotted quad fetchPage never contacts: loopback, RFC1918, link-local, this-network. */
const blockedIPv4 = (quad: string, allowLoopback: boolean): boolean => {
  const octets = quad.split(".").map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (allowLoopback && a === 127) return false
  return (
    a === 0 || // this network
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 169 && b === 254) // link-local, including cloud metadata endpoints
  )
}

/** An IPv6 literal (brackets stripped) fetchPage never contacts. */
const blockedIPv6 = (host: string, allowLoopback: boolean): boolean => {
  const name = host.toLowerCase()
  if (name === "::1") return !allowLoopback
  if (name === "::") return true
  // An IPv4-mapped tail (::ffff:169.254.169.254, hex or dotted) is judged as IPv4.
  const tail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(name)?.[1]
  if (tail) return blockedIPv4(tail, allowLoopback)
  if (name.startsWith("::ffff:")) {
    const words = name.slice("::ffff:".length).split(":")
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const pair = words.map((word) => Number.parseInt(word, 16)) as [number, number]
      return blockedIPv4(`${pair[0] >> 8}.${pair[0] & 0xff}.${pair[1] >> 8}.${pair[1] & 0xff}`, allowLoopback)
    }
    return false
  }
  const first = name.split(":", 1)[0]
  return /^fe[89ab]/.test(first ?? "") || /^f[cd]/.test(first ?? "") // link-local, unique-local
}

/**
 * Whether fetchPage must refuse this host without fetching: literal
 * non-routable IPs (loopback unless the fixture allowance is on) and
 * localhost. The hostname comes from WHATWG URL parsing (the same parser
 * fetch uses), so decimal/hex/octal IPv4 tricks arrive already normalised
 * to a dotted quad; userinfo never reaches the host.
 */
const blockedHost = (host: string, allowLoopback: boolean): boolean => {
  const name = host.toLowerCase().replace(/\.+$/, "")
  if (name === "localhost" || name.endsWith(".localhost")) return !allowLoopback
  const bare = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name
  // The suffix after the last colon is the only place a dotted quad can
  // hide (plain "1.2.3.4", "::1.2.3.4", "fe80::1.2.3.4"). A linear tail
  // test replaces the old (?:^|:|^.*:) alternation (Sonar S8786).
  const tail = bare.includes(":") ? bare.slice(bare.lastIndexOf(":") + 1) : bare
  const quad = /^\d+\.\d+\.\d+\.\d+$/.test(tail) ? tail : undefined
  if (quad) return blockedIPv4(quad, allowLoopback)
  if (bare.includes(":")) return blockedIPv6(bare, allowLoopback)
  return false
}

/**
 * Loopback is refused by default. ES_RESEARCH_ALLOW_LOOPBACK=1 re-admits
 * 127/8, ::1 and localhost for loopback-only fixture servers in tests —
 * the harness's deterministic pages bind 127.0.0.1 and nothing leaves the
 * machine. Link-local (169.254/16), RFC1918 and other non-routables stay
 * refused either way. Never set this in production.
 */
const loopbackAllowed = (env: NodeJS.ProcessEnv | undefined): boolean =>
  /^(1|true|yes)$/i.test(env?.ES_RESEARCH_ALLOW_LOOPBACK ?? "")

/** Parse an http(s) fetch target and refuse non-routable hosts before any fetch. */
const assertRoutable = (raw: string, allowLoopback: boolean): URL => {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw blocked("Only http(s) URLs can be fetched")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw blocked("Only http(s) URLs can be fetched")
  if (blockedHost(parsed.hostname, allowLoopback))
    throw blocked(`Refusing to fetch ${parsed.hostname}: it resolves to a non-routable address (SSRF guard)`)
  return parsed
}

/** One manual-redirect fetch hop with the research user-agent. */
async function fetchOnce(current: string, doFetch: typeof fetch, signal: AbortSignal): Promise<Response> {
  return doFetch(current, {
    headers: {
      "User-Agent": "epistemic-swarm/1.0 (+research cache)",
      Accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
    },
    redirect: "manual",
    signal,
  })
}

/** Resolve one redirect target, re-checking routability; undefined stops the chain. */
function followRedirect(
  location: string | null | undefined,
  current: string,
  url: string,
  hop: number,
  allowLoopback: boolean,
): string | undefined {
  if (!location) return undefined
  if (hop >= MAX_FETCH_REDIRECTS) throw new Error(`Fetching ${url} failed: too many redirects`)
  let next: URL
  try {
    next = new URL(location, current)
  } catch {
    return undefined
  }
  return assertRoutable(next.toString(), allowLoopback).toString()
}

/** Decode a fetched response body to text, refusing binary content. */
async function readBody(response: Response): Promise<{ text: string; contentType: string; title?: string }> {
  const contentType = response.headers.get("content-type") ?? "text/plain"
  if (/pdf|octet-stream|image\/|video\/|audio\//.test(contentType))
    throw blocked(`Cannot cache ${contentType} content as text`)
  const buffer = await response.arrayBuffer()
  const raw = new TextDecoder().decode(buffer.byteLength > MAX_FETCH_BYTES ? buffer.slice(0, MAX_FETCH_BYTES) : buffer)
  if (/html|xml/.test(contentType)) {
    const page = htmlToText(raw)
    return { text: page.text, contentType, ...(page.title ? { title: page.title } : {}) }
  }
  return { text: raw, contentType }
}

/** Fetch a page and convert it to text. Only http(s); HTML is converted, text formats are kept. */
export async function fetchPage(
  url: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<FetchedPage> {
  if (!/^https?:\/\//i.test(url)) throw blocked("Only http(s) URLs can be fetched")
  const doFetch = options.fetch ?? fetch
  const allowLoopback = loopbackAllowed(options.env ?? process.env)
  // Redirects are followed one hop at a time so every hop is re-checked:
  // a redirect onto an internal address is refused before it is fetched.
  // The first hop keeps the caller's spelling (like response.url || url
  // before); redirect targets use the normalised absolute form.
  let current = url
  assertRoutable(current, allowLoopback)
  const signal = options.signal ?? AbortSignal.timeout(30_000)
  let response: Response | undefined
  for (let hop = 0; ; hop++) {
    response = await fetchOnce(current, doFetch, signal)
    const next = followRedirect(
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : undefined,
      current,
      url,
      hop,
      allowLoopback,
    )
    if (next === undefined) break
    current = next
  }
  if (response === undefined) throw new Error(`Fetching ${url} failed: no response`)
  if (!response.ok) throw new Error(`Fetching ${url} failed: HTTP ${response.status}`)
  const { text, contentType, title } = await readBody(response)
  return { url: response.url || current, ...(title ? { title } : {}), text, contentType }
}
