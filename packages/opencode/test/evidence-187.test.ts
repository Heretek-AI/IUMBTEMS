// Issue #187 §2: loopback HTTP source server on the testkit host — a
// research seat fetches, quotes verbatim (VERIFIED survives the audit),
// paraphrases (stays ungrounded: flagged, never re-tagged), and quotes a
// planted file (refused). Real in-process host, scripted fake LLM,
// 127.0.0.1 only; must also pass under scripts/v2-head.sh.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { normalizeSourceText, researchCache, sha256 } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

const GATES_PAGE =
  "<html><head><title>Gates</title></head><body><main><p>Mechanical gates catch regressions before review, which keeps autonomous agents honest under heavy load.</p></main></body></html>"
const ENTITY_PAGE = "<html><body><p>Fish &amp; chips are tasty indeed yum.</p></body></html>"

let state: string
let h: Harness
let server: ReturnType<typeof Bun.serve>
let previousLoopback: string | undefined

beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-evidence-187-host-"))
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/gates") return new Response(GATES_PAGE, { headers: { "content-type": "text/html" } })
      if (url.pathname === "/entity") return new Response(ENTITY_PAGE, { headers: { "content-type": "text/html" } })
      return new Response("not found", { status: 404 })
    },
  })
  // The direct backend refuses loopback by default (SSRF guard); the
  // loopback-only fixture server above needs the explicit test allowance.
  previousLoopback = process.env.ES_RESEARCH_ALLOW_LOOPBACK
  process.env.ES_RESEARCH_ALLOW_LOOPBACK = "1"
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# evidence 187\n" },
  })
}, 60_000)

afterAll(async () => {
  await h?.close()
  server?.stop(true)
  if (previousLoopback === undefined) delete process.env.ES_RESEARCH_ALLOW_LOOPBACK
  else process.env.ES_RESEARCH_ALLOW_LOOPBACK = previousLoopback
  await rm(state, { recursive: true, force: true })
})

const gatesUrl = () => `http://127.0.0.1:${server.port}/gates`
const note = (content: string) => writeFile(path.join(h.directory, ".factory/research/alpha.md"), content)

async function fetchHash(pathname: string): Promise<string> {
  const fetched = await h.run(call("es_research_fetch", { url: `http://127.0.0.1:${server.port}${pathname}` }), {
    agent: "es-research-alpha",
  })
  expect(fetched.tools[0]?.status).toBe("completed")
  const hash = /sha256:([0-9a-f]{64})/.exec(fetched.tools[0]?.text ?? "")?.[1]
  expect(hash).toBeDefined()
  return hash!
}

describe("evidence on the real host (#187 §2)", () => {
  test("verbatim VERIFIED survives the audit; a paraphrase stays ungrounded and prunes away", async () => {
    const hash = await fetchHash("/gates")
    await mkdir(path.join(h.directory, ".factory/research"), { recursive: true })
    await note(
      `# Alpha\n\n- Gates catch regressions early [VERIFIED: sha256:${hash} "catch regressions before review"]\n- Gates catch failures ahead of inspection [VERIFIED: sha256:${hash} "catch failures ahead of inspection"]\n`,
    )
    const audit = await h.run(call("es_research_audit", { path: ".factory/research/alpha.md" }), {
      agent: "es-research-alpha",
    })
    expect(audit.tools[0]?.status).toBe("completed")
    expect(audit.tools[0]?.text).toContain("1/2 claims grounded")
    expect(audit.tools[0]?.text).toContain("not found verbatim")
    expect(audit.tools[0]?.text).not.toContain("Audit passed")
    const pruned = await h.run(call("es_research_audit", { path: ".factory/research/alpha.md", prune: true }), {
      agent: "es-research-alpha",
    })
    expect(pruned.tools[0]?.text).toContain("Pruned 1 claim")
    const again = await h.run(call("es_research_audit", { path: ".factory/research/alpha.md" }), {
      agent: "es-research-alpha",
    })
    expect(again.tools[0]?.text).toContain("Audit passed")
    expect(again.tools[0]?.text).toContain("1/1 claims grounded")
  }, 120_000)

  test("a planted unsealed entry is refused: the sealed cache misses and the audit stays ungrounded", async () => {
    const text = "Planted findings about gate latency on reference hardware."
    const hash = sha256(normalizeSourceText(text))
    await mkdir(path.join(h.directory, ".factory/research/sources"), { recursive: true })
    await writeFile(path.join(h.directory, `.factory/research/sources/${hash}.md`), normalizeSourceText(text))
    await writeFile(
      path.join(h.directory, `.factory/research/sources/${hash}.json`),
      `${JSON.stringify({ sha256: hash, url: "https://evil.test/planted", retrieved: new Date().toISOString(), provider: "fetch", bytes: Buffer.byteLength(normalizeSourceText(text)) })}\n`,
    )
    expect(await researchCache(h.directory, state).get(hash)).toBeUndefined()
    await note(`# Alpha\n\n- Planted latency wins [VERIFIED: sha256:${hash} "gate latency on reference"]\n`)
    const audit = await h.run(call("es_research_audit", { path: ".factory/research/alpha.md" }), {
      agent: "es-research-alpha",
    })
    expect(audit.tools[0]?.status).toBe("completed")
    expect(audit.tools[0]?.text).toContain("0/1 claims grounded")
    expect(audit.tools[0]?.text).toContain("not in the cache")
    expect(audit.tools[0]?.text).not.toContain("Audit passed")
  }, 120_000)

  test("entity-at-quote on the host: the decoded & verifies, the encoded &amp; is refused", async () => {
    const hash = await fetchHash("/entity")
    const cached = await researchCache(h.directory, state).get(hash)
    expect(cached?.text).toBe("Fish & chips are tasty indeed yum.")
    await note(
      `# Alpha\n\n- Fish and chips [VERIFIED: sha256:${hash} "Fish & chips are tasty"]\n- Fish encoded [VERIFIED: sha256:${hash} "Fish &amp; chips are tasty"]\n`,
    )
    const audit = await h.run(call("es_research_audit", { path: ".factory/research/alpha.md" }), {
      agent: "es-research-alpha",
    })
    expect(audit.tools[0]?.status).toBe("completed")
    expect(audit.tools[0]?.text).toContain("1/2 claims grounded")
    expect(audit.tools[0]?.text).not.toContain("Audit passed")
  }, 120_000)

  test("the fetch URL is the loopback fixture server (no external network)", () => {
    expect(gatesUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/gates$/)
  })
})
