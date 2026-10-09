import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { researchTools } from "@heretek-ai/es-core"
import { main } from "../src/main.ts"

let root: string
let state: string
const realFetch = globalThis.fetch
const realBrave = process.env.BRAVE_API_KEY

async function git(...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-cli-research-"))
  state = await mkdtemp(path.join(tmpdir(), "es-cli-research-state-"))
  await git("init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# x\n")
})

afterEach(async () => {
  globalThis.fetch = realFetch
  if (realBrave === undefined) delete process.env.BRAVE_API_KEY
  else process.env.BRAVE_API_KEY = realBrave
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

async function run(argv: string[]) {
  const printed: string[] = []
  const code = await main(argv, {
    print: (text) => printed.push(text),
    confirm: { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" },
    cwd: root,
    stateDir: state,
  })
  return { code, out: printed.join("\n") }
}

describe("es research as human operator (#99)", () => {
  test("es research search exits 0 for the human caller", async () => {
    process.env.BRAVE_API_KEY = "test-key"
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ web: { results: [{ url: "https://a.test", title: "A", description: "x y" }] } }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    const result = await run(["research", "search", "test query"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("brave results")
  })

  test("es research fetch exits 0 for the human caller", async () => {
    globalThis.fetch = (async () =>
      new Response("<html><head><title>T</title></head><body><p>Human fetchable content here.</p></body></html>", {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch
    const result = await run(["research", "fetch", "https://192.0.2.1/page"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("sha256:")
  })
})

describe("plugin-built tools never trust an agent named human (#99)", () => {
  test("{ agent: 'human' } is refused without the explicit CLI operator", async () => {
    const tools = researchTools({ root, stateDir: state, policy: async () => ({ root }) })
    const byName = (name: string) => tools.find((tool) => tool.name === name)!
    // The audit tool needs no provider: it reaches the seat check first.
    await expect(byName("es_research_audit").execute({}, { agent: "human" })).rejects.toThrow(
      "Only the research seats and factory",
    )
    await expect(byName("es_research_search").execute({ query: "x" }, { agent: "human" })).rejects.toThrow(
      "Only the research and scout seats",
    )
    await expect(
      byName("es_research_fetch").execute({ url: "https://example.test" }, { agent: "human" }),
    ).rejects.toThrow("Only the research and scout seats")
    // Seats keep their grants through the same instance.
    await expect(byName("es_research_audit").execute({}, { agent: "factory" })).resolves.toContain("does not exist yet")
  })

  test("the CLI operator flag admits a non-seat agent label", async () => {
    const tools = researchTools({ root, stateDir: state, policy: async () => ({ root }), operator: "human" })
    const byName = (name: string) => tools.find((tool) => tool.name === name)!
    await expect(byName("es_research_audit").execute({}, { agent: "cli" })).resolves.toContain("does not exist yet")
  })
})
