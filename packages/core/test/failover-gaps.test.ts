// #253: failover proof gaps. Direct pins for `backoffFor` defaults, the
// `auth`-kind chain continuation (failover + cooldown, not a stop), and
// token-absence exhaustiveness: every gateway failure message, both
// tool-output paths and every cache write carry no token. Wire-level
// exclusivity (bytes on the socket) needs a live-network capture and stays
// out of scope for unit tests.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  backoffFor,
  BackendError,
  runFetchChain,
  runSearchChain,
  type SourceBackend,
} from "../src/research/backends/index.ts"
import { ScraperSwarmClient } from "../src/research/backends/scraper-swarm.ts"
import { researchTools } from "../src/research/ops.ts"
import { sha256 } from "../src/util/hash.ts"

const TOKEN = "swarm_sec_probe_token"
const ENV = { ES_SCRAPER_SWARM_URL: "https://swarm.test", ES_SCRAPER_SWARM_TOKEN: TOKEN }

describe("backoffFor defaults (backends/index.ts:159-162, #253.1)", () => {
  test("rate_limited without Retry-After cools down 60s; an explicit value wins", () => {
    expect(backoffFor(new BackendError("rate_limited", "slow down"))).toBe(60_000)
    expect(backoffFor(new BackendError("rate_limited", "slow down", { retryAfterMs: 5_000 }))).toBe(5_000)
    expect(backoffFor(new BackendError("rate_limited", "slow down", { retryAfterMs: 0 }))).toBe(0)
  })

  test("every other kind cools down 30s", () => {
    for (const kind of ["unavailable", "auth", "blocked", "upstream", "timeout"] as const)
      expect([kind, backoffFor(new BackendError(kind, "x"))]).toEqual([kind, 30_000])
  })
})

describe("auth-kind chain continuation (#253.2)", () => {
  const goodSearch: SourceBackend = {
    id: "good",
    capabilities: { search: true, fetch: false },
    available: () => true,
    search: async (query: string) => [{ url: `https://good.test/${query}`, title: "Good", snippet: "ok" }],
  }
  const goodFetch: SourceBackend = {
    id: "steady",
    capabilities: { search: false, fetch: true },
    available: () => true,
    fetch: async (url: string) => ({ url, text: "Steady page body with enough text.", contentType: "text/plain" }),
  }

  test("a leading 401 fails over on search and cools the backend down", async () => {
    const denied: SourceBackend = {
      id: "gateway",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async () => {
        throw new BackendError("auth", "gateway refused: HTTP 401", { status: 401 })
      },
    }
    const cooldowns = new Map<string, { until: number; kind: BackendError["kind"] }>()
    const result = await runSearchChain([denied, goodSearch], "q", {}, { now: () => 1_000_000, cooldowns })
    expect(result.backend).toBe("good")
    expect(result.attempts).toEqual([
      { backend: "gateway", ok: false, kind: "auth" },
      { backend: "good", ok: true },
    ])
    expect(cooldowns.get("gateway")).toEqual({ until: 1_030_000, kind: "auth" })
  })

  test("a leading 403 fails over on fetch and cools the backend down", async () => {
    const denied: SourceBackend = {
      id: "gateway",
      capabilities: { search: false, fetch: true },
      available: () => true,
      fetch: async () => {
        throw new BackendError("auth", "gateway refused: HTTP 403", { status: 403 })
      },
    }
    const cooldowns = new Map<string, { until: number; kind: BackendError["kind"] }>()
    const result = await runFetchChain([denied, goodFetch], "https://x.test/p", {
      now: () => 2_000_000,
      cooldowns,
    })
    expect(result.backend).toBe("steady")
    expect(result.attempts).toEqual([
      { backend: "gateway", ok: false, kind: "auth" },
      { backend: "steady", ok: true },
    ])
    expect(cooldowns.get("gateway")).toEqual({ until: 2_030_000, kind: "auth" })
  })
})

describe("token absence exhaustiveness (#253.3)", () => {
  const jsonRpc = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-swarm-contract": "1", ...headers },
    })
  const stubFetch = (respond: (url: string, init: RequestInit) => Response, seen: { auth: string }) =>
    (async (url: string, init?: RequestInit) => {
      seen.auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "")
      return respond(String(url), init ?? {})
    }) as unknown as typeof fetch
  const client = (respond: (url: string, init: RequestInit) => Response, seen: { auth: string }) =>
    new ScraperSwarmClient({ url: ENV.ES_SCRAPER_SWARM_URL, token: TOKEN, fetch: stubFetch(respond, seen) })
  const failure = (promise: Promise<unknown>): Promise<Error> =>
    promise.then(
      () => new Error("no-throw"),
      (error: unknown) => error as Error,
    )

  test("the Authorization header carries the token on search and fetch", async () => {
    const seen = { auth: "" }
    const ok = {
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: { results: [{ url: "https://a.test", title: "A", snippet: "s" }] } },
    }
    await client(() => jsonRpc(ok), seen).search("q", 1)
    expect(seen.auth).toBe(`Bearer ${TOKEN}`)
    const content = "# Title\n\nPage body text."
    const page = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        structuredContent: { content, content_sha256: sha256(content), title: "T", format: "markdown" },
      },
    }
    await client(() => jsonRpc(page), seen).fetchPage("https://a.test")
    expect(seen.auth).toBe(`Bearer ${TOKEN}`)
  })

  test("no gateway failure message carries the token", async () => {
    const cases: Array<[string, (seen: { auth: string }) => Promise<unknown>, string]> = [
      ["http-401", (seen) => client(() => jsonRpc({ detail: "nope" }, 401), seen).search("q", 1), "auth"],
      ["http-403", (seen) => client(() => jsonRpc({ detail: "nope" }, 403), seen).fetchPage("https://a.test"), "auth"],
      [
        "http-429",
        (seen) => client(() => jsonRpc({ detail: "slow" }, 429, { "retry-after": "7" }), seen).search("q", 1),
        "rate_limited",
      ],
      ["http-500", (seen) => client(() => jsonRpc({ detail: "boom" }, 500), seen).search("q", 1), "upstream"],
      [
        "contract",
        (seen) => client(() => jsonRpc({ jsonrpc: "2.0", id: 1, result: {} }, 200, { "x-swarm-contract": "9" }), seen).search("q", 1),
        "upstream",
      ],
      [
        "ssrf-denied",
        (seen) =>
          client(
            () =>
              jsonRpc({
                jsonrpc: "2.0",
                id: 1,
                result: { isError: true, structuredContent: { code: "ssrf_denied", message: "SSRF denied" } },
              }),
            seen,
          ).fetchPage("https://a.test"),
        "blocked",
      ],
      [
        "blocked-by-policy",
        (seen) =>
          client(
            () =>
              jsonRpc({
                jsonrpc: "2.0",
                id: 1,
                result: { isError: true, structuredContent: { code: "blocked_by_policy", message: "denied" } },
              }),
            seen,
          ).search("q", 1),
        "blocked",
      ],
      [
        "upstream-timeout",
        (seen) =>
          client(
            () =>
              jsonRpc({
                jsonrpc: "2.0",
                id: 1,
                result: { isError: true, structuredContent: { code: "upstream_timeout", message: "slow" } },
              }),
            seen,
          ).search("q", 1),
        "timeout",
      ],
      [
        "tool-upstream",
        (seen) =>
          client(
            () => jsonRpc({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }),
            seen,
          ).search("q", 1),
        "upstream",
      ],
      [
        "unreachable",
        (seen) =>
          new ScraperSwarmClient({
            url: ENV.ES_SCRAPER_SWARM_URL,
            token: TOKEN,
            fetch: (async () => {
              seen.auth = "unreached"
              throw new TypeError("fetch failed")
            }) as unknown as typeof fetch,
          }).search("q", 1),
        "unavailable",
      ],
    ]
    for (const [name, run, kind] of cases) {
      const seen = { auth: "" }
      const error = await failure(run(seen))
      if (!(error instanceof BackendError)) throw new Error(`${name}: expected a BackendError, got ${error}`)
      expect([name, error.kind]).toEqual([name, kind])
      expect([name, error.message.includes(TOKEN)]).toEqual([name, false])
    }
  })

  test("search and fetch tool outputs and every cache write carry no token", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-token-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-token-state-"))
    try {
      // Drive the real client through the tools: search (no content cached)
      // then fetch (page cached sealed as scraper-swarm).
      const content = "# Recorded\n\nRecorded body text for the token probe."
      const searchBody = {
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { results: [{ url: "https://a.test/p", title: "A", snippet: "s" }] } },
      }
      const pageBody = {
        jsonrpc: "2.0",
        id: 1,
        result: {
          structuredContent: { content, content_sha256: sha256(content), title: "P", format: "markdown" },
        },
      }
      let n = 0
      const replay = (async () => {
        n++
        return jsonRpc(n === 1 ? searchBody : pageBody)
      }) as unknown as typeof fetch
      const tools = researchTools({
        root: dir,
        env: ENV,
        stateDir: state,
        policy: async () => ({ root: dir }),
        fetch: replay,
      })
      const search = tools.find((tool) => tool.name === "es_research_search")!
      const searchText = await search.execute({ query: "token probe" }, { agent: "es-research-alpha" })
      expect(searchText.includes(TOKEN)).toBe(false)
      // The search chain resolves the default order; scraper-swarm leads when
      // configured, so this output names the serving backend.
      expect(searchText).toContain("scraper-swarm results for")
      const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
      const fetchText = await fetchTool.execute({ url: "https://a.test/p" }, { agent: "es-research-alpha" })
      expect(fetchText.includes(TOKEN)).toBe(false)
      // Every cache write (meta JSON) is token-free.
      const cacheDir = path.join(dir, ".factory/research/sources")
      for (const name of await readdir(cacheDir)) {
        if (!name.endsWith(".json") || name === "index.json") continue
        const raw = await Bun.file(path.join(cacheDir, name)).text()
        expect([name, raw.includes(TOKEN)]).toEqual([name, false])
      }
      const indexRaw = await Bun.file(path.join(cacheDir, "index.json")).text()
      expect(indexRaw.includes(TOKEN)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})
