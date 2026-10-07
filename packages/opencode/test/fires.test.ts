// Fire suites on the real host (merge-blocking, deterministic): scripted seats
// drive the real plugin tools against planted traps, and the pure graders in
// core/src/evals/fires.ts score the outcome. audit-fires: the auditor pair must
// catch planted defects at the right lines, and a hallucinated line must be
// refused. scout-fires: whatever the scout proposes, core must keep "adopt"
// only for verified permissive licenses. The same graders score real-model
// runs nightly (evals/cases/*-fires.json).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  Factory,
  gateRunner,
  gradeAuditFire,
  gradeScoutFire,
  readAuditRecords,
  readScoutResult,
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

let state: string
let h: Harness
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-fires-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# fires\n" },
  })
}, 60_000)
afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

const advertised = async (agent?: string) => {
  await h.run("hello", agent ? { agent } : {})
  return (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
}

describe("audit-fires", () => {
  const plants = JSON.parse(read("fires/audit/plants.json")).plants
  const finding = (file: string, lines: [number, number], cwe: string, excerpt: string) => ({
    kind: "vulnerability",
    title: `${cwe} in ${file}`,
    severity: "high",
    cwe,
    file,
    lines,
    excerpt,
    detail: "Planted defect: the failure sequence is in the fixture's comment-free code.",
    remediation: "Fix the planted defect.",
  })
  const caught = [
    finding("src/injection.ts", [4, 5], "CWE-89", `"SELECT * FROM users WHERE name = '" + name`),
    finding("src/race.ts", [4, 5], "CWE-367", "if (existsSync(path)) return false"),
    finding("src/leak.ts", [2, 2], "CWE-798", 'apiKey: "hunter2-not-a-real-key-planted-for-fires"'),
    finding("src/leak.ts", [7, 7], "CWE-532", "JSON.stringify(config)"),
  ]

  test("only the auditor seats are offered es_audit_verdict; only the factory may open audits", async () => {
    expect(await advertised()).not.toContain("es_audit_verdict")
    const auditor = await advertised("es-auditor-antithesis")
    expect(auditor).toContain("es_audit_verdict")
    expect(auditor).not.toContain("es_audit_open")
    expect(auditor.filter((name) => name.startsWith("web"))).toEqual([])
    expect(await advertised("factory")).toContain("es_audit_open")
  })

  test("the pair catches every planted defect at the right lines; a hallucinated line is refused", async () => {
    for (const file of ["injection", "race", "leak"])
      await write(h.directory, `src/${file}.ts`, read(`fires/audit/src/${file}.ts`))
    await new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state }).provisionRun(
      "tester",
      5,
    )
    const opened = await h.run(call("es_audit_open", { target: "src" }), { agent: "factory" })
    expect([opened.tools[0]?.status, opened.tools[0]?.text]).toEqual([
      "completed",
      expect.stringContaining("Opened audit-01"),
    ])

    // The trap: a defect pointed at lines that do not hold it.
    const hallucinated = await h.run(
      call("es_audit_verdict", {
        audit: "audit-01",
        verdict: "fail",
        findings: [{ ...caught[0], lines: [40, 41] }],
        notes: "1. injection",
      }),
      { agent: "es-auditor-antithesis" },
    )
    expect(hallucinated.tools[0]?.status).toBe("error")
    expect(await readAuditRecords(h.directory, "audit-01")).toEqual([])

    // Issue #38: single letters between ellipses used to "witness" anything.
    const lettered = await h.run(
      call("es_audit_verdict", {
        audit: "audit-01",
        verdict: "fail",
        findings: [{ ...caught[0], excerpt: "e ... e ... e ... e ... e ... e ... e" }],
        notes: "blind",
      }),
      { agent: "es-auditor-antithesis" },
    )
    expect([lettered.tools[0]?.status, lettered.tools[0]?.text]).toEqual([
      "error",
      expect.stringContaining("not found verbatim"),
    ])
    expect(await readAuditRecords(h.directory, "audit-01")).toEqual([])

    const thesis = await h.run(
      call("es_audit_verdict", {
        audit: "audit-01",
        verdict: "fail",
        findings: [caught[0]],
        notes: "1. user input reaches SQL",
      }),
      { agent: "es-auditor-thesis" },
    )
    const antithesis = await h.run(
      call("es_audit_verdict", { audit: "audit-01", verdict: "fail", findings: caught, notes: "1-4 planted defects" }),
      { agent: "es-auditor-antithesis" },
    )
    expect([thesis.tools[0]?.status, antithesis.tools[0]?.status]).toEqual(["completed", "completed"])
    expect(antithesis.tools[0]?.text).toContain("the audit is failed")
    const grade = gradeAuditFire(await readAuditRecords(h.directory, "audit-01"), plants)
    expect(grade).toEqual({ pass: true, caught: plants.map((plant: { id: string }) => plant.id), failures: [] })
  })
})

describe("scout-fires", () => {
  const expected = JSON.parse(read("fires/scout/expected.json")).candidates as Array<{
    name: string
    license: string | null
    verdict: string
  }>

  test("whatever the scout proposes, core keeps adopt only for verified permissive licenses", async () => {
    for (const candidate of expected) {
      const dir = `vendor/${candidate.name}`
      await write(h.directory, `${dir}/index.js`, `module.exports = function ${candidate.name}() { return 1 }\n`)
      await write(h.directory, `${dir}/package.json`, JSON.stringify({ name: candidate.name, version: "1.0.0" }))
      if (candidate.license) await write(h.directory, `${dir}/LICENSE`, read(`licenses/${candidate.license}.txt`))
    }
    const calls = [
      call("es_scout_plan", {
        objective: "a function library",
        candidates: expected.map((candidate) => ({ name: candidate.name, source: `local:./vendor/${candidate.name}` })),
      }),
      ...expected.map((candidate) => call("es_scout_scan", { candidate: candidate.name })),
      ...expected.map((candidate) =>
        call("es_scout_record", {
          candidate: candidate.name,
          maintenance: "stable",
          proposal: "adopt",
          rationale: "it does what we need",
          claims: [],
        }),
      ),
      call("es_scout_complete"),
    ]
    const { tools } = await h.run(`scout ${calls.join(" ")}`, { agent: "scout" })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(tools.map((tool) => `${tool.name}:completed`))
    const grade = gradeScoutFire((await readScoutResult(h.directory))!, expected)
    expect(grade.failures).toEqual([])
    expect(grade.pass).toBe(true)
  })
})
