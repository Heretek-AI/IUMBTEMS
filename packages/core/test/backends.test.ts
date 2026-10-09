// #106: ordered source-backend failover. Fake backends prove the chain
// rules; the ops tests below prove provenance and sealing through the tools.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  BackendError,
  resolveBackendOrder,
  runFetchChain,
  runSearchChain,
  type SourceBackend,
} from "../src/research/backends/index.ts"
import { SourceCache } from "../src/research/cache.ts"
import { researchTools } from "../src/research/ops.ts"

const okSearch = (id: string, available = true): SourceBackend => ({
  id,
  capabilities: { search: true, fetch: false },
  available: () => available,
  search: async (query: string) => [{ url: `https://${id}.test/${query}`, title: id, snippet: `via ${id}` }],
})

describe("ordered failover", () => {
  test("tries backends in order and returns the first success with its trace", async () => {
    let secondCalled = false
    const flaky: SourceBackend = {
      id: "flaky",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async () => {
        throw new BackendError("unavailable", "flaky is down")
      },
    }
    const good: SourceBackend = {
      id: "good",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async (query: string) => {
        secondCalled = true
        return [{ url: `https://good.test/${query}`, title: "Good", snippet: "ok" }]
      },
    }
    const result = await runSearchChain([flaky, good], "q", {})
    expect(result.backend).toBe("good")
    expect(result.value).toHaveLength(1)
    expect(result.attempts).toEqual([
      { backend: "flaky", ok: false, kind: "unavailable" },
      { backend: "good", ok: true },
    ])
    expect(secondCalled).toBe(true)
  })

  test("backends without credentials are skipped without being called", async () => {
    let called = false
    const off: SourceBackend = {
      id: "off",
      capabilities: { search: true, fetch: false },
      available: () => false,
    }
    const on: SourceBackend = {
      id: "on",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async (query: string) => {
        called = true
        return [{ url: `https://on.test/${query}`, title: "On", snippet: "ok" }]
      },
    }
    const result = await runSearchChain([off, on], "q", {})
    expect(result.backend).toBe("on")
    expect(called).toBe(true)
    expect(result.attempts).toEqual([
      { backend: "off", ok: false, kind: "unavailable" },
      { backend: "on", ok: true },
    ])
  })

  test("a blocked (safety) refusal stops the chain and never calls the next backend", async () => {
    let nextCalled = false
    const refused: SourceBackend = {
      id: "direct",
      capabilities: { search: false, fetch: true },
      available: () => true,
      fetch: async () => {
        throw new BackendError("blocked", "Only http(s) URLs can be fetched")
      },
    }
    const next: SourceBackend = {
      id: "next",
      capabilities: { search: false, fetch: true },
      available: () => true,
      fetch: async () => {
        nextCalled = true
        return { url: "https://x.test", text: "x", contentType: "text/plain" }
      },
    }
    await expect(runFetchChain([refused, next], "file:///etc/passwd", {})).rejects.toMatchObject({ kind: "blocked" })
    expect(nextCalled).toBe(false)
  })

  test("a rate-limited backend cools down and is skipped until the cooldown lapses", async () => {
    const now = 1_000_000
    let current = now
    let calls = 0
    const limited: SourceBackend = {
      id: "limited",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async () => {
        calls++
        throw new BackendError("rate_limited", "slow down", { retryAfterMs: 60_000 })
      },
    }
    const fallback = okSearch("fallback")
    const clock = () => current
    await runSearchChain([limited, fallback], "q", {}, { now: clock })
    expect(calls).toBe(1)
    // Still cooling down: skipped without a call.
    current = now + 30_000
    const skipped = await runSearchChain([limited, fallback], "q", {}, { now: clock })
    expect(calls).toBe(1)
    expect(skipped.backend).toBe("fallback")
    // After the Retry-After lapses it is tried again.
    current = now + 61_000
    await runSearchChain([limited, fallback], "q", {}, { now: clock })
    expect(calls).toBe(2)
  })

  test("plain errors classify to failover kinds; BackendErrors pass through", async () => {
    const timeout: SourceBackend = {
      id: "slow",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async () => {
        throw new DOMException("The operation timed out", "TimeoutError")
      },
    }
    const good = okSearch("good")
    const result = await runSearchChain([timeout, good], "q", {})
    expect(result.backend).toBe("good")
    expect(result.attempts[0]).toMatchObject({ backend: "slow", ok: false, kind: "timeout" })
  })

  test("when every backend fails the last error surfaces", async () => {
    const down: SourceBackend = {
      id: "down",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async () => {
        throw new BackendError("upstream", "HTTP 500")
      },
    }
    await expect(runSearchChain([down], "q", {})).rejects.toMatchObject({ kind: "upstream" })
  })
})

describe("backend order resolution", () => {
  test("explicit research.backends wins; searchProvider is a one-element alias; default leads with the gateway", () => {
    expect(resolveBackendOrder({ backends: ["searxng", "brave", "direct"] })).toEqual(["searxng", "brave", "direct"])
    expect(resolveBackendOrder({ provider: "brave" })).toEqual(["brave", "direct"])
    expect(resolveBackendOrder({})).toEqual(["scraper-swarm", "brave", "firecrawl", "searxng", "direct"])
  })
})

describe("the chain through the research tools", () => {
  let dir: string
  let state: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "es-backends-"))
    state = await mkdtemp(path.join(tmpdir(), "es-backends-state-"))
  })
  afterEach(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]))
  const sources = () => new SourceCache(path.join(dir, ".factory/research/sources"), state)

  test("search fails over, and the serving backend is recorded sealed in SourceMeta", async () => {
    const down: SourceBackend = {
      id: "down",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async () => {
        throw new BackendError("upstream", "HTTP 500")
      },
    }
    const up: SourceBackend = {
      id: "up",
      capabilities: { search: true, fetch: false },
      available: () => true,
      search: async () => [
        {
          url: "https://up.test/docs",
          title: "Up docs",
          snippet: "summary",
          content: "Up docs say gates keep agents honest.",
        },
      ],
    }
    const tools = researchTools({
      root: dir,
      env: {},
      stateDir: state,
      policy: async () => ({ root: dir }),
      chain: [down, up],
    })
    const search = tools.find((tool) => tool.name === "es_research_search")!
    const text = await search.execute({ query: "gates" }, { agent: "es-research-alpha" })
    expect(text).toContain("up results for")
    const hash = /sha256:([0-9a-f]{64})/.exec(text)?.[1]
    expect(hash).toBeDefined()
    const stored = await sources().get(hash!)
    expect(stored?.meta.provider).toBe("up")
    expect(stored?.meta.seal).toMatch(/^[0-9a-f]{64}$/)
  })

  test("a seat's es_research_fetch uses the chain: unavailable first, then success", async () => {
    const down: SourceBackend = {
      id: "shaky",
      capabilities: { search: false, fetch: true },
      available: () => true,
      fetch: async () => {
        throw new BackendError("unavailable", "gateway down")
      },
    }
    const steady: SourceBackend = {
      id: "direct",
      capabilities: { search: false, fetch: true },
      available: () => true,
      fetch: async (url: string) => ({
        url,
        text: "Steady serves the release notes verbatim.",
        contentType: "text/plain",
      }),
    }
    const tools = researchTools({
      root: dir,
      env: {},
      stateDir: state,
      policy: async () => ({ root: dir }),
      chain: [down, steady],
    })
    const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
    const text = await fetchTool.execute({ url: "https://steady.test/notes" }, { agent: "es-research-alpha" })
    const hash = /sha256:([0-9a-f]{64})/.exec(text)?.[1]
    expect(hash).toBeDefined()
    const stored = await sources().get(hash!)
    expect(stored?.meta.provider).toBe("direct")
    expect(stored?.text).toContain("release notes verbatim")
  })

  test("a blocked fetch never fails over and surfaces the refusal", async () => {
    const tools = researchTools({
      root: dir,
      env: {},
      stateDir: state,
      policy: async () => ({ root: dir }),
    })
    const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
    await expect(fetchTool.execute({ url: "file:///etc/passwd" }, { agent: "es-research-alpha" })).rejects.toThrow(
      "Only http(s)",
    )
  })

  test("FETCHED is capability-derived: fetch-backend entries serve fresh, search-only entries never do", async () => {
    const cache = sources()
    await cache.put({
      url: "https://cap.test/page",
      text: "A full page snapshot with enough text.",
      provider: "direct",
    })
    await cache.put({
      url: "https://cap.test/snippet",
      text: "A search snippet with enough text.",
      provider: "searxng",
    })
    let calls = 0
    const tools = researchTools({
      root: dir,
      env: {},
      stateDir: state,
      policy: async () => ({ root: dir }),
      fetch: (async () => {
        calls++
        return new Response("refetched", { headers: { "content-type": "text/plain" } })
      }) as unknown as typeof fetch,
    })
    const fetchTool = tools.find((tool) => tool.name === "es_research_fetch")!
    expect(await fetchTool.execute({ url: "https://cap.test/page" }, { agent: "es-research-alpha" })).toContain(
      "from the cache",
    )
    expect(calls).toBe(0)
    expect(await fetchTool.execute({ url: "https://cap.test/snippet" }, { agent: "es-research-alpha" })).toContain(
      "Cached https://cap.test/snippet",
    )
    expect(calls).toBe(1)
  })
})
