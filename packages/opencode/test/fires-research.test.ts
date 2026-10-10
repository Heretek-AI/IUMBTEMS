// research-fires (merge-blocking, deterministic): the whole research loop on
// the real in-process host with a fake model and loopback-only servers —
// grounded quotes, failover, sealing, retraction degradation and renders.
// No internet, no real model, no gateway stack.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  Factory,
  factoryLayout,
  gateRunner,
  readDossier,
  renderResearchRun,
  researchCache,
  SourceCache,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const child = (name: string, args: Record<string, unknown> = {}) => `@@CHILD ${name} ${JSON.stringify(args)}@@`
const delegate = (agent: string, prompt: string) => call("subagent", { agent, description: `${agent} step`, prompt })
const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

const PAGE_A = "<html><body><p>Alpha gates keep agents honest under load.</p></body></html>"
const PAGE_B = "<html><body><p>Beta gates stay fast at scale.</p></body></html>"

let state: string
// Fixed loopback ports: the source URL feeds claim ids and the evidence
// hash, so ephemeral ports would make every render unique. Loopback only;
// nothing leaves the machine.
const PAGES_PORT = 18381
const SEARXNG_PORT = 18382
const GATEWAY_PORT = 18383
let pages: ReturnType<typeof Bun.serve>
let searxng: ReturnType<typeof Bun.serve>
let gateway: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-fires-research-"))
  // The direct backend refuses loopback by default (SSRF guard); the
  // loopback-only fixture servers below need the explicit test allowance.
  // Nothing leaves the machine. Test 2b still proves a gateway blocked
  // refusal halts the chain: the gateway denies before direct is reached.
  process.env.ES_RESEARCH_ALLOW_LOOPBACK = "1"
  pages = Bun.serve({
    port: PAGES_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/a") return new Response(PAGE_A, { headers: { "content-type": "text/html" } })
      if (url.pathname === "/b") return new Response(PAGE_B, { headers: { "content-type": "text/html" } })
      return new Response("not found", { status: 404 })
    },
  })
  searxng = Bun.serve({
    port: SEARXNG_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/search")
        return Response.json({
          results: [
            {
              url: `http://127.0.0.1:${PAGES_PORT}/a`,
              title: "Alpha gates",
              content: `About ${url.searchParams.get("q")}: gates keep agents honest.`,
            },
          ],
        })
      return new Response("not found", { status: 404 })
    },
  })
  gateway = Bun.serve({
    port: GATEWAY_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json().catch(() => undefined)) as { params?: { name?: string } } | undefined
      const name = body?.params?.name ?? ""
      if (name === "web_search")
        return Response.json(
          {
            id: 1,
            jsonrpc: "2.0",
            result: {
              content: [{ type: "text", text: "SearXNG search failed: engine down" }],
              isError: true,
              structuredContent: { code: "upstream_error", message: "SearXNG search failed: engine down" },
            },
          },
          { headers: { "x-swarm-contract": "1" } },
        )
      return Response.json(
        {
          id: 1,
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: `SSRF denied (fail-closed): joyriding is not research` }],
            isError: true,
            structuredContent: { code: "ssrf_denied", message: "SSRF denied (fail-closed): joyriding is not research" },
          },
        },
        { headers: { "x-swarm-contract": "1" } },
      )
    },
  })
})

afterAll(async () => {
  pages?.stop(true)
  searxng?.stop(true)
  gateway?.stop(true)
  delete process.env.ES_RESEARCH_ALLOW_LOOPBACK
  await rm(state, { recursive: true, force: true })
})

const factoryFor = (root: string) => new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })

async function bootHost(env: Record<string, string> = {}) {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]] as const))
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  const h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# fires research\n" },
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

/** A research run whose REPORT holds one grounded claim, through real seats. */
async function completeGroundedRun(h: Harness, page: string, quote: string) {
  await factoryFor(h.directory).beginResearchRun({ objective: "Do gates hold?", ceilingUSD: 5 })
  const fetched = await h.run(call("es_research_fetch", { url: page }), { agent: "es-research-alpha" })
  expect(fetched.tools[0]?.status).toBe("completed")
  const sha = /sha256:([0-9a-f]{64})/.exec(fetched.tools[0]?.text ?? "")?.[1]
  expect(sha).toBeDefined()
  const line = `- Gates hold [VERIFIED: sha256:${sha} "${quote}"]`
  const written = await h.run(
    delegate(
      "es-research-synthesizer",
      `Resolve ${child("write", { path: ".factory/research/REPORT.md", content: `# Report\n\n${line}\n` })} done`,
    ),
    { agent: "deep-researcher" },
  )
  expect(written.tools[0]?.status).toBe("completed")
  const completed = await h.run(call("es_research_complete"), { agent: "deep-researcher" })
  expect(completed.tools[0]?.status).toBe("completed")
  expect((await factoryFor(h.directory).read())?.stage).toBe("DONE")
  return sha!
}

describe("research-fires", () => {
  test("1. grounded run: only the verbatim quote survives the audit", async () => {
    const { h, close } = await bootHost()
    try {
      const pageA = `http://127.0.0.1:${PAGES_PORT}/a`
      const pageB = `http://127.0.0.1:${PAGES_PORT}/b`
      await factoryFor(h.directory).beginResearchRun({ objective: "Do gates hold?", ceilingUSD: 5 })
      const fetchA = await h.run(call("es_research_fetch", { url: pageA }), { agent: "es-research-alpha" })
      const fetchB = await h.run(call("es_research_fetch", { url: pageB }), { agent: "es-research-alpha" })
      const shaA = /sha256:([0-9a-f]{64})/.exec(fetchA.tools[0]?.text ?? "")?.[1]
      const shaB = /sha256:([0-9a-f]{64})/.exec(fetchB.tools[0]?.text ?? "")?.[1]
      expect([shaA, shaB].every(Boolean)).toBe(true)
      const report = [
        `- Gates stay honest [VERIFIED: sha256:${shaA} "keep agents honest under load"]`,
        `- Gates stay honest [VERIFIED: sha256:${shaA} "keep agents"]`,
        `- Gates stay fast [VERIFIED: sha256:${shaB} "stay slow at scale"]`,
      ].join("\n")
      const written = await h.run(
        delegate(
          "es-research-synthesizer",
          `Resolve ${child("write", { path: ".factory/research/REPORT.md", content: `# Report\n\n${report}\n` })} done`,
        ),
        { agent: "deep-researcher" },
      )
      expect(written.tools[0]?.status).toBe("completed")
      // Pruning drops the short and the altered quote; the verbatim one stays.
      const pruned = await h.run(call("es_research_audit", { path: ".factory/research/REPORT.md", prune: true }), {
        agent: "es-research-synthesizer",
      })
      expect(pruned.tools[0]?.text).toContain("Pruned 2")
      const completed = await h.run(call("es_research_complete"), { agent: "deep-researcher" })
      expect(completed.tools[0]?.status).toBe("completed")
      const coverage = await Bun.file(path.join(h.directory, ".factory/research/coverage.json")).json()
      // completeResearch re-audits the pruned file: one claim, grounded.
      expect(coverage).toMatchObject({ claims: 1, grounded: 1 })
      const dossier = await readDossier(factoryLayout(h.directory).researchDossier)
      expect(dossier?.claims).toHaveLength(1)
      expect(dossier?.claims[0]?.statement).toContain("stay honest")
    } finally {
      await close()
    }
  }, 120_000)

  test("2a. failover: the gateway errors, SearXNG serves and records provenance", async () => {
    const { h, close } = await bootHost({
      ES_SCRAPER_SWARM_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
      ES_SCRAPER_SWARM_TOKEN: "fires-token",
      SEARXNG_URL: `http://127.0.0.1:${SEARXNG_PORT}`,
    })
    try {
      const searched = await h.run(call("es_research_search", { query: "alpha gates" }), {
        agent: "es-research-alpha",
      })
      expect(searched.tools[0]?.status).toBe("completed")
      expect(searched.tools[0]?.text).toContain("searxng results for")
    } finally {
      await close()
    }
  }, 120_000)

  test("2b. blocked never fails over: the gateway denies a servable page", async () => {
    // A fresh harness: the search failure above cools the gateway backend down,
    // and cooldowns are per backend (failover test 2a must not mask this one).
    const { h, close } = await bootHost({
      ES_SCRAPER_SWARM_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
      ES_SCRAPER_SWARM_TOKEN: "fires-token",
      SEARXNG_URL: `http://127.0.0.1:${SEARXNG_PORT}`,
    })
    try {
      // The gateway denies even a servable page; direct fetch is never attempted.
      const denied = await h.run(call("es_research_fetch", { url: `http://127.0.0.1:${PAGES_PORT}/a` }), {
        agent: "es-research-alpha",
      })
      expect(denied.tools[0]?.status).toBe("error")
      expect(denied.tools[0]?.text).toContain("SSRF denied")
    } finally {
      await close()
    }
  }, 120_000)

  test("3. sealing: a planted unsealed source is refused", async () => {
    const { h, close } = await bootHost()
    try {
      const cache = researchCache(h.directory, state)
      const text = "Planted findings about gate latency."
      const planted = await new SourceCache(`${h.directory}.planted`, undefined).put({
        url: "https://evil.test/planted",
        text,
        provider: "fetch",
      })
      // Same bytes and sha, but no engine seal.
      await write(h.directory, `.factory/research/sources/${planted.meta.sha256}.md`, text)
      await write(
        h.directory,
        `.factory/research/sources/${planted.meta.sha256}.json`,
        JSON.stringify({ ...planted.meta, seal: undefined }),
      )
      expect(await cache.get(planted.meta.sha256)).toBeUndefined()
      await write(
        h.directory,
        ".factory/research/alpha.md",
        `# Alpha\n\n- Planted latency wins [VERIFIED: sha256:${planted.meta.sha256} "gate latency"]\n`,
      )
      const audit = await h.run(call("es_research_audit", { path: ".factory/research/alpha.md" }), {
        agent: "es-research-alpha",
      })
      expect(audit.tools[0]?.text).not.toContain("Audit passed")
    } finally {
      await close()
    }
  }, 120_000)

  describe("degradation and export", () => {
    let h: Harness
    let sha: string
    beforeAll(async () => {
      ;({ h } = await bootHost())
      sha = await completeGroundedRun(h, `http://127.0.0.1:${PAGES_PORT}/a`, "keep agents honest under load")
    }, 120_000)
    afterAll(async () => {
      await h?.close()
    })

    test("4. degradation: a retracted source reads STALE in the render", async () => {
      await write(
        h.directory,
        ".factory/claims/retractions.json",
        JSON.stringify({
          version: 1,
          retractions: [
            { source: sha, event: "RETRACTED", at: new Date().toISOString(), note: "withdrawn", by: "tester" },
          ],
        }),
      )
      const md = await renderResearchRun(h.directory, { format: "md", stateDir: state })
      expect(md).toContain("STALE")
      expect(md).toContain(sha.slice(0, 12))
    })

    test("5. export: the Markdown render matches its snapshot", async () => {
      const { main } = await import("../../cli/src/main.ts")
      const printed: string[] = []
      const code = await main(["research", "render", "--format", "md"], {
        print: (text: string) => printed.push(text),
        confirm: { interactive: false, write: () => {}, readLine: async () => "", readSecret: async () => "" },
        cwd: h.directory,
        stateDir: state,
      })
      expect(code).toBe(0)
      const out = printed.join("\n")
      expect(out).toContain("# Research dossier: Do gates hold?")
      expect(out).toContain("Gates hold")
      // Retrieved timestamps move every run; the snapshot pins everything else.
      expect(out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<retrieved>")).toMatchSnapshot()
    })
  })
})
