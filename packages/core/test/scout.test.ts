// The OSS scout: core, not the agent, decides verdicts. A proposed "adopt"
// survives only for a verified, whitelisted, permissive license; OSV
// advisories are cached and cited; claims are witnessed when recorded.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  evaluateWrite,
  factoryLayout,
  parseOsv,
  readScoutResult,
  researchSourcesDir,
  SourceCache,
  scoutTools,
} from "../src/index.ts"

const license = (id: string) => readFileSync(path.join(import.meta.dir, "fixtures/licenses", `${id}.txt`), "utf8")

let root: string
let state: string
let osvCalls: unknown[]
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-scout-"))
  state = await mkdtemp(path.join(tmpdir(), "es-scout-state-"))
  osvCalls = []
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

const OSV = {
  vulns: [
    {
      id: "GHSA-aaaa-bbbb-cccc",
      aliases: ["CVE-2026-0001"],
      summary: "Prototype pollution in merge()",
      database_specific: { severity: "HIGH" },
      affected: [{ ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }],
    },
    {
      id: "GHSA-dddd-eeee-ffff",
      summary: "ReDoS in the parser\nlong details",
      database_specific: { severity: "CRITICAL" },
      affected: [{ ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] }],
    },
    { id: "GHSA-gggg-hhhh-iiii", summary: "Minor info leak", database_specific: { severity: "LOW" }, affected: [] },
  ],
}

const tools = (extra: Record<string, unknown> = {}) => {
  const all = scoutTools({
    root,
    stateDir: state,
    fetch: (async (_url: string, init: RequestInit) => {
      osvCalls.push(JSON.parse(String(init.body)))
      return Response.json(OSV)
    }) as unknown as typeof fetch,
    ...extra,
  })
  return (name: string) => all.find((tool) => tool.name === name)!
}
const scout = { agent: "scout" }
const NAMES = ["mit", "apache", "gpl", "agpl", "none"]

async function planAll(tool = tools()) {
  return tool("es_scout_plan").execute(
    {
      objective: "a tiny function library",
      posture: "Apache-2.0, commercial",
      candidates: NAMES.map((name) => ({ name, source: `local:./vendor/${name}` })),
    },
    scout,
  )
}

async function record(tool: ReturnType<typeof tools>, candidate: string, proposal = "adopt", claims: unknown[] = []) {
  return tool("es_scout_record").execute(
    { candidate, maintenance: "stable", proposal, rationale: "small, focused and tested", claims },
    scout,
  )
}

describe("OSV advisories", () => {
  test("parseOsv reads ids, aliases, severities and fixed versions, sorted by id", () => {
    expect(parseOsv(OSV)).toEqual([
      {
        id: "GHSA-aaaa-bbbb-cccc",
        summary: "Prototype pollution in merge()",
        aliases: ["CVE-2026-0001"],
        severity: "HIGH",
        fixed: ["1.0.1"],
      },
      { id: "GHSA-dddd-eeee-ffff", summary: "ReDoS in the parser", aliases: [], severity: "CRITICAL", fixed: [] },
      { id: "GHSA-gggg-hhhh-iiii", summary: "Minor info leak", aliases: [], severity: "LOW", fixed: [] },
    ])
    expect(parseOsv({})).toEqual([])
  })
})

describe("the scout tools", () => {
  test("are scout-only, and stop when the factory run is halted", async () => {
    await expect(
      tools()("es_scout_plan").execute({ objective: "x", candidates: [] }, { agent: "harvester" }),
    ).rejects.toThrow("Only the scout seat")
    const halted = tools({ halted: async () => "spend ceiling reached" })
    await expect(halted("es_scout_complete").execute({}, scout)).rejects.toThrow("halted (spend ceiling reached)")
  })

  test("a plan narrows the configured whitelist and refuses sources outside the project", async () => {
    const narrowed = await tools({ whitelist: ["MIT", "Apache-2.0"] })("es_scout_plan").execute(
      {
        objective: "x",
        candidates: [{ name: "mit", source: "local:./vendor/mit" }],
        whitelist: ["MIT", "GPL-3.0-only"],
      },
      scout,
    )
    expect(narrowed).toContain("Adoptable licenses: MIT")
    expect(narrowed).toContain("Ignored (a plan can only narrow the configured whitelist): GPL-3.0-only")
    await expect(
      tools()("es_scout_plan").execute({ objective: "x", candidates: [{ name: "etc", source: "local:/etc" }] }, scout),
    ).rejects.toThrow()
  })

  test("adopt survives only for a verified permissive license; core recomputes every verdict and ranks", async () => {
    const tool = tools()
    await planAll(tool)
    for (const name of NAMES) {
      const scanned = await tool("es_scout_scan").execute({ candidate: name }, scout)
      expect(scanned).toContain(`Scanned ${name}`)
      await record(tool, name)
    }
    const done = await tool("es_scout_complete").execute({}, scout)
    expect(done).toContain("Adoption is the human's decision")
    const result = (await readScoutResult(root))!
    const verdict = Object.fromEntries(result.verdicts.map((item) => [item.candidate, item.verdict]))
    expect(verdict).toEqual({
      mit: "adopt",
      apache: "adopt",
      gpl: "clean-room",
      agpl: "clean-room",
      none: "clean-room",
    })
    // Adopted candidates rank first; downgrades say why.
    expect(result.verdicts.slice(0, 2).map((item) => item.verdict)).toEqual(["adopt", "adopt"])
    expect(result.verdicts.find((item) => item.candidate === "gpl")?.downgraded).toContain("copyleft")
    expect(result.verdicts.find((item) => item.candidate === "none")?.downgraded).toMatch(/unknown|unverified/)
    const report = await readFile(factoryLayout(root).scoutReport, "utf8")
    expect(report).toContain("| Rank | Candidate | License |")
    expect(report).toMatch(/\| gpl \| GPL-3\.0 \|.*\| adopt \| \*\*clean-room\*\* \|/)
  })

  test("complete refuses until every candidate is scanned and recorded", async () => {
    const tool = tools()
    await planAll(tool)
    await tool("es_scout_scan").execute({ candidate: "mit" }, scout)
    await expect(tool("es_scout_complete").execute({}, scout)).rejects.toThrow("apache: scan it (es_scout_scan)")
  })

  test("advisories are cached and cited; severe ones are flagged on the verdict", async () => {
    const tool = tools()
    await planAll(tool)
    await expect(tool("es_scout_advisories").execute({ candidate: "mit" }, scout)).rejects.toThrow(
      "not a registry package",
    )
    const advisories = await tool("es_scout_advisories").execute(
      { candidate: "mit", ecosystem: "npm", package: "mit-lib", version: "1.0.0" },
      scout,
    )
    expect(osvCalls).toEqual([{ package: { name: "mit-lib", ecosystem: "npm" }, version: "1.0.0" }])
    const hash = /sha256:([0-9a-f]{64})/.exec(advisories)![1]!
    expect((await new SourceCache(researchSourcesDir(root)).get(hash))?.meta.provider).toBe("osv")
    for (const name of NAMES) {
      await tool("es_scout_scan").execute({ candidate: name }, scout)
      await record(tool, name)
    }
    await tool("es_scout_complete").execute({}, scout)
    const mit = (await readScoutResult(root))!.verdicts.find((item) => item.candidate === "mit")!
    expect(mit.warnings).toEqual([
      "GHSA-aaaa-bbbb-cccc (HIGH): adopt only at 1.0.1 or later",
      "GHSA-dddd-eeee-ffff (CRITICAL) has no fixed release",
    ])
    const dossier = JSON.parse(await readFile(factoryLayout(root).scoutDossier, "utf8"))
    const cited = dossier.claims.filter((claim: any) => claim.source?.sha256 === hash)
    expect(cited.length).toBe(3)
    expect(cited.every((claim: any) => claim.witness.ok)).toBe(true)
  })

  test("a recorded claim must survive its witness; a fabricated quote refuses the record", async () => {
    const tool = tools()
    await planAll(tool)
    const source = await new SourceCache(researchSourcesDir(root)).put({
      url: "https://bench.test/mit",
      text: "mit handles ten million calls per second on a laptop.",
      provider: "fetch",
    })
    const real = {
      tag: "VERIFIED",
      statement: "It is fast.",
      source: { sha256: source.meta.sha256, quote: "ten million calls per second" },
    }
    const fake = {
      tag: "VERIFIED",
      statement: "It is faster.",
      source: { sha256: source.meta.sha256, quote: "a billion calls per second" },
    }
    await expect(record(tool, "mit", "adopt", [real, fake])).rejects.toThrow("1 claim(s) failed their witness check")
    expect(await record(tool, "mit", "adopt", [real])).toContain("1 witnessed claim(s)")
    await expect(record(tool, "mit", "adopt", [{ tag: "MAYBE", statement: "hmm" }])).rejects.toThrow(
      "unknown epistemic tag",
    )
  })

  test("the scout writes only its notes; plan, profiles, advisories and results are tool-only", () => {
    const ctx = { root, stateDir: state }
    for (const file of [
      ".factory/scout/plan.json",
      ".factory/scout/scout.json",
      ".factory/scout/dossier.json",
      ".factory/scout/REPORT.md",
      ".factory/scout/mit/profile.json",
      ".factory/scout/mit/advisories.json",
    ])
      for (const agent of ["scout", "build", "factory"])
        expect([agent, file, evaluateWrite(ctx, agent, file).effect]).toEqual([agent, file, "deny"])
    expect(evaluateWrite(ctx, "scout", ".factory/scout/notes/shortlist.md").effect).toBe("allow")
    expect(evaluateWrite(ctx, "scout", ".factory/harvest/notes/x.md").effect).toBe("deny")
    expect(evaluateWrite(ctx, "scout", "src/index.ts").effect).toBe("deny")
  })
})
