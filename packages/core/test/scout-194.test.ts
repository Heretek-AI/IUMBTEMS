// Issue #194 ("2. Integration tests", unit-level companion): the verdicts
// core computes when the scout proposes `adopt`. scout.test.ts already pins
// the default-whitelist matrix (GPL/AGPL/none -> clean-room); this suite pins
// the variants the fires suite does not: AGPL + unlicensed downgrade reasons
// spelled out, and a narrowed configured whitelist demoting even a verified
// permissive license. Product code is untouched; failures here are findings.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readScoutResult, scoutTools } from "../src/index.ts"

const license = (id: string) => readFileSync(path.join(import.meta.dir, "fixtures/licenses", `${id}.txt`), "utf8")

let root: string
let state: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-scout-194-"))
  state = await mkdtemp(path.join(tmpdir(), "es-scout-194-state-"))
  const vendor: Record<string, string | undefined> = {
    mit: license("MIT"),
    apache: license("Apache-2.0"),
    gpl: license("GPL-3.0-only"),
    agpl: license("AGPL-3.0-only"),
    none: undefined,
  }
  for (const [name, text] of Object.entries(vendor)) {
    const dir = path.join(root, "vendor", name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "index.js"), `module.exports = function ${name}() { return 1 }\n`)
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", dependencies: { leftpad: "1" } }),
    )
    if (text) await writeFile(path.join(dir, "LICENSE"), text)
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const scout = { agent: "scout" }
const tools =
  (extra: Record<string, unknown> = {}) =>
  (name: string) =>
    scoutTools({ root, stateDir: state, ...extra }).find((tool) => tool.name === name)!

async function plan(tool: ReturnType<typeof tools>, names: string[], extra: Record<string, unknown> = {}) {
  return tool("es_scout_plan").execute(
    {
      objective: "a tiny function library",
      posture: "Apache-2.0, commercial",
      candidates: names.map((name) => ({ name, source: `local:./vendor/${name}` })),
      ...extra,
    },
    scout,
  )
}

async function adoptAll(tool: ReturnType<typeof tools>, names: string[]) {
  for (const name of names) {
    await tool("es_scout_scan").execute({ candidate: name }, scout)
    await tool("es_scout_record").execute(
      { candidate: name, maintenance: "stable", proposal: "adopt", rationale: "small, focused and tested", claims: [] },
      scout,
    )
  }
  await tool("es_scout_complete").execute({}, scout)
  return (await readScoutResult(root))!
}

describe("issue #194: copyleft and unlicensed candidates cannot keep adopt", () => {
  test("AGPL, GPL and unlicensed proposals are downgraded to clean-room with reasons", async () => {
    const tool = tools()
    await plan(tool, ["mit", "gpl", "agpl", "none"])
    const result = await adoptAll(tool, ["mit", "gpl", "agpl", "none"])
    const byId = Object.fromEntries(result.verdicts.map((item) => [item.candidate, item]))
    expect(byId.mit?.verdict).toBe("adopt")
    for (const id of ["gpl", "agpl"]) {
      expect([id, byId[id]?.proposal, byId[id]?.verdict]).toEqual([id, "adopt", "clean-room"])
      expect(byId[id]?.downgraded).toContain("copyleft")
    }
    expect([byId.none?.proposal, byId.none?.verdict]).toEqual(["adopt", "clean-room"])
    expect(byId.none?.downgraded).toMatch(/unknown|unverified/)
  })
})

describe("issue #194: a narrowed configured whitelist demotes verified permissive licenses", () => {
  test("Apache-2.0 proposed adopt is clean-room when the configured whitelist is MIT-only", async () => {
    const tool = tools({ whitelist: ["MIT"] })
    await plan(tool, ["mit", "apache"])
    const result = await adoptAll(tool, ["mit", "apache"])
    const byId = Object.fromEntries(result.verdicts.map((item) => [item.candidate, item]))
    expect([byId.mit?.proposal, byId.mit?.verdict]).toEqual(["adopt", "adopt"])
    expect([byId.apache?.proposal, byId.apache?.verdict]).toEqual(["adopt", "clean-room"])
    expect(byId.apache?.downgraded).toContain("not on the license whitelist")
  })

  test("a plan cannot widen the configured whitelist: the extra id is ignored, the verdict still demotes", async () => {
    const tool = tools({ whitelist: ["MIT"] })
    const planned = await plan(tool, ["apache"], { whitelist: ["MIT", "Apache-2.0"] })
    expect(planned).toContain("Ignored (a plan can only narrow the configured whitelist): Apache-2.0")
    const result = await adoptAll(tool, ["apache"])
    const verdict = result.verdicts.find((item) => item.candidate === "apache")!
    expect([verdict.proposal, verdict.verdict]).toEqual(["adopt", "clean-room"])
    expect(verdict.downgraded).toContain("not on the license whitelist")
  })

  test("an empty configured whitelist leaves even MIT at clean-room", async () => {
    const tool = tools({ whitelist: [] })
    await plan(tool, ["mit"])
    const result = await adoptAll(tool, ["mit"])
    const verdict = result.verdicts.find((item) => item.candidate === "mit")!
    expect([verdict.proposal, verdict.verdict]).toEqual(["adopt", "clean-room"])
    expect(verdict.downgraded).toContain("not on the license whitelist")
  })
})
