// #107: Scraper-Swarm gateway contract tests. Every test replays a
// vendored golden fixture (test/fixtures/scraper-swarm/v1/, from
// scraper-swarm@74909b9) through a stub fetch: no gateway runs here.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BackendError, getBackend, resolveBackendOrder } from "../src/research/backends/index.ts"
import {
  SCRAPER_SWARM_BACKEND_ID,
  SCRAPER_SWARM_CONTRACT_VERSION,
  ScraperSwarmClient,
  scraperSwarmBackend,
} from "../src/research/backends/scraper-swarm.ts"
import { SourceCache } from "../src/research/cache.ts"
import { researchTools } from "../src/research/ops.ts"

const fixtures = path.join(import.meta.dir, "fixtures/scraper-swarm/v1")
const load = async (area: string, name: string) =>
  Bun.file(path.join(fixtures, area, `${name}.json`)).json() as Promise<{
    contract_version: number
    request: unknown
    response_status: number
    response_headers: Record<string, string>
    response_body: unknown
  }>

/** A stub fetch replaying one fixture, asserting the request shape. */
const replay = (
  fixture: {
    request: unknown
    response_status: number
    response_headers: Record<string, string>
    response_body: unknown
  },
  check?: (url: string, init: RequestInit) => void,
  options: { skipName?: boolean } = {},
) =>
  (async (url: string, init?: RequestInit) => {
    check?.(String(url), init ?? {})
    const expected = fixture.request as { method?: string; params?: { name?: string } }
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as {
      jsonrpc?: string
      method?: string
      params?: { name?: string }
    }
    expect(body.jsonrpc).toBe("2.0")
    if (!options.skipName) {
      expect(body.method).toBe(expected.method ?? "tools/call")
      expect(body.params?.name).toBe(expected?.params?.name)
    }
    return new Response(JSON.stringify(fixture.response_body), {
      status: fixture.response_status,
      headers: { ...fixture.response_headers, "content-type": "application/json" },
    })
  }) as unknown as typeof fetch

const env = { ES_SCRAPER_SWARM_URL: "https://swarm.test", ES_SCRAPER_SWARM_TOKEN: "swarm_sec_test" }
const client = (
  fixture: Awaited<ReturnType<typeof load>>,
  check?: (url: string, init: RequestInit) => void,
  options: { skipName?: boolean } = {},
) =>
  new ScraperSwarmClient({
    url: env.ES_SCRAPER_SWARM_URL,
    token: env.ES_SCRAPER_SWARM_TOKEN,
    fetch: replay(fixture, check, options),
  })

/** Exercise a gateway the way the backend would for the fixture's tool. */
const exercise = (gateway: ScraperSwarmClient, tool: string): Promise<unknown> =>
  tool === "web_search"
    ? gateway.search("q", 3).then(
        () => "no-throw",
        (error: unknown) => error,
      )
    : gateway.fetchPage("https://example.com/").then(
        () => "no-throw",
        (error: unknown) => error,
      )

describe("fixture pin", () => {
  test("every vendored fixture targets the client's contract major", async () => {
    const { readdir } = await import("node:fs/promises")
    const areas = await readdir(fixtures)
    let count = 0
    for (const area of areas) {
      if (area === "deep-research" || area === "stealth-scrape") continue
      for (const file of await readdir(path.join(fixtures, area))) {
        if (!file.endsWith(".json")) continue
        const fixture = await load(area, file.replace(/\.json$/, ""))
        expect([`${area}/${file}`, fixture.contract_version]).toEqual([
          `${area}/${file}`,
          SCRAPER_SWARM_CONTRACT_VERSION,
        ])
        count++
      }
    }
    expect(count).toBeGreaterThan(10)
  })
})

describe("gateway mappings", () => {
  test("web_search maps structured results", async () => {
    const results = await client(await load("web-search", "success")).search("recorded query", 2)
    expect(results).toEqual([
      { url: "https://example.com/recorded-1", title: "Recorded One", snippet: "Recorded snippet one." },
      { url: "https://example.com/recorded-2", title: "Recorded Two", snippet: "Recorded snippet two." },
    ])
  })

  test("fetch_page maps the page and verifies content_sha256 before returning", async () => {
    const page = await client(await load("fetch-page", "md-success")).fetchPage("https://example.com/recorded")
    expect(page).toMatchObject({
      url: "https://example.com/recorded",
      title: "Recorded Page",
      text: "# Recorded\n\nRecorded body text.",
      contentType: "text/markdown",
    })
    // A crawl fallback reports its final URL and a null content type.
    const fallback = await client(await load("fetch-page", "crawl-fallback")).fetchPage(
      "https://example.com/needs-crawl",
    )
    expect(fallback).toMatchObject({
      url: "https://example.com/fallback-final",
      title: "Fallback",
      contentType: "text/markdown",
    })
    // A tampered byte fails closed instead of caching.
    const tampered = await load("fetch-page", "md-success")
    const evil = { ...tampered, response_body: JSON.parse(JSON.stringify(tampered.response_body)) } as typeof tampered
    const structured = (evil.response_body as { result: { structuredContent: { content: string } } }).result
      .structuredContent
    structured.content = `${structured.content}tampered`
    await expect(client(evil).fetchPage("https://example.com/recorded")).rejects.toThrow(/content_sha256/)
  })

  test("the Authorization header carries the token; failures never leak it", async () => {
    let seen = ""
    await client(await load("web-search", "success"), (_url, init) => {
      seen = String((init.headers as Record<string, string>)?.Authorization ?? "")
    }).search("q", 1)
    expect(seen).toBe("Bearer swarm_sec_test")
    const denied = client(await load("fetch-page", "ssrf-denied"))
    const failure = await denied.fetchPage("http://169.254.169.254/").catch((error: Error) => error.message)
    expect(failure).toContain("SSRF denied")
    expect(failure).not.toContain("swarm_sec_test")
  })
})

describe("gateway errors", () => {
  const kinds: Array<[string, string, string, boolean?]> = [
    ["fetch-page", "ssrf-denied", "blocked"],
    ["fetch-page", "upstream-timeout", "timeout"],
    ["fetch-page", "upstream-error", "upstream"],
    ["fetch-page", "engine-unavailable", "upstream"],
    ["web-search", "upstream-error", "upstream"],
    ["tools-call", "scope-denied", "auth"],
    ["tools-call", "invalid-params", "upstream"],
    // The client never sends an unknown tool; the response mapping is what matters.
    ["tools-call", "unknown-tool", "upstream", true],
  ]
  for (const [area, name, kind, skipName] of kinds) {
    test(`${area}/${name} maps to ${kind}`, async () => {
      const fixture = await load(area, name)
      const tool = (fixture.request as { params?: { name?: string } }).params?.name ?? "fetch_page"
      const failure = await exercise(client(fixture, undefined, { skipName }), tool)
      expect(failure).toBeInstanceOf(BackendError)
      expect((failure as BackendError).kind).toBe(kind)
    })
  }

  test("429 maps to rate_limited with the Retry-After value", async () => {
    const limited = await load("rate-limited", "rate-limited")
    expect(limited.response_status).toBe(429)
    expect(limited.response_headers["retry-after"]).toBeDefined()
    const failure = await exercise(client(limited, undefined, { skipName: true }), "web_search")
    expect(failure).toBeInstanceOf(BackendError)
    expect((failure as BackendError).kind).toBe("rate_limited")
    // The vendored header is normalized (presence, not value); a real value parses to ms.
    const valued = {
      ...limited,
      response_headers: { ...limited.response_headers, "retry-after": "120" },
    }
    const valuedFailure = (await exercise(client(valued, undefined, { skipName: true }), "web_search")) as BackendError
    expect(valuedFailure.retryAfterMs).toBe(120_000)
  })

  test("an unknown contract major is refused with a clear message", async () => {
    const fixture = await load("web-search", "success")
    const future = {
      ...fixture,
      contract_version: 2,
      response_headers: { ...fixture.response_headers, "x-swarm-contract": "2" },
    }
    const failure = await client(future)
      .search("q", 1)
      .then(
        () => "no-throw",
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(BackendError)
    expect((failure as Error).message).toMatch(/contract/)
  })
})

describe("chain registration", () => {
  test("the backend is available exactly with URL and token, and leads the default order", () => {
    expect(scraperSwarmBackend.id).toBe(SCRAPER_SWARM_BACKEND_ID)
    expect(scraperSwarmBackend.capabilities).toEqual({ search: true, fetch: true })
    expect(scraperSwarmBackend.available(env)).toBe(true)
    expect(scraperSwarmBackend.available({ ...env, ES_SCRAPER_SWARM_TOKEN: "" })).toBe(false)
    expect(scraperSwarmBackend.available({})).toBe(false)
    expect(getBackend("scraper-swarm")?.id).toBe("scraper-swarm")
    expect(resolveBackendOrder({})[0]).toBe("scraper-swarm")
    expect(resolveBackendOrder({ provider: "brave" })).toEqual(["brave", "direct"])
  })

  test("a seat's fetch through the gateway caches sealed provider scraper-swarm without the token", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-swarm-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-swarm-state-"))
    try {
      const tools = researchTools({
        root: dir,
        env,
        stateDir: state,
        policy: async () => ({ root: dir }),
        fetch: replay(await load("fetch-page", "md-success")),
      })
      const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
      const text = await fetchTool.execute({ url: "https://example.com/recorded" }, { agent: "es-research-alpha" })
      const hash = /sha256:([0-9a-f]{64})/.exec(text)?.[1]
      expect(hash).toBeDefined()
      const stored = await new SourceCache(path.join(dir, ".factory/research/sources"), state).get(hash!)
      expect(stored?.meta.provider).toBe("scraper-swarm")
      expect(stored?.meta.seal).toMatch(/^[0-9a-f]{64}$/)
      const metaRaw = await Bun.file(path.join(dir, ".factory/research/sources", `${hash}.json`)).text()
      expect(metaRaw).not.toContain("swarm_sec_test")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})
