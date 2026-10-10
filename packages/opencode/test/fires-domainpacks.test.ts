// Biopharma pack on the real in-process host (#190 integration 2): a
// pack-active testkit research run with a banned-domain source and a
// retracted source. es_research_complete rejects the banned claim, and after
// a clean completion the retracted source renders STALE. Pack-active, not
// pack-agnostic: the stage.done audit entry records domainPack biopharma.
// Real host via packages/testkit (scripted fake LLM); no internet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, factoryLayout, gateRunner, renderResearchRun, researchCache } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const child = (name: string, args: Record<string, unknown> = {}) => `@@CHILD ${name} ${JSON.stringify(args)}@@`
const delegate = (agent: string, prompt: string) => call("subagent", { agent, description: `${agent} step`, prompt })

const PAGE_CLEAN = "<html><body><p>The trial met its primary endpoint in the per-protocol analysis.</p></body></html>"
const PAGE_RETRACT =
  "<html><body><p>Surrogate endpoints predicted long-term survival in the cohort study.</p></body></html>"

let state: string
let pages: ReturnType<typeof Bun.serve>
let previousLoopback: string | undefined
const PORT = 18481

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-fires-domainpacks-"))
  // The direct backend refuses loopback by default (SSRF guard); the
  // loopback-only fixture server below needs the explicit test allowance.
  previousLoopback = process.env.ES_RESEARCH_ALLOW_LOOPBACK
  process.env.ES_RESEARCH_ALLOW_LOOPBACK = "1"
  pages = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/clean") return new Response(PAGE_CLEAN, { headers: { "content-type": "text/html" } })
      if (url.pathname === "/retract") return new Response(PAGE_RETRACT, { headers: { "content-type": "text/html" } })
      return new Response("not found", { status: 404 })
    },
  })
})

afterAll(async () => {
  pages?.stop(true)
  if (previousLoopback === undefined) delete process.env.ES_RESEARCH_ALLOW_LOOPBACK
  else process.env.ES_RESEARCH_ALLOW_LOOPBACK = previousLoopback
  await rm(state, { recursive: true, force: true })
})

async function fetchSha(h: Harness, page: string): Promise<string> {
  const fetched = await h.run(call("es_research_fetch", { url: page }), { agent: "es-research-alpha" })
  expect(fetched.tools[0]?.status).toBe("completed")
  const sha = /sha256:([0-9a-f]{64})/.exec(fetched.tools[0]?.text ?? "")?.[1]
  expect(sha).toBeDefined()
  return sha!
}

async function writeReport(h: Harness, content: string) {
  const written = await h.run(
    delegate(
      "es-research-synthesizer",
      `Resolve ${child("write", { path: ".factory/research/REPORT.md", content })} done`,
    ),
    { agent: "deep-researcher" },
  )
  expect(written.tools[0]?.status).toBe("completed")
}

describe("biopharma pack on the real host (#190.2)", () => {
  test("banned-domain claim rejected at es_research_complete; retracted source renders STALE", async () => {
    const h = await boot({
      git: true,
      script: directiveScript,
      // Pack-active run: the plugin's configured constitution vets the report.
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off", domainPack: "biopharma" } }],
      files: { "README.md": "# pack run\n" },
    })
    try {
      // The run itself is begun pack-agnostic (as in fires-research); the
      // pack enters at completion through the plugin's configured factory.
      const factory = new Factory(h.directory, {
        gates: gateRunner({ stateDir: state }),
        stateDir: state,
      })
      await factory.beginResearchRun({ objective: "Does the therapy hold?", ceilingUSD: 5 })

      const shaClean = await fetchSha(h, `http://127.0.0.1:${PORT}/clean`)
      const shaRetract = await fetchSha(h, `http://127.0.0.1:${PORT}/retract`)
      // No network fixture can serve a banned host, so the banned-domain
      // source is sealed straight into the project cache (same engine seal
      // the fetch path mints, same state dir the plugin verifies with).
      const banned = await researchCache(h.directory, state).put({
        url: "https://predatory-journal.example/x",
        text: "A mirror preprint claims the surrogate endpoint is fully validated and ready for filing.",
        provider: "fetch",
      })

      const bannedLine = `- The surrogate is fully validated [VERIFIED: sha256:${banned.meta.sha256} "surrogate endpoint is fully validated"]`
      const cleanLine = `- The trial met its primary endpoint [VERIFIED: sha256:${shaClean} "met its primary endpoint"]`
      const retractLine = `- Surrogates predicted survival [VERIFIED: sha256:${shaRetract} "predicted long-term survival"]`

      // A banned-domain claim is grounded (verbatim quote, sealed source) so
      // the epistemic audit passes and the pack gate is what refuses it.
      await writeReport(h, `# Report\n\n${bannedLine}\n${cleanLine}\n`)
      const refused = await h.run(call("es_research_complete"), { agent: "deep-researcher" })
      expect(refused.tools[0]?.status).toBe("error")
      expect(refused.tools[0]?.text).toContain("BANNED_DOMAIN")
      expect(refused.tools[0]?.text).toContain("biopharma")

      // Without the banned claim the pack-active report completes to DONE.
      await writeReport(h, `# Report\n\n${cleanLine}\n${retractLine}\n`)
      const completed = await h.run(call("es_research_complete"), { agent: "deep-researcher" })
      expect(completed.tools[0]?.status).toBe("completed")
      expect((await factory.read())?.stage).toBe("DONE")

      // Pack-active, not pack-agnostic: the completion audit records the pack.
      const auditText = await Bun.file(factoryLayout(h.directory).audit).text()
      const done = auditText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { action: string; payload: Record<string, unknown> })
        .filter((entry) => entry.action === "stage.done")
      expect(done.length).toBeGreaterThan(0)
      expect(done.at(-1)?.payload.domainPack).toBe("biopharma")

      // Retracting a cited source degrades its claims to STALE in the render.
      await mkdir(path.join(h.directory, ".factory/claims"), { recursive: true })
      await writeFile(
        path.join(h.directory, ".factory/claims/retractions.json"),
        JSON.stringify({
          version: 1,
          retractions: [
            { source: shaRetract, event: "RETRACTED", at: new Date().toISOString(), note: "withdrawn", by: "tester" },
          ],
        }),
      )
      const md = await renderResearchRun(h.directory, { format: "md", stateDir: state })
      expect(md).toContain("STALE")
      expect(md).toContain(shaRetract.slice(0, 12))
    } finally {
      await h.close()
    }
  }, 120_000)
})
