// The opt-in eval grader: contains / notContains (case-insensitive), tools
// used / not used, and error events, over an `opencode run --format json` stream.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { gradeAuditFire, gradeOutput, gradeScoutFire, gradeTranscript, readTranscript } from "../src/index.ts"

describe("the eval grader", () => {
  test("empty checks always pass", () => {
    expect(gradeOutput("anything", {})).toEqual({ pass: true, failures: [] })
  })

  test("contains is case-insensitive", () => {
    expect(gradeOutput("Spend Ceiling: $5", { contains: ["spend ceiling"] }).pass).toBe(true)
    expect(gradeOutput("nothing here", { contains: ["spend ceiling"] })).toEqual({
      pass: false,
      failures: ["missing: spend ceiling"],
    })
  })

  test("notContains fails when a banned string appears", () => {
    expect(gradeOutput("an error: boom", { notContains: ["error:"] }).pass).toBe(false)
    expect(gradeOutput("all good", { notContains: ["error:"] }).pass).toBe(true)
  })

  test("collects every failure", () => {
    const grade = gradeOutput("hello", { contains: ["a", "b"], notContains: ["hello"] })
    expect(grade.pass).toBe(false)
    expect(grade.failures).toEqual(["missing: a", "missing: b", "must not contain: hello"])
  })
})

describe("transcripts", () => {
  const events = [
    { type: "step_start", part: {} },
    { type: "tool_use", part: { tool: "es_brainstorm_plan", state: { status: "completed" } } },
    { type: "step_start", part: {} },
    { type: "text", part: { text: "Lenses: Inversion, SCAMPER." } },
  ]

  test("text, tools and steps are read from the event stream", () => {
    expect(readTranscript(events)).toEqual({
      text: "Lenses: Inversion, SCAMPER.",
      tools: ["es_brainstorm_plan"],
      errors: [],
      steps: 2,
    })
  })

  test("tool checks and error events grade the run", () => {
    const transcript = readTranscript(events)
    expect(gradeTranscript(transcript, { toolsUsed: ["es_brainstorm_plan"], contains: ["inversion"] }).pass).toBe(true)
    expect(gradeTranscript(transcript, { toolsNotUsed: ["es_brainstorm_plan"] }).failures).toEqual([
      "must not call: es_brainstorm_plan",
    ])
    const failed = readTranscript([...events, { type: "error", error: { message: "Agent not found" } }])
    expect(gradeTranscript(failed, {}).failures).toEqual(["error event: Agent not found"])
  })
})

describe("fire graders", () => {
  const plants = [{ id: "sqli", file: "src/a.ts", lines: [4, 5] as [number, number], cwe: ["CWE-89"] }]
  const record = (findings: any[], verdict: "pass" | "fail" = "fail") => ({
    audit: "audit-01",
    round: 1,
    seat: "auditor-antithesis" as const,
    by: "x",
    verdict,
    notes: "",
    findings,
    at: "t",
  })
  const vuln = (extra: Record<string, unknown> = {}) => ({
    kind: "vulnerability",
    title: "t",
    severity: "high",
    cwe: "CWE-89",
    file: "src/a.ts",
    lines: [5, 6],
    excerpt: "e",
    detail: "detail text",
    remediation: "r",
    ...extra,
  })

  test("an audit fire is caught only with the right file, an accepted CWE and overlapping lines", () => {
    expect(gradeAuditFire([record([vuln()])], plants)).toEqual({ pass: true, caught: ["sqli"], failures: [] })
    expect(gradeAuditFire([record([vuln({ cwe: "CWE-78" })])], plants).pass).toBe(false)
    expect(gradeAuditFire([record([vuln({ lines: [9, 9] })])], plants).failures[0]).toContain("missed sqli")
    expect(gradeAuditFire([record([vuln({ file: "src/b.ts" })])], plants).pass).toBe(false)
    expect(gradeAuditFire([record([vuln({ kind: "debt" })])], plants).pass).toBe(false)
    expect(gradeAuditFire([record([vuln()], "pass")], plants).failures).toContain("no auditor failed the audit")
  })

  test("a scout fire needs every verdict right, and downgrades must say why", () => {
    const verdict = (name: string, proposal: string, final: string, downgraded?: string) => ({
      candidate: name,
      name,
      license: {} as any,
      proposal,
      verdict: final,
      warnings: [],
      rank: 1,
      ...(downgraded ? { downgraded } : {}),
    })
    const result = (verdicts: any[]) => ({ version: 1 as const, objective: "x", verdicts, completedAt: "t" })
    const want = [
      { name: "mit", verdict: "adopt" },
      { name: "gpl", verdict: "clean-room" },
    ]
    expect(
      gradeScoutFire(
        result([verdict("mit", "adopt", "adopt"), verdict("gpl", "adopt", "clean-room", "copyleft")]),
        want,
      ).pass,
    ).toBe(true)
    expect(
      gradeScoutFire(result([verdict("mit", "adopt", "adopt"), verdict("gpl", "adopt", "adopt")]), want).failures,
    ).toEqual(["gpl: adopt, expected clean-room"])
    expect(
      gradeScoutFire(result([verdict("mit", "adopt", "adopt"), verdict("gpl", "adopt", "clean-room")]), want).failures,
    ).toEqual(["gpl: downgraded without a reason"])
    expect(gradeScoutFire(result([verdict("mit", "adopt", "adopt")]), want).failures).toEqual(["no verdict for gpl"])
  })
})

describe("eval cases (evals/cases)", () => {
  const repo = path.resolve(import.meta.dir, "../../..")
  const cases = readdirSync(path.join(repo, "evals/cases"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ file, body: JSON.parse(readFileSync(path.join(repo, "evals/cases", file), "utf8")) }))

  test("every case names an agent, a prompt and checks; seed fixtures exist; fires are well formed", () => {
    expect(cases.map((item) => item.file)).toEqual(
      expect.arrayContaining(["audit-fires.json", "scout-fires.json", "grill.json"]),
    )
    for (const { file, body } of cases) {
      expect([file, typeof body.id, typeof body.agent, typeof body.prompt]).toEqual([
        file,
        "string",
        "string",
        "string",
      ])
      for (const value of Object.values((body.files ?? {}) as Record<string, string>))
        if (value.startsWith("@fixture:"))
          expect([file, value, existsSync(path.join(repo, "packages/core/test/fixtures", value.slice(9)))]).toEqual([
            file,
            value,
            true,
          ])
      if (body.fire) expect([file, ["audit", "scout"].includes(body.fire.kind)]).toEqual([file, true])
    }
  })

  test("the seeded audit-fire state is a valid v2 run with the open audit", async () => {
    const { FactoryStateSchema } = await import("../src/factory/state.ts")
    const audit = cases.find((item) => item.file === "audit-fires.json")!.body
    const state = FactoryStateSchema.parse(JSON.parse(audit.files[".factory/runtime/state.json"]))
    expect(state.audits.map((item) => [item.id, item.status])).toEqual([["audit-01", "open"]])
  })
})
