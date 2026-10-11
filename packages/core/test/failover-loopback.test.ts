// #188 / #253: failover-chain proof gaps against loopback stubs.
// Real HTTP to 127.0.0.1 only (gateway + SearXNG stubs below); no external
// network. Proves, over the wire: 503 failover + order, 429 with/without
// Retry-After (cooldown skip then retry), auth continuation, blocked stopping
// both chains, sealed provenance, and that the gateway token never leaves its
// Authorization header (every BackendError site + every cache write).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  BackendError,
  type BackendErrorKind,
  backoffFor,
  braveBackend,
  runFetchChain,
  runSearchChain,
  type SourceBackend,
  searxngBackend,
} from "../src/research/backends/index.ts"
import { ScraperSwarmClient, scraperSwarmBackend } from "../src/research/backends/scraper-swarm.ts"
import { SourceCache } from "../src/research/cache.ts"
import { researchTools } from "../src/research/ops.ts"
import { sha256 } from "../src/util/hash.ts"

/** Grep-able canary, never a real secret: every negative asserts its absence. */
const TOKEN = "swarm_canary_9f8e7d6c5b4a"

type GatewayMode =
  | "success-search"
  | "success-fetch"
  | "http-503"
  | "http-429-retry"
  | "http-429-bare"
  | "http-401"
  | "contract-2"
  | "no-body"
  | "rpc-error"
  | "wrong-id"
  | "blocked"
  | "timeout-tool"
  | "upstream-tool"
  | "no-results"
  | "no-content"
  | "sha-mismatch"

type SearxngMode = "success" | "http-503" | "http-429-retry" | "http-429-bare"

let gatewayMode: GatewayMode = "success-search"
let searxngMode: SearxngMode = "success"
let gatewayCalls: Array<{ name: string; auth: string | null }> = []
let searxngHits = 0
let gateway: ReturnType<typeof Bun.serve>
let searxng: ReturnType<typeof Bun.serve>

const FETCH_CONTENT = "Recorded failover body text with enough words to cache."

beforeAll(() => {
  gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 })
      const body = (await req.json().catch(() => undefined)) as
        | { id?: unknown; params?: { name?: string; arguments?: { query?: string } } }
        | undefined
      const name = body?.params?.name ?? ""
      const id = body?.id ?? 1
      gatewayCalls.push({ name, auth: req.headers.get("authorization") })
      const rpc = (result: unknown) =>
        Response.json({ id, jsonrpc: "2.0", result }, { headers: { "x-swarm-contract": "1" } })
      switch (gatewayMode) {
        case "http-503":
          return new Response("unavailable", { status: 503 })
        case "http-429-retry":
          return new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        case "http-429-bare":
          return new Response("slow down", { status: 429 })
        case "http-401":
          return new Response("denied", { status: 401 })
        case "contract-2":
          return Response.json(
            { id, jsonrpc: "2.0", result: { structuredContent: { results: [] } } },
            { headers: { "x-swarm-contract": "2" } },
          )
        case "no-body":
          return Response.json({ hello: 1 }, { headers: { "x-swarm-contract": "1" } })
        case "rpc-error":
          return Response.json(
            { id, jsonrpc: "2.0", error: { code: -32602, message: "bad params" } },
            { headers: { "x-swarm-contract": "1" } },
          )
        case "wrong-id":
          return Response.json(
            { id: 999_999, jsonrpc: "2.0", result: { structuredContent: { results: [] } } },
            { headers: { "x-swarm-contract": "1" } },
          )
        case "blocked":
          return rpc({
            content: [{ type: "text", text: "SSRF denied (fail-closed)" }],
            isError: true,
            structuredContent: { code: "ssrf_denied", message: "SSRF denied (fail-closed)" },
          })
        case "timeout-tool":
          return rpc({
            content: [{ type: "text", text: "engine timed out" }],
            isError: true,
            structuredContent: { code: "upstream_timeout", message: "engine timed out" },
          })
        case "upstream-tool":
          return rpc({
            content: [{ type: "text", text: "engine down" }],
            isError: true,
            structuredContent: { code: "upstream_error", message: "engine down" },
          })
        case "no-results":
          return rpc({ structuredContent: { engine: "stub" } })
        case "no-content":
          return rpc({ structuredContent: { title: "No body" } })
        case "sha-mismatch":
          return rpc({
            structuredContent: {
              content: FETCH_CONTENT,
              content_sha256: sha256("something else entirely"),
              final_url: "https://example.com/recorded",
              title: "Recorded",
              content_type: "text/plain",
            },
          })
        case "success-fetch":
          return rpc({
            structuredContent: {
              content: FETCH_CONTENT,
              content_sha256: sha256(FETCH_CONTENT),
              final_url: "https://example.com/recorded",
              title: "Recorded",
              content_type: "text/plain",
            },
          })
        case "success-search":
          return rpc({
            structuredContent: {
              query: body?.params?.arguments?.query ?? "",
              results: [
                {
                  url: "https://gateway.test/docs",
                  title: "Gateway docs",
                  snippet: "Gateway snippet about the query.",
                },
              ],
            },
          })
        default:
          return rpc({
            structuredContent: {
              query: body?.params?.arguments?.query ?? "",
              results: [
                {
                  url: "https://gateway.test/docs",
                  title: "Gateway docs",
                  snippet: "Gateway snippet about the query.",
                },
              ],
            },
          })
      }
    },
  })
  searxng = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/search") return new Response("not found", { status: 404 })
      searxngHits++
      if (searxngMode === "http-503") return new Response("unavailable", { status: 503 })
      if (searxngMode === "http-429-retry")
        return new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
      if (searxngMode === "http-429-bare") return new Response("slow down", { status: 429 })
      return Response.json({
        results: [
          {
            url: "https://searxng.test/failover-docs",
            title: "Failover docs",
            content: `About ${url.searchParams.get("q")}: gates keep agents honest.`,
          },
        ],
      })
    },
  })
})

afterAll(() => {
  gateway?.stop(true)
  searxng?.stop(true)
})

const reset = () => {
  gatewayCalls = []
  searxngHits = 0
  gatewayMode = "success-search"
  searxngMode = "success"
}

/** Explicit env: ambient keys must not leak in (brave stays unavailable). */
const envFor = (): NodeJS.ProcessEnv => ({
  ES_SCRAPER_SWARM_URL: `http://127.0.0.1:${gateway.port}`,
  ES_SCRAPER_SWARM_TOKEN: TOKEN,
  SEARXNG_URL: `http://127.0.0.1:${searxng.port}`,
})

const clock = (start: number) => {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

const countingFetch = (text: string): { backend: SourceBackend; calls: () => number } => {
  let calls = 0
  return {
    calls: () => calls,
    backend: {
      id: "fallback",
      capabilities: { search: false, fetch: true },
      available: () => true,
      fetch: async (url: string) => {
        calls++
        return { url, text, contentType: "text/plain" }
      },
    },
  }
}

describe("backoffFor defaults (#253.1)", () => {
  test("a 429 Retry-After value wins; a bare 429 cools down for 60s", () => {
    expect(backoffFor(new BackendError("rate_limited", "slow", { retryAfterMs: 5_000 }))).toBe(5_000)
    expect(backoffFor(new BackendError("rate_limited", "slow"))).toBe(60_000)
  })

  test("every other kind cools down for 30s", () => {
    for (const kind of ["unavailable", "auth", "upstream", "timeout", "blocked"] as const)
      expect([kind, backoffFor(new BackendError(kind, "x"))]).toEqual([kind, 30_000])
  })
})

describe("loopback failover through the real backends", () => {
  test("a 503 on the gateway fails over in order; brave is skipped unavailable", async () => {
    reset()
    gatewayMode = "http-503"
    const cooldowns = new Map<string, { until: number; kind: BackendErrorKind }>()
    const result = await runSearchChain(
      [scraperSwarmBackend, braveBackend, searxngBackend],
      "gates",
      {
        env: envFor(),
      },
      { cooldowns },
    )
    expect(result.backend).toBe("searxng")
    // Unavailable backends are reported first (skipped without a call), then
    // the tried backends in order.
    expect(result.attempts).toEqual([
      { backend: "brave", ok: false, kind: "unavailable" },
      { backend: "scraper-swarm", ok: false, kind: "upstream" },
      { backend: "searxng", ok: true },
    ])
    expect(result.value[0]?.snippet).toContain("gates keep agents honest")
    expect(gatewayCalls).toHaveLength(1)
    expect(searxngHits).toBe(1)
  })

  test("a 429 with Retry-After cools down: skipped, then retried after it lapses", async () => {
    reset()
    gatewayMode = "http-429-retry"
    const env = envFor()
    const timer = clock(1_000_000)
    const cooldowns = new Map<string, { until: number; kind: BackendErrorKind }>()
    const first = await runSearchChain(
      [scraperSwarmBackend, searxngBackend],
      "gates",
      { env },
      {
        now: timer.now,
        cooldowns,
      },
    )
    expect(first.backend).toBe("searxng")
    expect(first.attempts[0]).toMatchObject({ backend: "scraper-swarm", ok: false, kind: "rate_limited" })
    expect(gatewayCalls).toHaveLength(1)
    // Still cooling down: skipped without an HTTP call, same failover.
    timer.advance(1_000)
    const skipped = await runSearchChain(
      [scraperSwarmBackend, searxngBackend],
      "gates",
      { env },
      {
        now: timer.now,
        cooldowns,
      },
    )
    expect(skipped.backend).toBe("searxng")
    expect(skipped.attempts[0]).toMatchObject({ backend: "scraper-swarm", ok: false, kind: "rate_limited" })
    expect(gatewayCalls).toHaveLength(1)
    // After the 2s Retry-After lapses the gateway is tried again.
    timer.advance(1_500)
    gatewayMode = "success-search"
    const retried = await runSearchChain(
      [scraperSwarmBackend, searxngBackend],
      "gates",
      { env },
      {
        now: timer.now,
        cooldowns,
      },
    )
    expect(retried.backend).toBe("scraper-swarm")
    expect(gatewayCalls).toHaveLength(2)
  })

  test("a 429 without Retry-After defaults to a 60s cooldown over the wire", async () => {
    reset()
    gatewayMode = "http-429-bare"
    const env = envFor()
    const timer = clock(2_000_000)
    const cooldowns = new Map<string, { until: number; kind: BackendErrorKind }>()
    const run = (at: number) => {
      timer.advance(at)
      return runSearchChain(
        [scraperSwarmBackend, searxngBackend],
        "gates",
        { env },
        {
          now: timer.now,
          cooldowns,
        },
      )
    }
    await run(0)
    expect(gatewayCalls).toHaveLength(1)
    await run(59_000)
    expect(gatewayCalls).toHaveLength(1)
    gatewayMode = "success-search"
    const retried = await run(1_500)
    expect(retried.backend).toBe("scraper-swarm")
    expect(gatewayCalls).toHaveLength(2)
  })

  test("a provider-side 429 maps with and without its Retry-After value", async () => {
    reset()
    searxngMode = "http-429-retry"
    // Fresh cooldown maps: the module-shared default would carry the first
    // 429's cooldown into the second call and skip the backend instead.
    const retrying = await runSearchChain(
      [searxngBackend],
      "gates",
      { env: envFor() },
      {
        cooldowns: new Map(),
      },
    ).then(
      () => "no-throw",
      (error: unknown) => error,
    )
    expect(retrying).toBeInstanceOf(BackendError)
    expect(retrying).toMatchObject({ kind: "rate_limited", retryAfterMs: 2_000 })
    searxngMode = "http-429-bare"
    const bare = await runSearchChain(
      [searxngBackend],
      "gates",
      { env: envFor() },
      {
        cooldowns: new Map(),
      },
    ).then(
      () => "no-throw",
      (error: unknown) => error,
    )
    expect(bare).toBeInstanceOf(BackendError)
    expect(bare).toMatchObject({ kind: "rate_limited" })
    expect((bare as BackendError).retryAfterMs).toBeUndefined()
    expect(backoffFor(bare as BackendError)).toBe(60_000)
  })

  test("a safety block stops the search chain: SearXNG is never called", async () => {
    reset()
    gatewayMode = "blocked"
    const failure = await runSearchChain(
      [scraperSwarmBackend, searxngBackend],
      "gates",
      {
        env: envFor(),
      },
      { cooldowns: new Map() },
    ).then(
      () => "no-throw",
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(BackendError)
    expect(failure).toMatchObject({ kind: "blocked" })
    expect(searxngHits).toBe(0)
  })

  test("a safety block stops the fetch chain: the fallback is never called", async () => {
    reset()
    gatewayMode = "blocked"
    const fallback = countingFetch("never served")
    const failure = await runFetchChain([scraperSwarmBackend, fallback.backend], "https://example.com/x", {
      env: envFor(),
      cooldowns: new Map(),
    }).then(
      () => "no-throw",
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ kind: "blocked" })
    expect(fallback.calls()).toBe(0)
    expect((failure as Error).message).toContain("SSRF denied")
  })

  test("search failover provenance names the serving backend; snippets are not cached", async () => {
    reset()
    gatewayMode = "http-503"
    const dir = await mkdtemp(path.join(tmpdir(), "es-failover-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-failover-state-"))
    try {
      const env = envFor()
      const tools = researchTools({
        root: dir,
        env,
        stateDir: state,
        policy: async () => ({ root: dir }),
        chain: [scraperSwarmBackend, braveBackend, searxngBackend],
      })
      const search = tools.find((tool) => tool.name === "es_research_search")!
      const text = await search.execute({ query: "gates" }, { agent: "es-research-alpha" })
      expect(text).toContain("searxng results for")
      // SearXNG results are snippets, not page content: nothing is cached under them.
      expect(await readdir(path.join(dir, ".factory/research/sources")).catch(() => [] as string[])).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("fetch success through the gateway records sealed scraper-swarm provenance", async () => {
    reset()
    gatewayMode = "success-fetch"
    const dir = await mkdtemp(path.join(tmpdir(), "es-failover-fetch-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-failover-fetch-state-"))
    try {
      const tools = researchTools({
        root: dir,
        env: envFor(),
        stateDir: state,
        policy: async () => ({ root: dir }),
        chain: [scraperSwarmBackend, searxngBackend],
      })
      const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
      const text = await fetchTool.execute(
        { url: "https://example.com/recorded" },
        {
          agent: "es-research-alpha",
        },
      )
      const hash = /sha256:([0-9a-f]{64})/.exec(text)?.[1]
      expect(hash).toBe(sha256(FETCH_CONTENT))
      const stored = await new SourceCache(path.join(dir, ".factory/research/sources"), state).get(hash!)
      expect(stored?.meta.provider).toBe("scraper-swarm")
      expect(stored?.meta.seal).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("auth continues the chain (#253.2)", () => {
  test("a gateway HTTP 401 fails over to SearXNG and cools down", async () => {
    reset()
    gatewayMode = "http-401"
    const env = envFor()
    const timer = clock(3_000_000)
    const cooldowns = new Map<string, { until: number; kind: BackendErrorKind }>()
    const first = await runSearchChain(
      [scraperSwarmBackend, searxngBackend],
      "gates",
      { env },
      {
        now: timer.now,
        cooldowns,
      },
    )
    expect(first.backend).toBe("searxng")
    expect(first.attempts[0]).toMatchObject({ backend: "scraper-swarm", ok: false, kind: "auth" })
    expect(gatewayCalls).toHaveLength(1)
    timer.advance(1_000)
    const second = await runSearchChain(
      [scraperSwarmBackend, searxngBackend],
      "gates",
      { env },
      {
        now: timer.now,
        cooldowns,
      },
    )
    expect(second.backend).toBe("searxng")
    expect(gatewayCalls).toHaveLength(1)
  })

  test("a 401 search error and a 403 fetch error both fail over with a cooldown", async () => {
    let searchCalls = 0
    let fetchCalls = 0
    const authSearch: SourceBackend = {
      id: "auth-search",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async () => {
        searchCalls++
        throw new BackendError("auth", "HTTP 401", { status: 401 })
      },
    }
    const authFetch: SourceBackend = {
      id: "auth-fetch",
      capabilities: { search: false, fetch: true },
      available: () => true,
      fetch: async () => {
        fetchCalls++
        throw new BackendError("auth", "HTTP 403", { status: 403 })
      },
    }
    const goodSearch: SourceBackend = {
      id: "good-search",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async (query: string) => [{ url: `https://good.test/${query}`, title: "Good", snippet: "ok" }],
    }
    const goodFetch = countingFetch("served after auth")
    const timer = clock(4_000_000)
    const searchCooldowns = new Map<string, { until: number; kind: BackendErrorKind }>()
    const searched = await runSearchChain(
      [authSearch, goodSearch],
      "q",
      {},
      {
        now: timer.now,
        cooldowns: searchCooldowns,
      },
    )
    expect(searched.backend).toBe("good-search")
    expect(searched.attempts[0]).toMatchObject({ backend: "auth-search", ok: false, kind: "auth" })
    timer.advance(1_000)
    await runSearchChain([authSearch, goodSearch], "q", {}, { now: timer.now, cooldowns: searchCooldowns })
    expect(searchCalls).toBe(1)
    const fetchCooldowns = new Map<string, { until: number; kind: BackendErrorKind }>()
    const fetched = await runFetchChain([authFetch, goodFetch.backend], "https://good.test/x", {
      now: timer.now,
      cooldowns: fetchCooldowns,
    })
    expect(fetched.backend).toBe("fallback")
    expect(fetched.attempts[0]).toMatchObject({ backend: "auth-fetch", ok: false, kind: "auth" })
    timer.advance(1_000)
    await runFetchChain([authFetch, goodFetch.backend], "https://good.test/x", {
      now: timer.now,
      cooldowns: fetchCooldowns,
    })
    expect(fetchCalls).toBe(1)
  })
})

describe("the token never leaves its Authorization header (#253.3)", () => {
  const client = () =>
    new ScraperSwarmClient({
      url: `http://127.0.0.1:${gateway.port}`,
      token: TOKEN,
      fetch: fetch as unknown as typeof fetch,
    })

  test("every gateway failure message is token-free", async () => {
    const searchModes: GatewayMode[] = [
      "http-401",
      "http-429-bare",
      "http-429-retry",
      "http-503",
      "contract-2",
      "no-body",
      "rpc-error",
      "wrong-id",
      "blocked",
      "timeout-tool",
      "upstream-tool",
      "no-results",
    ]
    const expectedKind: Record<string, BackendErrorKind> = {
      "http-401": "auth",
      "http-429-bare": "rate_limited",
      "http-429-retry": "rate_limited",
      "http-503": "upstream",
      "contract-2": "upstream",
      "no-body": "upstream",
      "rpc-error": "upstream",
      "wrong-id": "upstream",
      blocked: "blocked",
      "timeout-tool": "timeout",
      "upstream-tool": "upstream",
      "no-results": "upstream",
    }
    for (const mode of searchModes) {
      gatewayMode = mode
      const failure = await client()
        .search("q", 1)
        .then(
          () => "no-throw",
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(BackendError)
      expect((failure as BackendError).kind).toBe(expectedKind[mode])
      expect((failure as Error).message).not.toContain(TOKEN)
      expect(JSON.stringify(failure)).not.toContain(TOKEN)
    }
    const fetchModes: GatewayMode[] = ["no-content", "sha-mismatch", "blocked"]
    for (const mode of fetchModes) {
      gatewayMode = mode
      const failure = await client()
        .fetchPage("https://example.com/x")
        .then(
          () => "no-throw",
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(BackendError)
      expect((failure as Error).message).not.toContain(TOKEN)
    }
    // An unreachable gateway and a missing config fail without the token too.
    const down = new ScraperSwarmClient({ url: "http://127.0.0.1:1", token: TOKEN })
    for (const failure of [
      await down.search("q", 1).then(
        () => "no-throw",
        (error: unknown) => error,
      ),
      await down.fetchPage("https://example.com/x").then(
        () => "no-throw",
        (error: unknown) => error,
      ),
    ]) {
      expect(failure).toMatchObject({ kind: "unavailable" })
      expect((failure as Error).message).not.toContain(TOKEN)
    }
    for (const failure of [
      await scraperSwarmBackend.search!("q", { env: {} }).then(
        () => "no-throw",
        (error: unknown) => error,
      ),
      await scraperSwarmBackend.fetch!("https://example.com/x", { env: {} }).then(
        () => "no-throw",
        (error: unknown) => error,
      ),
    ]) {
      expect(failure).toMatchObject({ kind: "unavailable" })
      expect((failure as Error).message).not.toContain(TOKEN)
    }
  })

  test("search-path and fetch-path cache writes hold no token", async () => {
    reset()
    gatewayMode = "success-fetch"
    const dir = await mkdtemp(path.join(tmpdir(), "es-token-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-token-state-"))
    try {
      const contentful: SourceBackend = {
        id: "contentful",
        capabilities: { search: true, fetch: false },
        available: () => true,
        search: async (_query: string) => [
          {
            url: "https://contentful.test/docs",
            title: "Contentful docs",
            snippet: "a snippet",
            content: "Contentful page text about gates, long enough to cache as a snapshot.",
          },
        ],
      }
      const tools = researchTools({
        root: dir,
        env: envFor(),
        stateDir: state,
        policy: async () => ({ root: dir }),
        chain: [contentful, scraperSwarmBackend],
      })
      const search = tools.find((tool) => tool.name === "es_research_search")!
      const searched = await search.execute({ query: "gates" }, { agent: "es-research-alpha" })
      expect(searched).toContain("contentful results for")
      expect(searched).toContain("sha256:")
      const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
      await fetchTool.execute({ url: "https://example.com/recorded" }, { agent: "es-research-alpha" })
      const sources = path.join(dir, ".factory/research/sources")
      const files = await readdir(sources)
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) expect(await readFile(path.join(sources, file), "utf8")).not.toContain(TOKEN)
      // The only wire presence of the token is the Authorization header.
      expect(gatewayCalls.length).toBeGreaterThan(0)
      for (const call of gatewayCalls) expect(call.auth).toBe(`Bearer ${TOKEN}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})
