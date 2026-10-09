import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderEvalPrompt, resolveServePath, startServeFixtures, usesFixtureServer } from "../src/evals/serve.ts"

describe("eval fixture server", () => {
  let dir = ""
  let stop = () => {}
  afterEach(async () => {
    stop()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("serves fixture files on localhost, 404s the rest, and never escapes", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "es-serve-"))
    await writeFile(path.join(dir, "page.txt"), "the bun test runner accepts a single file path argument\n")
    const serve = await startServeFixtures(dir)
    stop = serve.stop
    expect(serve.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await (await fetch(`${serve.url}/page.txt`)).text()).toContain("single file path")
    expect((await fetch(`${serve.url}/missing.txt`)).status).toBe(404)
  })

  test("request paths cannot escape the served dir", () => {
    const base = path.resolve("/tmp/es-serve-base")
    expect(resolveServePath(base, "/page.txt")).toBe(path.join(base, "page.txt"))
    expect(resolveServePath(base, "/sub/page.txt")).toBe(path.join(base, "sub/page.txt"))
    expect(resolveServePath(base, "/../page.txt")).toBeUndefined()
    expect(resolveServePath(base, "/sub/../../page.txt")).toBeUndefined()
    expect(resolveServePath(base, "/..%2fpage.txt")).toBeUndefined()
  })

  test("prompt rendering substitutes the server URL and leaves other prompts alone", () => {
    expect(renderEvalPrompt("Fetch {{SERVE_URL}}/page.txt now", "http://127.0.0.1:9")).toBe(
      "Fetch http://127.0.0.1:9/page.txt now",
    )
    expect(renderEvalPrompt("No placeholder here", "http://127.0.0.1:9")).toBe("No placeholder here")
  })

  test("only fixture-server cases need the loopback allowance (S4.4)", () => {
    expect(usesFixtureServer("Fetch {{SERVE_URL}}/handoff.txt with es_research_fetch")).toBe(true)
    expect(usesFixtureServer("Tear down these local candidates")).toBe(false)
    expect(usesFixtureServer("")).toBe(false)
  })
})
