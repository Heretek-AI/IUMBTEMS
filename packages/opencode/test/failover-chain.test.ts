// #188 / #253: failover chain on the real in-process host (testkit, scripted
// fake LLM). Loopback stubs only; no external network. Proves: a research
// seat's host websearch is denied while es_research_search is allowed, a 503
// gateway fails over to SearXNG, a gateway safety block stops the fetch chain,
// and a 429 gateway is skipped while cooling down.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

type GatewayMode = "http-503" | "http-429-retry" | "blocked"

let gatewayMode: GatewayMode = "http-503"
let gatewayCalls: string[] = []
let searxngHits = 0
let gateway: ReturnType<typeof Bun.serve>
let searxng: ReturnType<typeof Bun.serve>
let state: string

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-failover-host-"))
  searxng = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/search") return new Response("not found", { status: 404 })
      searxngHits++
      return Response.json({
        results: [
          {
            url: "https://searxng.test/host-docs",
            title: "Host docs",
            content: `About ${url.searchParams.get("q")}: gates keep agents honest.`,
          },
        ],
      })
    },
  })
  gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 })
      const body = (await req.json().catch(() => undefined)) as { id?: unknown; params?: { name?: string } } | undefined
      const name = body?.params?.name ?? ""
      gatewayCalls.push(name)
      const id = body?.id ?? 1
      if (gatewayMode === "http-503") return new Response("unavailable", { status: 503 })
      if (gatewayMode === "http-429-retry")
        return new Response("slow down", { status: 429, headers: { "retry-after": "60" } })
      return Response.json(
        {
          id,
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: "SSRF denied (fail-closed)" }],
            isError: true,
            structuredContent: { code: "ssrf_denied", message: "SSRF denied (fail-closed)" },
          },
        },
        { headers: { "x-swarm-contract": "1" } },
      )
    },
  })
})

afterAll(async () => {
  gateway?.stop(true)
  searxng?.stop(true)
  await rm(state, { recursive: true, force: true })
})

/** Boot a host with hermetic web env (ambient keys must not reach the wire). */
async function bootHost(options: { gateway: boolean }) {
  const keys = ["ES_SCRAPER_SWARM_URL", "ES_SCRAPER_SWARM_TOKEN", "SEARXNG_URL", "BRAVE_API_KEY", "FIRECRAWL_API_KEY"]
  const saved = new Map(keys.map((key) => [key, process.env[key]] as const))
  delete process.env.BRAVE_API_KEY
  delete process.env.FIRECRAWL_API_KEY
  process.env.SEARXNG_URL = `http://127.0.0.1:${searxng.port}`
  if (options.gateway) {
    process.env.ES_SCRAPER_SWARM_URL = `http://127.0.0.1:${gateway.port}`
    process.env.ES_SCRAPER_SWARM_TOKEN = "host-failover-token"
  } else {
    delete process.env.ES_SCRAPER_SWARM_URL
    delete process.env.ES_SCRAPER_SWARM_TOKEN
  }
  const h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# failover host\n" },
  })
  return {
    h,
    async close() {
      await h.close()
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

describe("failover chain on the real host", () => {
  test("a research seat's host websearch is denied; es_research_search is allowed", async () => {
    const { h, close } = await bootHost({ gateway: false })
    try {
      const denied = await h.run(call("websearch", { query: "gates" }), { agent: "es-research-alpha" })
      expect(denied.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["websearch:error"])
      expect(denied.tools[0]?.text).toContain("only through es_research_search and es_research_fetch")
      const allowed = await h.run(call("es_research_search", { query: "gates" }), {
        agent: "es-research-alpha",
      })
      expect(allowed.tools[0]?.status).toBe("completed")
      expect(allowed.tools[0]?.text).toContain("searxng results for")
      expect(allowed.tools[0]?.text).toContain("gates keep agents honest")
    } finally {
      await close()
    }
  }, 60_000)

  test("a 503 gateway fails over to SearXNG on the host", async () => {
    gatewayMode = "http-503"
    gatewayCalls = []
    searxngHits = 0
    const { h, close } = await bootHost({ gateway: true })
    try {
      const { tools } = await h.run(call("es_research_search", { query: "gates" }), {
        agent: "es-research-alpha",
      })
      expect(tools[0]?.status).toBe("completed")
      expect(tools[0]?.text).toContain("searxng results for")
      expect(tools[0]?.text).toContain("gates keep agents honest")
      expect(gatewayCalls).toContain("web_search")
      expect(searxngHits).toBe(1)
    } finally {
      await close()
    }
  }, 60_000)

  test("a gateway safety block stops the host fetch chain", async () => {
    gatewayMode = "blocked"
    gatewayCalls = []
    const { h, close } = await bootHost({ gateway: true })
    try {
      const { tools } = await h.run(call("es_research_fetch", { url: "https://example.com/recorded" }), {
        agent: "es-research-alpha",
      })
      expect(tools[0]?.status).toBe("error")
      expect(tools[0]?.text).toContain("SSRF denied")
      expect(gatewayCalls).toContain("fetch_page")
    } finally {
      await close()
    }
  }, 60_000)

  test("a 429 gateway is skipped while cooling down on the host", async () => {
    gatewayMode = "http-429-retry"
    gatewayCalls = []
    const { h, close } = await bootHost({ gateway: true })
    try {
      const first = await h.run(call("es_research_search", { query: "gates one" }), {
        agent: "es-research-alpha",
      })
      expect(first.tools[0]?.status).toBe("completed")
      expect(first.tools[0]?.text).toContain("searxng results for")
      expect(gatewayCalls).toHaveLength(1)
      // Still inside the 60s Retry-After: the gateway is not called again.
      const second = await h.run(call("es_research_search", { query: "gates two" }), {
        agent: "es-research-alpha",
      })
      expect(second.tools[0]?.status).toBe("completed")
      expect(second.tools[0]?.text).toContain("searxng results for")
      expect(gatewayCalls).toHaveLength(1)
    } finally {
      await close()
    }
  }, 60_000)
})
