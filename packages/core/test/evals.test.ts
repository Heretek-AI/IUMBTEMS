// The opt-in eval grader: contains / notContains (case-insensitive), tools
// used / not used, and error events, over an `opencode run --format json` stream.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  caseStepCap,
  DEFAULT_CASE_STEPS,
  gradeAuditFire,
  gradeHarvestFire,
  gradeOutput,
  gradeScoutFire,
  gradeTranscript,
  readTranscript,
} from "../src/index.ts"

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
      completed: ["es_brainstorm_plan"],
      errors: [],
      steps: 2,
      costUSD: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
  })

  test("a tool that errored was called but does not count as used", () => {
    const refused = readTranscript([
      { type: "step_start", part: {} },
      { type: "tool_use", part: { tool: "es_scout_complete", state: { status: "error", error: "refused" } } },
    ])
    expect(refused.tools).toEqual(["es_scout_complete"])
    expect(refused.completed).toEqual([])
    expect(gradeTranscript(refused, { toolsUsed: ["es_scout_complete", "es_scout_plan"] }).failures).toEqual([
      "called but did not complete: es_scout_complete",
      "did not call: es_scout_plan",
    ])
    // An attempt at a forbidden tool still counts, even when the host refused it.
    expect(gradeTranscript(refused, { toolsNotUsed: ["es_scout_complete"] }).failures).toEqual([
      "must not call: es_scout_complete",
    ])
  })

  test("spend and tokens are summed from step_finish", () => {
    const finish = (cost: number, input: number, output: number) => ({
      type: "step_finish",
      part: { cost, tokens: { input, output, reasoning: 1, cache: { read: 2, write: 3 } } },
    })
    const transcript = readTranscript([finish(0.25, 100, 10), { type: "step_start", part: {} }, finish(0.5, 50, 5)])
    expect(transcript.costUSD).toBe(0.75)
    expect(transcript.tokens).toEqual({ input: 150, output: 15, reasoning: 2, cacheRead: 4, cacheWrite: 6 })
    // Missing or non-numeric fields count as zero rather than poisoning the sum.
    expect(readTranscript([{ type: "step_finish", part: { cost: "n/a" } }]).costUSD).toBe(0)
  })

  test("a completed call's output is graded text, except raw evidence and errored calls", () => {
    const transcript = readTranscript([
      { type: "step_start", part: {} },
      {
        type: "tool_use",
        part: { tool: "es_gates_run", state: { status: "completed", output: "Gates passed: 0 error(s)" } },
      },
      {
        type: "tool_use",
        part: { tool: "es_research_fetch", state: { status: "completed", output: "single file path" } },
      },
      {
        type: "tool_use",
        part: { tool: "es_gates_run", state: { status: "error", output: "Gates failed: 9 error(s)" } },
      },
    ])
    expect(gradeTranscript(transcript, { contains: ["0 error(s)"] }).pass).toBe(true)
    expect(gradeTranscript(transcript, { contains: ["single file path"] }).failures).toEqual([
      "missing: single file path",
    ])
    expect(gradeTranscript(transcript, { contains: ["9 error(s)"] }).failures).toEqual(["missing: 9 error(s)"])
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

describe("step caps", () => {
  test("a case's own maxSteps wins; the env value is only a ceiling", () => {
    expect(caseStepCap(14, 16)).toBe(14)
    expect(caseStepCap(8, 6)).toBe(6)
    expect(caseStepCap(undefined, 16)).toBe(DEFAULT_CASE_STEPS)
    expect(caseStepCap(undefined, 3)).toBe(3)
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
    // A blanket range that merely overlaps the plant is a guess, not a catch.
    expect(gradeAuditFire([record([vuln({ lines: [1, 60] })])], plants).pass).toBe(false)
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
    // Extra or duplicate rows are not graded away (issue #48).
    const both = [verdict("mit", "adopt", "adopt"), verdict("gpl", "adopt", "clean-room", "copyleft")]
    expect(gradeScoutFire(result([...both, verdict("evil", "adopt", "adopt")]), want).failures).toEqual([
      "unexpected verdict for evil",
    ])
    expect(gradeScoutFire(result([...both, verdict("gpl", "adopt", "adopt")]), want).failures).toEqual([
      "2 verdicts for gpl",
    ])
    // One row cannot cover two expected candidates (name matches one, candidate another).
    const double = { ...verdict("mit", "adopt", "adopt"), candidate: "gpl" }
    expect(gradeScoutFire(result([double]), want).failures).toEqual([
      "one verdict row matches several expected candidates: mit, gpl",
      "no verdict for mit",
      "no verdict for gpl",
    ])
  })

  test("a harvest fire wants the licence line kept: permissive depend, copyleft clean-room", () => {
    const cell = (candidate: string, verdict: "depend" | "clean-room") => ({ candidate, verdict })
    const matrix = (cells: ReturnType<typeof cell>[]) =>
      ({
        version: 1,
        candidates: cells.map((item) => item.candidate),
        rows: [{ feature: "f", cells }],
        licensePolicy: { whitelist: ["MIT"], failClosed: true },
        builtAt: "t",
      }) as any
    const want = [
      { candidate: "mit", verdict: "depend" },
      { candidate: "gpl", verdict: "clean-room" },
    ]
    expect(gradeHarvestFire(matrix([cell("mit", "depend"), cell("gpl", "clean-room")]), want)).toEqual({
      pass: true,
      caught: ["mit", "gpl"],
      failures: [],
    })
    expect(gradeHarvestFire(matrix([cell("mit", "depend"), cell("gpl", "depend")]), want).failures).toEqual([
      "gpl: depend, expected clean-room",
    ])
    expect(gradeHarvestFire(matrix([cell("mit", "depend")]), want).failures).toEqual(["no matrix cell for gpl"])
  })
})

describe("eval cases (evals/cases)", () => {
  const repo = path.resolve(import.meta.dir, "../../..")
  const cases = readdirSync(path.join(repo, "evals/cases"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ file, body: JSON.parse(readFileSync(path.join(repo, "evals/cases", file), "utf8")) }))

  test("every case names an agent, a prompt and checks; seed fixtures exist; fires are well formed", () => {
    expect(cases.map((item) => item.file)).toEqual(
      expect.arrayContaining(["audit-fires.json", "darkharvest-fires.json", "scout-fires.json", "grill.json"]),
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
      if (body.fire) expect([file, ["audit", "scout", "harvest"].includes(body.fire.kind)]).toEqual([file, true])
      if (body.modelLimited !== undefined)
        expect([file, typeof body.modelLimited === "string" && body.modelLimited.length > 0]).toEqual([file, true])
      // Each case sizes its own cap for a one-call-per-step model, within the step ceiling (24).
      expect([file, Number.isInteger(body.maxSteps) && body.maxSteps >= 2 && body.maxSteps <= 24]).toEqual([file, true])
    }
  })

  test("the seeded audit-fire state is a valid v2 run with the open audit", async () => {
    const { FactoryStateSchema } = await import("../src/factory/state.ts")
    const audit = cases.find((item) => item.file === "audit-fires.json")!.body
    const state = FactoryStateSchema.parse(JSON.parse(audit.files[".factory/runtime/state.json"]))
    expect(state.audits.map((item) => [item.id, item.status])).toEqual([["audit-01", "open"]])
  })

  test("the staged thesis state is a valid v2 run with audit-01 open on src (#139)", async () => {
    const { FactoryStateSchema } = await import("../src/factory/state.ts")
    const thesis = cases.find((item) => item.file === "auditor-thesis.json")!.body
    const state = FactoryStateSchema.parse(JSON.parse(thesis.files[".factory/runtime/state.json"]))
    expect(state.audits.map((item) => [item.id, item.status, item.target])).toEqual([
      ["audit-01", "open", { kind: "path", path: "src" }],
    ])
    expect(thesis.checks.toolsUsed).toContain("es_audit_verdict")
    expect(thesis.fire).toMatchObject({ kind: "audit", audit: "audit-01" })
    expect(thesis.prompt).toContain("audit-01")
  })

  test("the staged thesis fixture admits a verdict graded deterministically (#139)", async () => {
    const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const {
      Factory,
      codeAuditTools,
      gateRunner,
      gradeAuditFire,
      readAuditRecords,
    } = await import("../src/index.ts")
    const { signEngineFile } = await import("../src/trust/sidecar.ts")
    const thesis = cases.find((item) => item.file === "auditor-thesis.json")!.body
    const root = await mkdtemp(path.join(tmpdir(), "es-thesis-fixture-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-thesis-fixture-state-"))
    try {
      for (const [file, content] of Object.entries(thesis.files as Record<string, string>)) {
        const target = path.join(root, file)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, content)
      }
      await signEngineFile(path.join(root, ".factory/runtime/state.json"), state)
      const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
      const verdict = codeAuditTools({ root, factory, stateDir: state }).find(
        (tool) => tool.name === "es_audit_verdict",
      )!
      const excerpt =
        "const query = \"SELECT * FROM users WHERE name = '\" + username + \"' AND pass = '\" + password + \"'\""
      const out = await verdict.execute(
        {
          audit: "audit-01",
          verdict: "fail",
          findings: [
            {
              kind: "vulnerability",
              title: "SQL injection in login",
              severity: "critical",
              cwe: "CWE-89",
              file: "src/login.ts",
              lines: [2, 2],
              excerpt,
              detail: "username and password concatenate into the query",
              remediation: "use parameterised queries",
            },
          ],
          notes: "CWE-89 in src/login.ts",
        },
        { agent: "es-auditor-thesis" },
      )
      expect(out).toContain("Recorded fail for audit-01")
      const grade = gradeAuditFire(await readAuditRecords(root, "audit-01"), thesis.fire.plants)
      expect(grade).toMatchObject({ pass: true, caught: ["sql-injection"] })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("the seeded programmer state is a valid v2 BUILD run with a worktree", async () => {
    const { FactoryStateSchema } = await import("../src/factory/state.ts")
    const prog = cases.find((item) => item.file === "programmer.json")!.body
    const state = FactoryStateSchema.parse(JSON.parse(prog.files[".factory/runtime/state.json"]))
    expect(state.stage).toBe("BUILD")
    expect(state.activePhase).toBe("phase-01")
    const phase = state.phases.find((item) => item.id === state.activePhase)!
    expect(phase.status).toBe("building")
    expect(phase.worktree).toBe(".factory/worktrees/phase-01")
    for (const file of ["package.json", "src/sum.ts", "test/sum.test.ts"])
      expect([file, typeof prog.files[`.factory/worktrees/phase-01/${file}`]]).toEqual([file, "string"])
  })
})
