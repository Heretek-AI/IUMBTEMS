// Issue #194 ("2. Integration tests") on the real in-process OpenCode v2 host
// (testkit boot, scripted fake LLM, beside fires.test.ts):
//  - a scout-proposed `adopt` for GPL/AGPL/unlicensed candidates is downgraded
//    to clean-room by core, including under a narrowed license whitelist;
//  - a candidate with OSV advisories shows the citation (cached sha256,
//    witnessed claims, verdict warnings) at the host level;
//  - probe (NOT a fix) of bug #257 path (a): completing with neither
//    advisories nor a recorded skip was a silent clean adopt; paths (b) and
//    (c) are enforced below at the host level for registry candidates, whose
//    scanned origin pins the advisory coordinates;
//  - scout-named sandbox probes: host webfetch/websearch denied and an
//    offline shell for the `scout` seat specifically (alpha probes exist in
//    scoping.test.ts; these name the scout).
// Product code is untouched: a red test here is a finding, never a fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  bwrapAvailable,
  factoryLayout,
  gradeScoutFire,
  readScoutResult,
  researchSourcesDir,
  SourceCache,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness, lastAgentRequest } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const fixtures = path.resolve(import.meta.dir, "../../core/test/fixtures")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const read = (file: string) => readFileSync(path.join(fixtures, file), "utf8")
const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}
const plantVendor = async (root: string, name: string, licenseFile: string | null) => {
  const dir = `vendor/${name}`
  await write(root, `${dir}/index.js`, `module.exports = function ${name}() { return 1 }\n`)
  await write(root, `${dir}/package.json`, JSON.stringify({ name, version: "1.0.0" }))
  if (licenseFile) await write(root, `${dir}/LICENSE`, read(`licenses/${licenseFile}.txt`))
}
// es_scout_complete requires advisories or an explicit skip per candidate
// (#257 enforcement): local fixtures have no published package to query,
// so the skip is recorded, not silently omitted (a50ced8 precedent).
const advisorySkip = (name: string) => ({
  tag: "NEGATIVE_KNOWLEDGE",
  statement: `OSV advisories were not queried for ${name}`,
  query: `OSV advisories for ${name}`,
  finding: "skipped: a local fixture with no published package",
})

const recordAdopt = (name: string, claims: ReadonlyArray<Record<string, unknown>> = [advisorySkip(name)]) =>
  call("es_scout_record", {
    candidate: name,
    maintenance: "stable",
    proposal: "adopt",
    rationale: "it does what we need",
    claims: [...claims],
  })

// Canned OSV /v1/query body (same shape as packages/core/test/scout.test.ts):
// one HIGH with a fix, one CRITICAL without, one LOW (listed, not flagged).
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

// The host plugin calls the global fetch for api.osv.dev (no fetch is
// injected in packages/opencode/src/tools.ts), so the host-level advisory
// tests stub it process-wide and delegate everything else (notably the fake
// LLM traffic) to the real fetch.
const realFetch = globalThis.fetch
let osvBodies: unknown[] = []
function stubOsv() {
  osvBodies = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input)
    if (url.includes("api.osv.dev")) {
      const body = JSON.parse(String(init?.body ?? "{}"))
      osvBodies.push(body)
      if (body.version === "9.9.9") return Response.json({ vulns: [] })
      return Response.json(OSV)
    }
    return realFetch(input, init)
  }) as unknown as typeof fetch
}
const unstubOsv = () => {
  globalThis.fetch = realFetch
}

let state: string
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-scout-194-"))
})
afterAll(async () => {
  unstubOsv()
  await rm(state, { recursive: true, force: true })
})

async function bootHost(options: Record<string, unknown> = {}): Promise<Harness> {
  return boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off", ...options } }],
    files: { "README.md": "# scout-194\n" },
  })
}

describe("issue #194: core downgrades scout-proposed adopt on the real host", () => {
  let h: Harness
  beforeAll(async () => {
    h = await bootHost()
  }, 60_000)
  afterAll(() => h?.close())

  test("GPL, AGPL and unlicensed candidates end clean-room with reasons; MIT stays adopt", async () => {
    const names = ["mit", "gpl", "agpl", "none"] as const
    const licenses: Record<string, string | null> = {
      mit: "MIT",
      gpl: "GPL-3.0-only",
      agpl: "AGPL-3.0-only",
      none: null,
    }
    for (const name of names) await plantVendor(h.directory, name, licenses[name]!)
    const calls = [
      call("es_scout_plan", {
        objective: "a function library",
        candidates: names.map((name) => ({ name, source: `local:./vendor/${name}` })),
      }),
      ...names.map((name) => call("es_scout_scan", { candidate: name })),
      ...names.map((name) => recordAdopt(name)),
      call("es_scout_complete"),
    ]
    const { tools } = await h.run(`scout ${calls.join(" ")}`, { agent: "scout" })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(tools.map((tool) => `${tool.name}:completed`))
    const result = (await readScoutResult(h.directory))!
    const byId = Object.fromEntries(result.verdicts.map((item) => [item.candidate, item]))
    expect([byId.mit?.proposal, byId.mit?.verdict]).toEqual(["adopt", "adopt"])
    for (const id of ["gpl", "agpl"]) {
      expect([id, byId[id]?.proposal, byId[id]?.verdict]).toEqual([id, "adopt", "clean-room"])
      expect(byId[id]?.downgraded).toContain("copyleft")
    }
    expect([byId.none?.proposal, byId.none?.verdict]).toEqual(["adopt", "clean-room"])
    expect(byId.none?.downgraded).toMatch(/unknown|unverified/)
    const grade = gradeScoutFire(result, [
      { name: "mit", verdict: "adopt" },
      { name: "gpl", verdict: "clean-room" },
      { name: "agpl", verdict: "clean-room" },
      { name: "none", verdict: "clean-room" },
    ])
    expect(grade).toEqual({ pass: true, caught: ["mit", "gpl", "agpl", "none"], failures: [] })
  }, 120_000)

  test("scout-named sandbox: host webfetch and websearch are denied for the scout seat", async () => {
    for (const tool of ["webfetch", "websearch"]) {
      const args = tool === "webfetch" ? { url: "https://example.com" } : { query: "oss yaml parser" }
      const { tools } = await h.run(`probe ${call(tool, args)}`, { agent: "scout" })
      expect(tools.map((outcome) => `${outcome.name}:${outcome.status}`)).toEqual([`${tool}:error`])
      expect(tools[0]?.text).toContain("only through es_research_search and es_research_fetch")
    }
  }, 60_000)

  test("scout-named sandbox: the scout is offered no host web tools, but the cached research tools", async () => {
    await h.run("hello", { agent: "scout" })
    const offered = new Set((lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name))
    expect(offered.has("webfetch")).toBe(false)
    expect(offered.has("websearch")).toBe(false)
    expect(offered.has("es_research_fetch")).toBe(true)
    expect(offered.has("es_scout_complete")).toBe(true)
  }, 60_000)

  test("scout-named sandbox: a scout shell has no network", async () => {
    if (!bwrapAvailable()) {
      const { tools } = await h.run(`net ${call("shell", { command: "cat /proc/net/dev" })}`, { agent: "scout" })
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:error"])
      expect(tools[0]?.text).toContain("bubblewrap")
      return
    }
    const { tools } = await h.run(`net ${call("shell", { command: "cat /proc/net/dev" })}`, { agent: "scout" })
    const text = tools[0]?.text ?? ""
    if (/bwrap:|bubblewrap/i.test(text)) {
      // This environment cannot make the overlay mount, so the sandboxed
      // command never runs (the canonical alpha probe in scoping.test.ts
      // fails the same way here): no network was available either. Pin the
      // sandbox failure strictly instead of the interface list.
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:completed"])
      expect(text).toContain("Exited with code")
      return
    }
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["shell:completed"])
    const ifaces = tools[0]?.text
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => line.split(":")[0]?.trim() ?? "")
      .filter(Boolean)
    expect(ifaces).toEqual(["lo"])
  }, 60_000)
})

describe("issue #194: a narrowed license whitelist demotes verified permissive licenses on the host", () => {
  let h: Harness
  beforeAll(async () => {
    h = await bootHost({ licenseWhitelist: ["MIT"] })
  }, 60_000)
  afterAll(() => h?.close())

  test("MIT keeps adopt; Apache-2.0 proposed adopt ends clean-room", async () => {
    await plantVendor(h.directory, "mit", "MIT")
    await plantVendor(h.directory, "apache", "Apache-2.0")
    const names = ["mit", "apache"]
    const calls = [
      call("es_scout_plan", {
        objective: "a function library",
        candidates: names.map((name) => ({ name, source: `local:./vendor/${name}` })),
      }),
      ...names.map((name) => call("es_scout_scan", { candidate: name })),
      ...names.map((name) => recordAdopt(name)),
      call("es_scout_complete"),
    ]
    const { tools } = await h.run(`scout ${calls.join(" ")}`, { agent: "scout" })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(tools.map((tool) => `${tool.name}:completed`))
    const result = (await readScoutResult(h.directory))!
    const byId = Object.fromEntries(result.verdicts.map((item) => [item.candidate, item]))
    expect([byId.mit?.proposal, byId.mit?.verdict]).toEqual(["adopt", "adopt"])
    expect([byId.apache?.proposal, byId.apache?.verdict]).toEqual(["adopt", "clean-room"])
    expect(byId.apache?.downgraded).toContain("not on the license whitelist")
  }, 120_000)
})

describe("issue #194: OSV advisories are cited by hash on the real host", () => {
  let h: Harness
  beforeAll(async () => {
    h = await bootHost()
    await plantVendor(h.directory, "mit", "MIT")
  }, 60_000)
  afterAll(() => h?.close())

  test("advisories are fetched, cached, cited by sha256, witnessed, and flagged on the verdict", async () => {
    stubOsv()
    try {
      const planned = await h.run(
        call("es_scout_plan", {
          objective: "a function library",
          candidates: [{ name: "mit", source: "local:./vendor/mit" }],
        }),
        { agent: "scout" },
      )
      expect(planned.tools[0]?.status).toBe("completed")
      const scanned = await h.run(call("es_scout_scan", { candidate: "mit" }), { agent: "scout" })
      expect(scanned.tools[0]?.status).toBe("completed")
      const advisories = await h.run(
        call("es_scout_advisories", { candidate: "mit", ecosystem: "npm", package: "mit-lib", version: "1.0.0" }),
        { agent: "scout" },
      )
      expect(advisories.tools[0]?.status).toBe("completed")
      expect(osvBodies).toEqual([{ package: { name: "mit-lib", ecosystem: "npm" }, version: "1.0.0" }])
      const hash = /sha256:([0-9a-f]{64})/.exec(advisories.tools[0]?.text ?? "")?.[1]
      expect(hash).toBeDefined()
      const cached = await new SourceCache(researchSourcesDir(h.directory), state).get(hash!)
      expect(cached?.meta.provider).toBe("osv")

      const recorded = await h.run(recordAdopt("mit"), { agent: "scout" })
      expect(recorded.tools[0]?.status).toBe("completed")
      const completed = await h.run(call("es_scout_complete"), { agent: "scout" })
      expect(completed.tools[0]?.status).toBe("completed")

      const mit = (await readScoutResult(h.directory))!.verdicts.find((item) => item.candidate === "mit")!
      expect([mit.proposal, mit.verdict]).toEqual(["adopt", "adopt"])
      expect(mit.warnings).toEqual([
        "GHSA-aaaa-bbbb-cccc (HIGH): adopt only at 1.0.1 or later",
        "GHSA-dddd-eeee-ffff (CRITICAL) has no fixed release",
      ])
      const dossier = JSON.parse(await readFile(factoryLayout(h.directory).scoutDossier, "utf8"))
      const cited = dossier.claims.filter((claim: any) => claim.source?.sha256 === hash)
      expect(cited.length).toBe(3)
      expect(cited.every((claim: any) => claim.witness.ok)).toBe(true)
    } finally {
      unstubOsv()
    }
  }, 120_000)
})

describe("bug #257: the advisory step is pinned to the scanned origin (enforced)", () => {
  let h: Harness
  beforeAll(async () => {
    h = await bootHost()
    await plantVendor(h.directory, "mit", "MIT")
  }, 60_000)
  afterAll(() => h?.close())

  test("(a) completing with neither advisories nor a recorded skip is refused (#257 enforced)", async () => {
    const planned = await h.run(
      call("es_scout_plan", {
        objective: "a function library",
        candidates: [{ name: "mit", source: "local:./vendor/mit" }],
      }),
      { agent: "scout" },
    )
    expect(planned.tools[0]?.status).toBe("completed")
    const scanned = await h.run(call("es_scout_scan", { candidate: "mit" }), { agent: "scout" })
    expect(scanned.tools[0]?.status).toBe("completed")
    const recorded = await h.run(recordAdopt("mit", []), { agent: "scout" })
    expect(recorded.tools[0]?.status).toBe("completed")
    // No advisories and no explicit skip: the completion refuses instead
    // of the old silent clean adopt.
    const refused = await h.run(call("es_scout_complete"), { agent: "scout" })
    expect(refused.tools[0]?.status).toBe("error")
    expect(refused.tools[0]?.text).toContain("query its advisories")
    // Recording the skip unblocks it: clean adopt, zero warnings, and the
    // skip itself cited in the dossier (not a silent omission).
    const rerecorded = await h.run(recordAdopt("mit"), { agent: "scout" })
    expect(rerecorded.tools[0]?.status).toBe("completed")
    const completed = await h.run(call("es_scout_complete"), { agent: "scout" })
    expect(completed.tools[0]?.status).toBe("completed")
    const mit = (await readScoutResult(h.directory))!.verdicts.find((item) => item.candidate === "mit")!
    expect([mit.proposal, mit.verdict]).toEqual(["adopt", "adopt"])
    expect(mit.warnings).toEqual([])
    const dossier = JSON.parse(await readFile(factoryLayout(h.directory).scoutDossier, "utf8"))
    expect(dossier.claims.map((claim: any) => claim.tag)).toEqual(["NEGATIVE_KNOWLEDGE"])
  }, 120_000)

  test("(b) a hand-supplied wrong ecosystem/package for a registry candidate is refused (#257 enforced)", async () => {
    stubOsv()
    try {
      const planned = await h.run(
        call("es_scout_plan", {
          objective: "a tiny function library",
          candidates: [{ name: "leftpad", source: "npm:left-pad" }],
        }),
        { agent: "scout" },
      )
      expect(planned.tools[0]?.status).toBe("completed")
      // No network is touched: the mismatch is refused before any OSV query,
      // naming the scanned origin and what was supplied.
      for (const args of [
        { candidate: "leftpad", ecosystem: "PyPI", package: "left-pad" },
        { candidate: "leftpad", ecosystem: "npm", package: "other-pkg" },
      ]) {
        const refused = await h.run(call("es_scout_advisories", args), { agent: "scout" })
        expect(refused.tools[0]?.status).toBe("error")
        expect(refused.tools[0]?.text).toContain("must be queried for the scanned source (npm:left-pad)")
        expect(refused.tools[0]?.text).toContain(`got ${args.ecosystem}:${args.package}`)
      }
      expect(osvBodies).toEqual([])
      // The candidate's own coordinates proceed to the (canned) OSV query.
      // (Non-registry sources have no scanned origin to pin: their advisory
      // coordinates stay agent-supplied by design, as the OSV-cited test above
      // exercises with its vendored fixture.)
      const done = await h.run(
        call("es_scout_advisories", { candidate: "leftpad", ecosystem: "npm", package: "left-pad" }),
        { agent: "scout" },
      )
      expect(done.tools[0]?.status).toBe("completed")
      expect(osvBodies).toEqual([{ package: { name: "left-pad", ecosystem: "npm" } }])
    } finally {
      unstubOsv()
    }
  }, 120_000)

  test("(c) an agent-controlled version dodging the scanned release is refused (#257 enforced)", async () => {
    stubOsv()
    try {
      const planned = await h.run(
        call("es_scout_plan", {
          objective: "a tiny function library",
          candidates: [{ name: "leftpad", source: "npm:left-pad" }],
        }),
        { agent: "scout" },
      )
      expect(planned.tools[0]?.status).toBe("completed")
      // A scanned registry profile pins release 1.0.0 (written directly: no network).
      const profileFile = factoryLayout(h.directory).scoutProfile("leftpad")
      await mkdir(path.dirname(profileFile), { recursive: true })
      await writeFile(
        profileFile,
        JSON.stringify({
          version: 1,
          id: "leftpad",
          name: "left-pad",
          origin: "npm:left-pad",
          release: "1.0.0",
          license: { spdx: "MIT", family: "permissive", source: "registry", confidence: "medium", verified: false },
          languages: {},
          dependencies: { runtime: [], dev: [] },
          size: { files: 0, bytes: 0, tokens: 0 },
          graph: { internalEdges: 0, external: 0, parsers: { treeSitter: 0, regex: 0 } },
          provenance: {},
          warnings: [],
          scannedAt: new Date().toISOString(),
        }),
      )
      const refused = await h.run(
        call("es_scout_advisories", {
          candidate: "leftpad",
          ecosystem: "npm",
          package: "left-pad",
          version: "9.9.9",
        }),
        { agent: "scout" },
      )
      expect(refused.tools[0]?.status).toBe("error")
      expect(refused.tools[0]?.text).toContain("does not match the scanned release 1.0.0")
      expect(osvBodies).toEqual([])
      const done = await h.run(
        call("es_scout_advisories", {
          candidate: "leftpad",
          ecosystem: "npm",
          package: "left-pad",
          version: "1.0.0",
        }),
        { agent: "scout" },
      )
      expect(done.tools[0]?.status).toBe("completed")
      expect(osvBodies).toEqual([{ package: { name: "left-pad", ecosystem: "npm" }, version: "1.0.0" }])
      expect(done.tools[0]?.text).toContain("GHSA-aaaa-bbbb-cccc")
    } finally {
      unstubOsv()
    }
  }, 120_000)
})
