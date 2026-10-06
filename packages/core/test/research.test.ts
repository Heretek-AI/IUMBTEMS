import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  auditMarkdown,
  braveProvider,
  firecrawlProvider,
  htmlToText,
  parseTags,
  pruneClaims,
  researchTools,
  SourceCache,
  searxngProvider,
  selectProvider,
  verifyQuote,
} from "../src/index.ts"

let dir: string
let cache: SourceCache
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "es-research-"))
  cache = new SourceCache(path.join(dir, "sources"))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

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
})

describe("auditor", () => {
  test("parses tags including a VERIFIED source and quote", () => {
    const tags = parseTags(
      `Bun bundles tools [VERIFIED: sha256:${"a".repeat(64)} "a test runner"] [INFERRED: so one fewer dependency]`,
    )
    expect(tags.map((tag) => tag.kind)).toEqual(["VERIFIED", "INFERRED"])
    expect(tags[0]).toMatchObject({ source: "a".repeat(64), quote: "a test runner" })
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
