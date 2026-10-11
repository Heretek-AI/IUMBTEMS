// #189: the full adversarial deep-research flow on the real host with the
// scripted fake LLM — thesis, antithesis, synthesis to a grounded REPORT.md.
// REPORT.md has one writer (the synthesizer) and every claim is tagged, so
// the epistemic audit passes and the run completes at DONE.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, factoryLayout, readDossier } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const child = (name: string, args: Record<string, unknown> = {}) => `@@CHILD ${name} ${JSON.stringify(args)}@@`
const delegate = (agent: string, prompt: string) => call("subagent", { agent, description: `${agent} step`, prompt })
const PAGE =
  "<html><head><title>Factory patterns</title></head><body><main><p>Mechanical gates catch regressions before review, which keeps autonomous agents honest.</p></main></body></html>"

let state: string
let h: Harness
let server: ReturnType<typeof Bun.serve>
let previous: string | undefined
let previousLoopback: string | undefined

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-deep-host-"))
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
  // The direct backend refuses loopback by default (SSRF guard); the
  // loopback-only fixture server above needs the explicit test allowance.
  previousLoopback = process.env.ES_RESEARCH_ALLOW_LOOPBACK
  process.env.ES_RESEARCH_ALLOW_LOOPBACK = "1"
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# deep\n" },
  })
}, 60_000)

afterAll(async () => {
  await h?.close()
  server?.stop(true)
  if (previous === undefined) delete process.env.SEARXNG_URL
  else process.env.SEARXNG_URL = previous
  if (previousLoopback === undefined) delete process.env.ES_RESEARCH_ALLOW_LOOPBACK
  else process.env.ES_RESEARCH_ALLOW_LOOPBACK = previousLoopback
  await rm(state, { recursive: true, force: true })
})

describe("#189: /research deep on the real host", () => {
  test("thesis, antithesis, synthesis: one writer, every claim tagged, DONE", async () => {
    const factory = new Factory(h.directory, {
      gates: async () => ({ passed: true, findings: [], summary: "stub" }),
      stateDir: state,
    })
    // The human's /research deep <question> --max-usd N begins the run with
    // their ceiling; seats halt when the spend reaches it.
    const begun = await factory.beginResearchRun({ objective: "Do gates keep agents honest?", ceilingUSD: 5 })
    expect(begun).toMatchObject({ mode: "research", stage: "RESEARCH", spendCeilingUSD: 5 })

    // Thesis gathers citable evidence first, so the notes can quote a hash.
    const gathered = await h.run(call("es_research_fetch", { url: `http://127.0.0.1:${server.port}/page` }), {
      agent: "es-research-alpha",
    })
    expect(gathered.tools[0]?.status).toBe("completed")
    const sha = /sha256:([0-9a-f]{64})/.exec(gathered.tools[0]?.text ?? "")?.[1]
    expect(sha).toBeDefined()
    const thesis = `- Mechanical gates catch regressions before review [VERIFIED: sha256:${sha} "catch regressions before review"]`
    const antithesis = `- No counter-evidence cached [NEGATIVE_KNOWLEDGE: searched for gate failures]`

    // Fan-out: alpha and beta launched in one message, in the foreground.
    const fanout = await h.run(
      `@@PARALLEL@@ ${delegate("es-research-alpha", `Gather the thesis ${child("write", { path: ".factory/research/alpha.md", content: `# Alpha\n\n${thesis}\n` })} done`)} ${delegate("es-research-beta", `Attack it ${child("write", { path: ".factory/research/beta.md", content: `# Beta\n\n${antithesis}\n` })} done`)}`,
      { agent: "deep-researcher" },
    )
    expect(fanout.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual([
      "subagent:completed",
      "subagent:completed",
    ])
    expect(await Bun.file(path.join(h.directory, ".factory/research/alpha.md")).text()).toContain(sha!)
    expect(await Bun.file(path.join(h.directory, ".factory/research/beta.md")).text()).toContain("NEGATIVE_KNOWLEDGE")

    // Synthesis: only the synthesizer writes the report.
    const synthesized = await h.run(
      delegate(
        "es-research-synthesizer",
        `Resolve the dispute ${child("write", { path: ".factory/research/REPORT.md", content: `# Report\n\n${thesis}\n${antithesis}\n` })} done`,
      ),
      { agent: "deep-researcher" },
    )
    expect(synthesized.tools[0]?.status).toBe("completed")

    // One writer: the coordinator, both researchers and the factory seat are
    // refused the report on the host, and the file is unchanged.
    for (const agent of ["deep-researcher", "es-research-alpha", "es-research-beta", "factory"]) {
      const refused = await h.run(call("write", { path: ".factory/research/REPORT.md", content: "forged" }), {
        agent,
      })
      expect([agent, refused.tools[0]?.status]).toEqual([agent, "error"])
    }
    const report = await Bun.file(path.join(h.directory, ".factory/research/REPORT.md")).text()
    expect(report).toContain("catch regressions before review")
    expect(report).not.toContain("forged")

    // Every claim is tagged: the audit passes with all claims grounded.
    const audit = await h.run(call("es_research_audit", { path: ".factory/research/REPORT.md" }), {
      agent: "deep-researcher",
    })
    expect(audit.tools[0]?.status).toBe("completed")
    expect(audit.tools[0]?.text).toContain("Audit passed")
    expect(audit.tools[0]?.text).toContain("2/2 claims grounded")
    const bullets = report.split("\n").filter((line: string) => line.startsWith("- "))
    expect(bullets).toHaveLength(2)
    for (const line of bullets) expect(line).toMatch(/\[(VERIFIED|INFERRED|HYPOTHESIS|NEGATIVE_KNOWLEDGE):/)

    // Completion reaches DONE with a two-claim dossier behind it.
    const completed = await h.run(call("es_research_complete"), { agent: "deep-researcher" })
    expect(completed.tools[0]?.status).toBe("completed")
    expect((await factory.read())?.stage).toBe("DONE")
    const coverage = await Bun.file(path.join(h.directory, ".factory/research/coverage.json")).json()
    expect(coverage).toMatchObject({ claims: 2, grounded: 2, ungrounded: 0, untagged: 0, malformed: 0 })
    const dossier = await readDossier(factoryLayout(h.directory).researchDossier)
    expect(dossier?.claims).toHaveLength(2)
  }, 120_000)
})
