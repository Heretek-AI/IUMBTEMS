// Research stack on the real host: the configured provider is the host's
// websearch (results cached), research seats fetch and audit cited evidence.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const PAGE =
  "<html><head><title>Factory patterns</title></head><body><main><p>Mechanical gates catch regressions before review, which keeps autonomous agents honest.</p></main></body></html>"

let state: string
let h: Harness
let server: ReturnType<typeof Bun.serve>
let previous: string | undefined

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-research-host-"))
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/search")
        return Response.json({
          results: [
            {
              url: `http://127.0.0.1:${server.port}/page`,
              title: "Factory patterns",
              content: `About ${url.searchParams.get("q")}: gates keep agents honest.`,
            },
          ],
        })
      if (url.pathname === "/page") return new Response(PAGE, { headers: { "content-type": "text/html" } })
      return new Response("not found", { status: 404 })
    },
  })
  previous = process.env.SEARXNG_URL
  process.env.SEARXNG_URL = `http://127.0.0.1:${server.port}`
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# r\n" },
  })
}, 60_000)

afterAll(async () => {
  await h?.close()
  server?.stop(true)
  if (previous === undefined) delete process.env.SEARXNG_URL
  else process.env.SEARXNG_URL = previous
  await rm(state, { recursive: true, force: true })
})

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  )

describe("host web caching is for factory seats in a factory project only", () => {
  let bare: Harness
  beforeAll(async () => {
    bare = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# bare\n" },
    })
  }, 60_000)
  afterAll(() => bare?.close())

  const web = (agent: string) =>
    bare.run(
      `${call("websearch", { query: "factory gates" })} ${call("webfetch", { url: `http://127.0.0.1:${server.port}/page`, format: "text" })}`,
      { agent },
    )

  test("without .factory/, neither the user's agent nor a seat caches, and no .factory/ appears", async () => {
    for (const agent of ["build", "factory"]) {
      const { tools } = await web(agent)
      expect(tools.map((tool) => `${agent}:${tool.name}:${tool.status}`)).toEqual([
        `${agent}:websearch:completed`,
        `${agent}:webfetch:completed`,
      ])
      expect(tools[0]?.text).toContain("gates keep agents honest")
      expect(tools[1]?.text).toContain("Mechanical gates catch regressions")
      for (const tool of tools) expect(tool.text).not.toContain("sha256:")
    }
    expect(await exists(path.join(bare.directory, ".factory"))).toBe(false)
  }, 60_000)

  test("in a factory project the user's agent is still untouched; a seat's results are cached and citable", async () => {
    await mkdir(path.join(bare.directory, ".factory"), { recursive: true })
    const user = await web("build")
    for (const tool of user.tools) expect(tool.text).not.toContain("sha256:")
    expect(await exists(path.join(bare.directory, ".factory/research/sources"))).toBe(false)

    const seat = await web("factory")
    expect(seat.tools[0]?.text).toContain("cached sha256:")
    expect(seat.tools[0]?.text).toContain("gates keep agents honest")
    const fetched = /\[cached as sha256:([0-9a-f]{64})/.exec(seat.tools[1]?.text ?? "")?.[1]
    expect(fetched).toBeDefined()
    expect(await exists(path.join(bare.directory, `.factory/research/sources/${fetched}.md`))).toBe(true)
  }, 60_000)
})

describe("research on the real host", () => {
  test("the host websearch tool runs through our cached provider for a factory seat", async () => {
    await mkdir(path.join(h.directory, ".factory"), { recursive: true })
    const { tools } = await h.run(call("websearch", { query: "factory gates" }), { agent: "factory" })
    expect(tools[0]?.status).toBe("completed")
    expect(tools[0]?.text).toContain("cached sha256:")
    expect(tools[0]?.text).toContain("gates keep agents honest")
  })

  test("a research seat fetches, cites verbatim and passes the audit; a fabricated quote fails", async () => {
    const fetched = await h.run(call("es_research_fetch", { url: `http://127.0.0.1:${server.port}/page` }), {
      agent: "es-research-alpha",
    })
    const hash = /sha256:([0-9a-f]{64})/.exec(fetched.tools[0]?.text ?? "")?.[1]
    expect(hash).toBeDefined()
    await writeFile(
      path.join(h.directory, ".factory/research/alpha.md"),
      `# Alpha\n\n- Gates catch regressions early [VERIFIED: sha256:${hash} "catch regressions before review"]\n- Agents never err [VERIFIED: sha256:${hash} "agents never make mistakes at all"]\n`,
    )
    const audit = await h.run(call("es_research_audit", { path: ".factory/research/alpha.md" }), {
      agent: "es-research-alpha",
    })
    expect(audit.tools[0]?.text).toContain("1/2 claims grounded")
    const pruned = await h.run(call("es_research_audit", { path: ".factory/research/alpha.md", prune: true }), {
      agent: "es-research-alpha",
    })
    expect(pruned.tools[0]?.text).toContain("Pruned 1 claim")
    const again = await h.run(call("es_research_audit", { path: ".factory/research/alpha.md" }), {
      agent: "es-research-alpha",
    })
    expect(again.tools[0]?.text).toContain("Audit passed")
  })

  test("research tools are seat-scoped: the user's build agent does not get them", async () => {
    const { tools } = await h.run(call("es_research_fetch", { url: "http://127.0.0.1/" }))
    expect(tools[0]?.status).toBe("error")
  })

  test("#110: a research run's seats use the host web cache, because .factory/ exists", async () => {
    const { Factory } = await import("@heretek-ai/es-core")
    const research = new Factory(h.directory, {
      gates: async () => ({ passed: true, findings: [], summary: "stub" }),
      stateDir: state,
    })
    // A real research-only run (no git needed, no frontier), not a mkdir.
    const begun = await research.beginResearchRun({ objective: "Do gates keep agents honest?", ceilingUSD: 5 })
    expect(begun).toMatchObject({ mode: "research", stage: "RESEARCH" })
    const { tools } = await h.run(call("websearch", { query: "factory gates" }), { agent: "factory" })
    expect(tools[0]?.status).toBe("completed")
    expect(tools[0]?.text).toContain("cached sha256:")
    expect(tools[0]?.text).toContain("gates keep agents honest")
  })

  test("#106: search fails over from a failing backend to the next one in order", async () => {
    // Brave looks configured but its key is invalid, so the chain must move
    // on to the local SearXNG instance and report its id.
    const saved = process.env.BRAVE_API_KEY
    process.env.BRAVE_API_KEY = "test-invalid-key"
    const failover = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# failover\n" },
    })
    try {
      const { tools } = await failover.run(call("es_research_search", { query: "factory gates" }), {
        agent: "es-research-alpha",
      })
      expect(tools[0]?.status).toBe("completed")
      expect(tools[0]?.text).toContain("searxng results for")
      expect(tools[0]?.text).toContain("gates keep agents honest")
    } finally {
      await failover.close()
      if (saved === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = saved
    }
  }, 60_000)
})

describe("#107: the gateway backend on the real host", () => {
  // Vendored golden fixtures replayed by a fake gateway (no stack runs here).
  const gatewayFixture = (area: string, name: string) =>
    JSON.parse(
      readFileSync(
        path.resolve(import.meta.dir, "../../core/test/fixtures/scraper-swarm/v1", area, `${name}.json`),
        "utf8",
      ),
    ) as { response_body: unknown }
  const searchError = gatewayFixture("web-search", "upstream-error").response_body
  const fetchOk = gatewayFixture("fetch-page", "md-success").response_body
  const ssrfDenied = gatewayFixture("fetch-page", "ssrf-denied").response_body

  let gateway: ReturnType<typeof Bun.serve>
  let mode = "mixed"
  let gatewayCalls: string[] = []
  const auths: Array<string | null> = []

  beforeAll(async () => {
    gateway = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json().catch(() => undefined)) as
          | { method?: string; params?: { name?: string } }
          | undefined
        auths.push(req.headers.get("authorization"))
        const name = body?.params?.name ?? ""
        gatewayCalls.push(name)
        const toolBody = name === "web_search" ? searchError : mode === "ssrf" ? ssrfDenied : fetchOk
        return Response.json(toolBody, { headers: { "x-swarm-contract": "1" } })
      },
    })
  })

  afterAll(() => gateway?.stop(true))

  const withGateway = async (work: (harness: Harness) => Promise<void>) => {
    const savedUrl = process.env.ES_SCRAPER_SWARM_URL
    const savedToken = process.env.ES_SCRAPER_SWARM_TOKEN
    process.env.ES_SCRAPER_SWARM_URL = `http://127.0.0.1:${gateway.port}`
    process.env.ES_SCRAPER_SWARM_TOKEN = "test-token"
    const harness = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# swarm\n" },
    })
    try {
      await work(harness)
    } finally {
      await harness.close()
      if (savedUrl === undefined) delete process.env.ES_SCRAPER_SWARM_URL
      else process.env.ES_SCRAPER_SWARM_URL = savedUrl
      if (savedToken === undefined) delete process.env.ES_SCRAPER_SWARM_TOKEN
      else process.env.ES_SCRAPER_SWARM_TOKEN = savedToken
    }
  }

  test("gateway search fails over to the next backend", async () => {
    mode = "mixed"
    gatewayCalls = []
    await withGateway(async (swarm) => {
      const searched = await swarm.run(call("es_research_search", { query: "factory gates" }), {
        agent: "es-research-alpha",
      })
      expect(searched.tools[0]?.status).toBe("completed")
      // The gateway errored, so the local SearXNG instance served instead.
      expect(searched.tools[0]?.text).toContain("searxng results for")
      expect(gatewayCalls).toContain("web_search")
    })
  }, 60_000)

  test("gateway fetch caches sealed under provider scraper-swarm", async () => {
    mode = "mixed"
    gatewayCalls = []
    auths.length = 0
    await withGateway(async (swarm) => {
      const fetched = await swarm.run(call("es_research_fetch", { url: "https://example.com/recorded" }), {
        agent: "es-research-alpha",
      })
      expect(fetched.tools[0]?.status).toBe("completed")
      expect(fetched.tools[0]?.text).toContain("Cached https://example.com/recorded")
      expect(fetched.tools[0]?.text).toContain(
        "sha256:0cb130bc2c0a6fe07c14366f51c96b2cae6b12a12777767524aa49e199c6876f",
      )
      expect(gatewayCalls).toContain("fetch_page")
      // The token authenticates every call and never anything else.
      expect(auths.length).toBeGreaterThan(0)
      for (const auth of auths) expect(auth).toBe("Bearer test-token")
    })
  }, 60_000)

  test("a gateway SSRF denial stops the chain: direct fetch is never attempted", async () => {
    mode = "ssrf"
    await withGateway(async (swarm) => {
      const { tools } = await swarm.run(call("es_research_fetch", { url: "http://169.254.169.254/" }), {
        agent: "es-research-alpha",
      })
      expect(tools[0]?.status).toBe("error")
      // The gateway's refusal surfaces, not a direct-fetch error: nothing failed over.
      expect(tools[0]?.text).toContain("SSRF denied")
    })
    mode = "mixed"
  }, 60_000)
})
