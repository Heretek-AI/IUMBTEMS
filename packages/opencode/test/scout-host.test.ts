// Scout-named coverage on the real host (#257, #288): the scout seat is
// cached-only web under an offline shell, and es_scout_complete refuses a
// silent advisories skip. Canned-OSV advisory content is asserted in core
// (packages/core/test/scout.test.ts); scout runs are human-only and
// spend-bearing, so no live OSV query runs here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { bwrapAvailable, readScoutResult } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const fixtures = path.resolve(import.meta.dir, "../../core/test/fixtures")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const read = (file: string) => readFileSync(path.join(fixtures, file), "utf8")
const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

let state: string
let h: Harness
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-scout-host-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# scout-host\n" },
  })
  await write(h.directory, "vendor/mit/index.js", "module.exports = function mit() { return 1 }\n")
  await write(h.directory, "vendor/mit/package.json", JSON.stringify({ name: "mit-lib", version: "1.0.0" }))
  await write(h.directory, "vendor/mit/LICENSE", read("licenses/MIT.txt"))
  await write(h.directory, "vendor/gpl/index.js", "module.exports = function gpl() { return 1 }\n")
  await write(h.directory, "vendor/gpl/package.json", JSON.stringify({ name: "gpl-lib", version: "1.0.0" }))
  await write(h.directory, "vendor/gpl/LICENSE", read("licenses/GPL-3.0-only.txt"))
}, 60_000)
afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

describe("the scout seat on the real host", () => {
  test("the scout cannot call host webfetch (cached-only web)", async () => {
    const { tools } = await h.run(`fetch ${call("webfetch", { url: "https://example.com" })}`, {
      agent: "scout",
    })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["webfetch:error"])
    expect(tools[0]?.text).toContain("only through es_research_search and es_research_fetch")
  })

  test("the scout shell is offline", async () => {
    if (!bwrapAvailable()) {
      const { tools } = await h.run(`net ${call("shell", { command: "cat /proc/net/dev" })}`, {
        agent: "scout",
      })
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:error"])
      expect(tools[0]?.text).toContain("bubblewrap")
      return
    }
    const { tools } = await h.run(`net ${call("shell", { command: "cat /proc/net/dev" })}`, {
      agent: "scout",
    })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:completed"])
    const ifaces = tools[0]?.text
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => line.split(":")[0]?.trim() ?? "")
      .filter(Boolean)
    expect(ifaces).toEqual(["lo"])
  })

  test("complete refuses a silent advisories skip, naming es_scout_advisories", async () => {
    const plan = call("es_scout_plan", {
      objective: "a function library",
      candidates: [
        { name: "t3mit", source: "local:./vendor/mit" },
        { name: "t3gpl", source: "local:./vendor/gpl" },
      ],
    })
    const scan = ["t3mit", "t3gpl"].map((candidate) => call("es_scout_scan", { candidate }))
    const recordCalls = ["t3mit", "t3gpl"].map((candidate) =>
      call("es_scout_record", {
        candidate,
        maintenance: "stable",
        proposal: "adopt",
        rationale: "it does what we need",
        claims: [],
      }),
    )
    const { tools } = await h.run(`scout ${[plan, ...scan, ...recordCalls, call("es_scout_complete")].join(" ")}`, {
      agent: "scout",
    })
    const done = tools.find((tool) => tool.name === "es_scout_complete")!
    expect(done.status).toBe("error")
    expect(done.text).toContain("es_scout_advisories")
  })

  test("explicit NEGATIVE_KNOWLEDGE about the skip completes and is reported", async () => {
    const skip = (name: string) => ({
      tag: "NEGATIVE_KNOWLEDGE",
      statement: `OSV advisories were not queried for ${name}`,
      query: `OSV advisories for ${name}`,
      finding: "skipped: a local fixture with no published package",
    })
    const plan = call("es_scout_plan", {
      objective: "a function library",
      candidates: [
        { name: "t4mit", source: "local:./vendor/mit" },
        { name: "t4gpl", source: "local:./vendor/gpl" },
      ],
    })
    const scan = ["t4mit", "t4gpl"].map((candidate) => call("es_scout_scan", { candidate }))
    const recordCalls = ["t4mit", "t4gpl"].map((candidate) =>
      call("es_scout_record", {
        candidate,
        maintenance: "stable",
        proposal: "adopt",
        rationale: "it does what we need",
        claims: [skip(candidate)],
      }),
    )
    const { tools } = await h.run(`scout ${[plan, ...scan, ...recordCalls, call("es_scout_complete")].join(" ")}`, {
      agent: "scout",
    })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(tools.map((tool) => `${tool.name}:completed`))
    const result = (await readScoutResult(h.directory))!
    expect(Object.fromEntries(result.verdicts.map((item) => [item.candidate, item.verdict]))).toEqual({
      t4mit: "adopt",
      t4gpl: "clean-room",
    })
    const report = await readFile(path.join(h.directory, ".factory/scout/REPORT.md"), "utf8")
    expect(report).toContain("## Advisory checks")
    expect(report).toContain("advisories not queried; the assessment records explicit NEGATIVE_KNOWLEDGE")
  })

  test("a registry candidate queried at the wrong coordinates is refused without network", async () => {
    const { tools } = await h.run(
      `scout ${call("es_scout_plan", {
        objective: "a function library",
        candidates: [{ name: "leftpad", source: "npm:left-pad" }],
      })} ${call("es_scout_advisories", { candidate: "leftpad", ecosystem: "PyPI", package: "left-pad" })}`,
      { agent: "scout" },
    )
    const advisories = tools.find((tool) => tool.name === "es_scout_advisories")!
    expect(advisories.status).toBe("error")
    expect(advisories.text).toContain("must be queried for the scanned source")
  })
})
