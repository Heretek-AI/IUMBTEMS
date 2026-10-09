// Ordered source-backend failover (#106). A `SourceBackend` can search
// and/or fetch; the chain tries them in config order, skipping backends
// without credentials and cooling down backends that just failed. A
// `blocked` refusal is a safety decision (SSRF/policy): it stops the chain,
// never failing over around it. Everything a backend returns still goes
// through the sealed cache in research/ops.ts; this module never touches it.
import {
  braveProvider,
  type FetchedPage,
  fetchPage,
  firecrawlProvider,
  type SearchProvider,
  type SearchResult,
  searxngProvider,
} from "./providers.ts"

export type BackendErrorKind = "unavailable" | "auth" | "rate_limited" | "blocked" | "upstream" | "timeout"

/** A classified backend failure. Only `blocked` stops the chain. */
export class BackendError extends Error {
  readonly kind: BackendErrorKind
  readonly retryAfterMs?: number
  readonly status?: number

  constructor(kind: BackendErrorKind, message: string, options: { retryAfterMs?: number; status?: number } = {}) {
    super(message)
    this.name = "BackendError"
    this.kind = kind
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.status !== undefined) this.status = options.status
  }
}

export interface BackendCapabilities {
  readonly search: boolean
  readonly fetch: boolean
}

export interface BackendSearchOptions {
  readonly limit?: number
  readonly signal?: AbortSignal
  readonly fetch?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
}

export interface BackendFetchOptions {
  readonly signal?: AbortSignal
  readonly fetch?: typeof fetch
}

export interface SourceBackend {
  readonly id: string
  readonly capabilities: BackendCapabilities
  available(env?: NodeJS.ProcessEnv): boolean
  search?(query: string, options: BackendSearchOptions): Promise<SearchResult[]>
  fetch?(url: string, options: BackendFetchOptions): Promise<FetchedPage>
}

const searchBackend = (provider: SearchProvider): SourceBackend => ({
  id: provider.id,
  capabilities: { search: true, fetch: false },
  available: (env) => provider.available(env),
  search: (query, options) => provider.search(query, options),
})

export const braveBackend: SourceBackend = searchBackend(braveProvider)
export const firecrawlBackend: SourceBackend = searchBackend(firecrawlProvider)
export const searxngBackend: SourceBackend = searchBackend(searxngProvider)

/** Today's page fetcher as a backend: always available, fetch-only. */
export const directBackend: SourceBackend = {
  id: "direct",
  capabilities: { search: false, fetch: true },
  available: () => true,
  fetch: (url, options) => fetchPage(url, options),
}

const BUILTINS: Record<string, SourceBackend> = {
  brave: braveBackend,
  firecrawl: firecrawlBackend,
  searxng: searxngBackend,
  direct: directBackend,
}

/** Look up one backend by id; `extra` (tests, and #107's gateway) adds ids. */
export function getBackend(id: string, extra?: readonly SourceBackend[]): SourceBackend | undefined {
  return extra?.find((backend) => backend.id === id) ?? BUILTINS[id]
}

/** Today's selection order, with direct fetch last. */
export const DEFAULT_BACKEND_ORDER: readonly string[] = ["brave", "firecrawl", "searxng", "direct"]

/**
 * Resolve the backend order: explicit `research.backends` wins, a legacy
 * `searchProvider` maps to a one-element search order with direct fetch,
 * and unset config keeps today's provider order.
 */
export function resolveBackendOrder(options: { backends?: readonly string[]; provider?: string }): string[] {
  if (options.backends?.length) return [...options.backends]
  if (options.provider) return [options.provider, "direct"]
  return [...DEFAULT_BACKEND_ORDER]
}

/** Providers whose cached entries hold the whole page (legacy ids included). */
export function isFetchedSnapshot(providerId: string, extra?: readonly SourceBackend[]): boolean {
  return (
    providerId === "fetch" || providerId === "webfetch" || getBackend(providerId, extra)?.capabilities.fetch === true
  )
}

/** Parse a Retry-After header (delay seconds or an HTTP date) to milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  if (!Number.isNaN(at)) return Math.max(0, at - now)
  return undefined
}

/** Classify any thrown value into a chain decision. Unknown errors fail over; only `blocked` stops. */
export function toBackendError(error: unknown): BackendError {
  if (error instanceof BackendError) return error
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
    return new BackendError("timeout", error.message || "The backend request timed out")
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; status?: unknown; retryAfterMs?: unknown; message?: unknown }
    if (record.code === "blocked")
      return new BackendError("blocked", typeof record.message === "string" ? record.message : "Blocked by policy")
    if (typeof record.status === "number") {
      const message = typeof record.message === "string" ? record.message : `HTTP ${record.status}`
      if (record.status === 429)
        return new BackendError("rate_limited", message, {
          ...(typeof record.retryAfterMs === "number" ? { retryAfterMs: record.retryAfterMs } : {}),
          status: record.status,
        })
      if (record.status === 401 || record.status === 403)
        return new BackendError("auth", message, { status: record.status })
      return new BackendError("upstream", message, { status: record.status })
    }
  }
  if (error instanceof TypeError) return new BackendError("unavailable", error.message || "The backend is unreachable")
  return new BackendError("upstream", error instanceof Error ? error.message : "The backend request failed")
}

/** How long a failure keeps a backend out of the chain. */
export function backoffFor(error: BackendError): number {
  if (error.kind === "rate_limited") return error.retryAfterMs ?? 60_000
  return 30_000
}

export interface BackendAttempt {
  readonly backend: string
  readonly ok: boolean
  readonly kind?: BackendErrorKind
}

export interface ChainSuccess<T> {
  readonly value: T
  readonly backend: string
  readonly attempts: BackendAttempt[]
}

export interface ChainOptions {
  /** Clock for cooldowns (tests); default Date.now. */
  readonly now?: () => number
  /**
   * Shared cooldown state (backend id → cooldown expiry and cause). Defaults
   * to a module-level map; the research tools keep one per plugin process so
   * a down backend is not retried on every call.
   */
  readonly cooldowns?: Map<string, { until: number; kind: BackendErrorKind }>
}

const sharedCooldowns = new Map<string, { until: number; kind: BackendErrorKind }>()

const NO_BACKEND =
  "No search provider is configured: set BRAVE_API_KEY, FIRECRAWL_API_KEY or SEARXNG_URL (or fetch known URLs directly)."

async function runChain<T>(
  backends: readonly SourceBackend[],
  kind: "search" | "fetch",
  invoke: (backend: SourceBackend) => Promise<T>,
  options?: ChainOptions,
): Promise<ChainSuccess<T>> {
  const now = options?.now ?? Date.now
  const cooldowns = options?.cooldowns ?? sharedCooldowns
  const attempts: BackendAttempt[] = []
  let lastError: BackendError | undefined
  for (const backend of backends) {
    if (kind === "search" && (!backend.capabilities.search || !backend.search)) continue
    if (kind === "fetch" && (!backend.capabilities.fetch || !backend.fetch)) continue
    const cooling = cooldowns.get(backend.id)
    if (cooling && cooling.until > now()) {
      attempts.push({ backend: backend.id, ok: false, kind: cooling.kind })
      continue
    }
    try {
      const value = await invoke(backend)
      attempts.push({ backend: backend.id, ok: true })
      return { value, backend: backend.id, attempts }
    } catch (error) {
      const classified = toBackendError(error)
      lastError = classified
      attempts.push({ backend: backend.id, ok: false, kind: classified.kind })
      // A safety refusal is never routed around: stop the chain here.
      if (classified.kind === "blocked") throw classified
      cooldowns.set(backend.id, { until: now() + backoffFor(classified), kind: classified.kind })
    }
  }
  throw lastError ?? new BackendError("unavailable", NO_BACKEND)
}

/** Search through the chain in order; availability is checked per call. */
export async function runSearchChain(
  backends: readonly SourceBackend[],
  query: string,
  search: BackendSearchOptions,
  options?: ChainOptions,
): Promise<ChainSuccess<SearchResult[]>> {
  const unavailable = backends
    .filter((backend) => !backend.available(search.env))
    .map((backend) => ({ backend: backend.id, ok: false as const, kind: "unavailable" as BackendErrorKind }))
  const result = await runChain(
    backends.filter((backend) => backend.available(search.env)),
    "search",
    (backend) => backend.search!(query, search),
    options,
  )
  return { ...result, attempts: [...unavailable, ...result.attempts] }
}

/** Fetch through the chain in order; availability is checked per call. */
export async function runFetchChain(
  backends: readonly SourceBackend[],
  url: string,
  options: BackendFetchOptions & ChainOptions & { env?: NodeJS.ProcessEnv },
): Promise<ChainSuccess<FetchedPage>> {
  const { now, cooldowns, env, ...fetchOptions } = options
  const unavailable = backends
    .filter((backend) => !backend.available(env))
    .map((backend) => ({ backend: backend.id, ok: false as const, kind: "unavailable" as BackendErrorKind }))
  const result = await runChain(
    backends.filter((backend) => backend.available(env)),
    "fetch",
    (backend) => backend.fetch!(url, fetchOptions),
    { now, cooldowns },
  )
  return { ...result, attempts: [...unavailable, ...result.attempts] }
}
