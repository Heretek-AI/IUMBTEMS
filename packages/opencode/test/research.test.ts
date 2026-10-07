// Research stack on the real host: the configured provider is the host's
// websearch (results cached), research seats fetch and audit cited evidence.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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

describe("research on the real host", () => {
  test("the host websearch tool runs through our cached provider", async () => {
    const { tools } = await h.run(call("websearch", { query: "factory gates" }))
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
})
