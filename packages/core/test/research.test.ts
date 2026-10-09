import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  auditMarkdown,
  BackendError,
  braveProvider,
  canonicalUrl,
  directBackend,
  fetchPage,
  firecrawlProvider,
  htmlToText,
  isFresh,
  locateQuote,
  normalizeForQuote,
  normalizeWithMap,
  parseTags,
  pruneClaims,
  researchTools,
  runFetchChain,
  type SourceBackend,
  SourceCache,
  searxngProvider,
  selectProvider,
  ttlDays,
  verifyQuote,
} from "../src/index.ts"

let dir: string
let cache: SourceCache
let state: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "es-research-"))
  cache = new SourceCache(path.join(dir, "sources"))
  state = await mkdtemp(path.join(tmpdir(), "es-research-state-"))
})
afterEach(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]))

const SOURCE =
  "Bun is a fast all-in-one JavaScript runtime.\nIt ships a test runner, a bundler, and a package manager — all built in."

describe("verbatim quotes", () => {
  test("exact after whitespace and typography normalisation; ellipsis fragments in order", () => {
    expect(verifyQuote(SOURCE, "fast all-in-one JavaScript runtime").ok).toBe(true)
    expect(verifyQuote(SOURCE, "a bundler,   and a package\nmanager")).toMatchObject({ ok: true })
    expect(verifyQuote("He said “hello world, friends”", 'said "hello world, friends"').ok).toBe(true)
    expect(verifyQuote(SOURCE, "fast all-in-one ... a package manager").ok).toBe(true)
    expect(verifyQuote(SOURCE, "a package manager ... fast all-in-one").ok).toBe(false)
    expect(verifyQuote(SOURCE, "a slow runtime for JavaScript").ok).toBe(false)
    expect(verifyQuote(SOURCE, "Bun").reason).toContain("too short")
  })

  test("every ellipsis fragment must be evidence on its own (12+ characters)", () => {
    // Before 1.1.1 only the joined fragments had to reach 12 characters, so
    // single letters matched almost any text (issue #38).
    expect(verifyQuote(SOURCE, "a ... a ... a ... a ... a ... a ... a").ok).toBe(false)
    expect(verifyQuote(SOURCE, "a ... a ... a ... a ... a ... a ... a").reason).toContain("fragment")
    expect(verifyQuote(SOURCE, "Bun is a fast ... manager").ok).toBe(false)
    expect(verifyQuote(SOURCE, "Bun is a fast all-in-one ... a package manager").ok).toBe(true)
  })

  test("locateQuote returns original-text ranges that normalise to the fragments", () => {
    const single = locateQuote(SOURCE, "fast all-in-one JavaScript runtime")
    expect(single).toHaveLength(1)
    expect(SOURCE.slice(single![0]!.start, single![0]!.end)).toBe("fast all-in-one JavaScript runtime")
    const curly = locateQuote("He said “hello world, friends”", 'said "hello world, friends"')
    expect(curly).toHaveLength(1)
    const curlySlice = "He said “hello world, friends”".slice(curly![0]!.start, curly![0]!.end)
    expect(curlySlice).toContain("“hello world, friends”")
    expect(normalizeForQuote(curlySlice)).toBe('said "hello world, friends"')
    const linked = locateQuote("[Bun](https://bun.sh) is fast and furious", "Bun is fast and furious")
    expect(linked).toHaveLength(2)
    expect("[Bun](https://bun.sh) is fast and furious".slice(linked![0]!.start, linked![0]!.end)).toBe("Bun")
    expect("[Bun](https://bun.sh) is fast and furious".slice(linked![1]!.start, linked![1]!.end)).toBe(
      " is fast and furious",
    )
    const two = locateQuote(SOURCE, "fast all-in-one ... a package manager")
    expect(two).toHaveLength(2)
    expect(two![0]!.end).toBeLessThanOrEqual(two![1]!.start)
    for (const range of two!) expect(SOURCE.slice(range.start, range.end).length).toBeGreaterThan(0)
  })

  test("locateQuote refuses what verifyQuote refuses", () => {
    expect(locateQuote(SOURCE, "Bun")).toBeUndefined()
    expect(locateQuote(SOURCE, "a slow runtime for JavaScript")).toBeUndefined()
    expect(locateQuote(SOURCE, "a package manager ... fast all-in-one")).toBeUndefined()
  })

  test("normalizeWithMap agrees with normalizeForQuote character for character", () => {
    const cases = [
      SOURCE,
      "He said “hello” — yes…  really",
      "[Bun](https://bun.sh) is **fast** and `lean`",
      "  spaced\t\tout\n\nlines  ",
      "NBSP here and　fullwidth",
      "café ﬁligree",
    ]
    for (const text of cases) expect(normalizeWithMap(text).text).toBe(normalizeForQuote(text))
  })
})

describe("source cache", () => {
  test("content-addressed, deduplicated, URL-indexed; tampered sources are refused; uncited ones pruned", async () => {
    const one = await cache.put({ url: "https://a.test", text: SOURCE, provider: "fetch" })
    const two = await cache.put({ url: "https://b.test", text: `${SOURCE}\r\n`, provider: "fetch" })
    expect(two.meta.sha256).toBe(one.meta.sha256)
    expect((await cache.byUrl("https://a.test"))?.text).toBe(SOURCE)
    await writeFile(one.path, "tampered")
    expect(await cache.get(one.meta.sha256)).toBeUndefined()
    const other = await cache.put({
      url: "https://c.test",
      text: "Another source with enough text.",
      provider: "fetch",
    })
    expect(await cache.prune(new Set([other.meta.sha256]))).toEqual([one.meta.sha256])
    expect(await cache.list()).toEqual([other.meta.sha256])
  })

  test("HTML becomes quotable text", () => {
    const page = htmlToText(
      '<html><head><title>Docs &amp; more</title><script>evil()</script></head><body><nav>menu</nav><h1>Install</h1><p>Run <code>bun add zod</code> to <a href="https://x.test">install</a>.</p><ul><li>One</li><li>Two</li></ul></body></html>',
    )
    expect(page.title).toBe("Docs & more")
    expect(page.text).toContain("# Install")
    expect(page.text).toContain("Run `bun add zod` to [install](https://x.test).")
    expect(page.text).toContain("- One")
    expect(page.text).not.toContain("evil")
    expect(page.text).not.toContain("menu")
  })

  test("engine seal (#52): sealed entries verify; planted unsealed ones are refused", async () => {
    const sealed = new SourceCache(path.join(dir, "sealed"), state)
    const entry = await sealed.put({ url: "https://s.test", text: SOURCE, provider: "fetch" })
    expect(entry.meta.seal).toMatch(/^[0-9a-f]{64}$/)
    expect((await sealed.get(entry.meta.sha256))?.text).toBe(SOURCE)
    expect((await sealed.byUrl("https://s.test"))?.meta.sha256).toBe(entry.meta.sha256)
    // A forged entry planted before the factory dir existed has no seal.
    const planted = new SourceCache(path.join(dir, "planted"), state)
    const forged = await new SourceCache(path.join(dir, "forged")).put({
      url: "https://evil.test",
      text: SOURCE,
      provider: "fetch",
    })
    const { atomicWrite } = await import("../src/util/fs.ts")
    const { sha256 } = await import("../src/util/hash.ts")
    const { readFile } = await import("node:fs/promises")
    await atomicWrite(path.join(dir, "planted", `${forged.meta.sha256}.md`), await readFile(forged.path, "utf8"))
    await atomicWrite(
      path.join(dir, "planted", `${forged.meta.sha256}.json`),
      `${JSON.stringify({ ...forged.meta, sha256: forged.meta.sha256 })}\n`,
    )
    expect(sha256(SOURCE)).toBe(forged.meta.sha256)
    expect(await planted.get(forged.meta.sha256)).toBeUndefined()
    expect(await planted.byUrl("https://evil.test")).toBeUndefined()
    // Legacy readers without a state dir keep the old behaviour.
    expect((await new SourceCache(path.join(dir, "forged")).get(forged.meta.sha256))?.text).toBe(SOURCE)
  })
})

describe("auditor", () => {
  test("parses tags including a VERIFIED source and quote", () => {
    const tags = parseTags(
      `Bun bundles tools [VERIFIED: sha256:${"a".repeat(64)} "a test runner"] [INFERRED: so one fewer dependency]`,
    )
    expect(tags.map((tag) => tag.kind)).toEqual(["VERIFIED", "INFERRED"])
    expect(tags[0]).toMatchObject({ source: "a".repeat(64), quote: "a test runner" })
    // Brackets inside a tag body (a quote citing "[1]") stay in the body.
    const nested = parseTags(
      `x [VERIFIED: sha256:${"b".repeat(64)} "as shown in [1] and [2]"] [HYPOTHESIS: rerun [n=3]]`,
    )
    expect(nested[0]).toMatchObject({ kind: "VERIFIED", quote: "as shown in [1] and [2]" })
    expect(nested[1]).toMatchObject({ kind: "HYPOTHESIS", body: "rerun [n=3]" })
  })

  test("grounded, ungrounded, untagged and malformed claims; headings, code and tables are not claims", async () => {
    const source = await cache.put({ url: "https://bun.test", text: SOURCE, provider: "fetch" })
    const report = [
      "# Findings",
      "",
      `- Bun includes a test runner [VERIFIED: sha256:${source.meta.sha256} "It ships a test runner"]`,
      `- Bun is slow [VERIFIED: sha256:${source.meta.sha256} "Bun is a slow runtime"]`,
      "- Bun is popular",
      "- Something [VERIFIED: no quote]",
      "- Fewer tools to install [INFERRED: one binary covers runner and bundler]",
      "- [NEGATIVE_KNOWLEDGE: searched for Bun on Windows ARM support]",
      "",
      "```",
      "not a claim",
      "```",
      "| a | b |",
    ].join("\n")
    const audit = await auditMarkdown(report, cache)
    expect(audit.coverage).toMatchObject({ claims: 6, grounded: 3, ungrounded: 1, untagged: 1, malformed: 1 })
    expect(audit.passed).toBe(false)
    expect(audit.cited).toEqual([source.meta.sha256])
    const pruned = pruneClaims(report, audit)
    expect(pruned).toContain("## Pruned claims")
    expect(pruned).toContain("> - Bun is popular")
    const again = await auditMarkdown(pruned, cache)
    expect(again.passed).toBe(true)
    expect(again.coverage.claims).toBe(3)
  })
})

describe("providers", () => {
  const fakeFetch = (body: unknown, check?: (url: string, init?: RequestInit) => void) =>
    (async (url: string, init?: RequestInit) => {
      check?.(String(url), init)
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch

  test("Brave, Firecrawl and SearXNG responses parse to results; selection follows the environment", async () => {
    const brave = await braveProvider.search("q", {
      fetch: fakeFetch(
        { web: { results: [{ url: "https://a", title: "A", description: "<b>x</b> y" }] } },
        (_url, init) => expect(((init?.headers ?? {}) as Record<string, string>)["X-Subscription-Token"]).toBe("k"),
      ),
      env: { BRAVE_API_KEY: "k" },
    })
    expect(brave).toEqual([{ url: "https://a", title: "A", snippet: "x y" }])
    const fire = await firecrawlProvider.search("q", {
      fetch: fakeFetch({ data: [{ url: "https://b", title: "B", description: "d", markdown: "# full" }] }),
      env: { FIRECRAWL_API_KEY: "k" },
    })
    expect(fire[0]).toMatchObject({ url: "https://b", content: "# full" })
    const searx = await searxngProvider.search("q", {
      fetch: fakeFetch({ results: [{ url: "https://c", title: "C", content: "s" }] }),
      env: { SEARXNG_URL: "http://localhost:8888/" },
    })
    expect(searx[0]?.url).toBe("https://c")
    expect(selectProvider(undefined, { SEARXNG_URL: "x" })?.id).toBe("searxng")
    expect(selectProvider("brave", { SEARXNG_URL: "x" })).toBeUndefined()
    expect(selectProvider(undefined, {})).toBeUndefined()
  })

  test("the fetch tool caches a page and tells the agent how to cite it", async () => {
    const html =
      "<html><head><title>Zod</title></head><body><p>Zod is a TypeScript-first schema validation library.</p></body></html>"
    const tools = researchTools({
      root: dir,
      env: {},
      stateDir: state,
      policy: async () => ({ root: dir }),
      fetch: (async () => new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
    })
    const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
    const text = await fetchTool.execute({ url: "https://zod.test" }, { agent: "es-research-alpha" })
    const hash = /sha256:([0-9a-f]{64})/.exec(text)?.[1]
    expect(hash).toBeDefined()
    const stored = await new SourceCache(path.join(dir, ".factory/research/sources")).get(hash!)
    expect(stored?.text).toContain("TypeScript-first schema validation")
    const search = tools.find((tool) => tool.name === "es_research_search")!
    await expect(search.execute({ query: "x" }, { agent: "es-research-alpha" })).rejects.toThrow("No search provider")
  })
})

describe("the webcache gate (d66328c:skills/epistemic_search/scripts/webcache.py)", () => {
  test("canonicalUrl matches the legacy canonical_url on every fixture case", async () => {
    const fixture = (await Bun.file(path.join(import.meta.dir, "fixtures/canonical-urls.json")).json()) as {
      cases: Array<{ url: string; canonical: string | null }>
    }
    expect(fixture.cases.length).toBeGreaterThan(20)
    for (const item of fixture.cases)
      expect([item.url, canonicalUrl(item.url) ?? null]).toEqual([item.url, item.canonical])
  })

  test("pages stay fresh 7 days, documentation hosts 30, unless overridden (ttl_days, is_fresh)", () => {
    const now = new Date("2026-10-07T00:00:00Z")
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
    expect([
      ttlDays("https://example.com/x"),
      ttlDays("https://docs.python.org/3/"),
      ttlDays("https://a.developer.mozilla.org/"),
    ]).toEqual([7, 30, 30])
    expect(ttlDays("https://docs.python.org/3/", 2)).toBe(2)
    expect(isFresh(daysAgo(7), "https://example.com/x", { now })).toBe(true)
    expect(isFresh(daysAgo(8), "https://example.com/x", { now })).toBe(false)
    expect(isFresh(daysAgo(20), "https://docs.python.org/3/", { now })).toBe(true)
    expect(isFresh("not a date", "https://example.com/x", { now })).toBe(false)
  })

  test("a fresh snapshot of the same canonical URL is served without the network; refresh or staleness fetches", async () => {
    let calls = 0
    let now = new Date("2026-10-07T00:00:00Z")
    const tools = researchTools({
      root: dir,
      env: {},
      stateDir: state,
      policy: async () => ({ root: dir }),
      now: () => now,
      fetch: (async () => {
        calls++
        return new Response(`<p>Version ${calls} of the page says the limit is ten requests per second.</p>`, {
          headers: { "content-type": "text/html" },
        })
      }) as unknown as typeof fetch,
    })
    const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
    const first = await fetchTool.execute({ url: "https://Limits.test/api?b=2&a=1" }, { agent: "es-research-alpha" })
    expect(first).toContain("Cached https://Limits.test/api?b=2&a=1")
    // Different spelling, same canonical URL: served from the cache.
    const second = await fetchTool.execute(
      { url: "https://limits.test:443/api?a=1&b=2#top" },
      { agent: "es-research-alpha" },
    )
    expect(second).toContain("from the cache")
    expect(second).toContain("Version 1 of the page")
    expect(calls).toBe(1)
    expect(
      await fetchTool.execute(
        { url: "https://limits.test/api?a=1&b=2", refresh: true },
        { agent: "es-research-alpha" },
      ),
    ).toContain("Version 2")
    now = new Date("2026-10-20T00:00:00Z")
    expect(
      await fetchTool.execute({ url: "https://limits.test/api?a=1&b=2" }, { agent: "es-research-alpha" }),
    ).toContain("Version 3")
    expect(calls).toBe(3)
    // A search result cached under the page's URL is a snippet, never served as the page.
    await new SourceCache(path.join(dir, ".factory/research/sources")).put({
      url: "https://limits.test/api?a=1&b=2",
      text: "Snippet: limits are documented.",
      provider: "searxng",
    })
    expect(
      await fetchTool.execute({ url: "https://limits.test/api?a=1&b=2" }, { agent: "es-research-alpha" }),
    ).toContain("Version 4")
  })
})

describe("research seat checks (#99: the registry grants, not the caller, decide)", () => {
  const tools = () =>
    researchTools({
      root: dir,
      env: {},
      stateDir: state,
      policy: async () => ({ root: dir }),
    })
  const tool = (name: string) => tools().find((item) => item.name === name)!

  test("search and fetch refuse seats the registry never grants; granted seats pass the check", async () => {
    const search = tool("es_research_search")
    const fetch = tool("es_research_fetch")
    // The factory seat may audit but never search or fetch.
    await expect(search.execute({ query: "x" }, { agent: "factory" })).rejects.toThrow(
      "Only the research and scout seats",
    )
    await expect(fetch.execute({ url: "https://x.test" }, { agent: "factory" })).rejects.toThrow(
      "Only the research and scout seats",
    )
    await expect(fetch.execute({ url: "https://x.test" }, { agent: "es-programmer" })).rejects.toThrow(
      "Only the research and scout seats",
    )
    // A granted seat passes the seat check (then fails on the missing provider, before any fetch).
    await expect(search.execute({ query: "x" }, { agent: "es-research-alpha" })).rejects.toThrow("No search provider")
    await expect(search.execute({ query: "x" }, { agent: "scout" })).rejects.toThrow("No search provider")
  })

  test("audit refuses seats the registry never grants; granted seats pass the check", async () => {
    const audit = tool("es_research_audit")
    await expect(audit.execute({}, { agent: "scout" })).rejects.toThrow("Only the research seats and factory")
    await expect(audit.execute({}, { agent: "es-programmer" })).rejects.toThrow("Only the research seats and factory")
    // A granted seat passes the seat check (then reports the missing report, not a refusal).
    expect(await audit.execute({}, { agent: "factory" })).toContain("does not exist yet")
    expect(await audit.execute({}, { agent: "es-research-beta" })).toContain("does not exist yet")
  })
})

describe("direct-backend SSRF guard (fail closed, never cached)", () => {
  const countingFetch = (respond: (url: string) => Response, calls: { count: number }) =>
    (async (url: string) => {
      calls.count++
      return respond(String(url))
    }) as unknown as typeof fetch

  test("fetchPage refuses loopback, link-local and RFC1918 URLs without fetching", async () => {
    const internal = [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1/admin",
      "http://10.0.0.5/secret",
      "http://192.168.1.10:8080/secret",
      "http://172.16.4.9/secret",
      "http://localhost/secret",
      "http://[::1]/secret",
    ]
    for (const url of internal) {
      const calls = { count: 0 }
      const failure = await fetchPage(url, { fetch: countingFetch(() => new Response("x"), calls) }).then(
        () => "no-throw",
        (error: unknown) => error,
      )
      expect([url, (failure as { code?: string })?.code]).toEqual([url, "blocked"])
      expect([url, calls.count]).toEqual([url, 0])
    }
  })

  test("fetching the metadata URL via direct throws blocked and caches nothing", async () => {
    const calls = { count: 0 }
    const fetch = countingFetch(
      () => new Response("<p>metadata</p>", { headers: { "content-type": "text/html" } }),
      calls,
    )
    const failure = await runFetchChain([directBackend], "http://169.254.169.254/latest/meta-data/", {
      fetch,
    }).then(
      () => "no-throw",
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(BackendError)
    expect((failure as BackendError).kind).toBe("blocked")
    expect(calls.count).toBe(0)
  })

  test("the loopback allowance admits fixture servers but never the metadata address", async () => {
    const ok = { count: 0 }
    const page = await fetchPage("http://127.0.0.1:18381/a", {
      fetch: countingFetch(() => new Response("<p>fixture</p>", { headers: { "content-type": "text/html" } }), ok),
      env: { ES_RESEARCH_ALLOW_LOOPBACK: "1" },
    })
    expect(page.text).toContain("fixture")
    expect(ok.count).toBe(1)
    // Link-local stays refused even with the allowance on, and nothing is fetched.
    const refused = { count: 0 }
    const failure = await fetchPage("http://169.254.169.254/latest/meta-data/", {
      fetch: countingFetch(() => new Response("<p>metadata</p>"), refused),
      env: { ES_RESEARCH_ALLOW_LOOPBACK: "1" },
    }).then(
      () => "no-throw",
      (error: unknown) => error,
    )
    expect((failure as { code?: string })?.code).toBe("blocked")
    expect(refused.count).toBe(0)
  })

  test("a blocked refusal from an earlier backend stops the chain before direct is attempted", async () => {
    const calls = { count: 0 }
    const denyAll: SourceBackend = {
      id: "deny",
      capabilities: { search: false, fetch: true },
      available: () => true,
      fetch: async () => {
        throw Object.assign(new Error("denied by policy"), { code: "blocked" })
      },
    }
    const failure = await runFetchChain([denyAll, directBackend], "https://example.com/page", {
      fetch: countingFetch(() => new Response("<p>ok</p>", { headers: { "content-type": "text/html" } }), calls),
    }).then(
      () => "no-throw",
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(BackendError)
    expect((failure as BackendError).kind).toBe("blocked")
    expect(calls.count).toBe(0)
  })

  test("a redirect onto an internal address is refused and never fetched or cached", async () => {
    const seen: string[] = []
    const fetch = (async (url: string) => {
      seen.push(String(url))
      return new Response("<p>go inward</p>", {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/", "content-type": "text/html" },
      })
    }) as unknown as typeof fetch
    const failure = await fetchPage("https://example.com/out", { fetch }).then(
      () => "no-throw",
      (error: unknown) => error,
    )
    expect((failure as { code?: string })?.code).toBe("blocked")
    expect(seen).toEqual(["https://example.com/out"])
  })

  test("the fetch tool refuses a metadata URL without fetching or caching it", async () => {
    const calls = { count: 0 }
    const tools = researchTools({
      root: dir,
      env: {},
      stateDir: state,
      policy: async () => ({ root: dir }),
      fetch: countingFetch(() => new Response("<p>metadata</p>", { headers: { "content-type": "text/html" } }), calls),
    })
    const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
    await expect(
      fetchTool.execute({ url: "http://169.254.169.254/latest/meta-data/" }, { agent: "es-research-alpha" }),
    ).rejects.toThrow(/non-routable|blocked|SSRF/i)
    expect(calls.count).toBe(0)
    expect(
      await new SourceCache(path.join(dir, ".factory/research/sources"), state).byUrl(
        "http://169.254.169.254/latest/meta-data/",
      ),
    ).toBeUndefined()
  })
})
