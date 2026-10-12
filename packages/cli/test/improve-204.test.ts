// #204 integration through the CLI: harvest + distill over several
// unit-constructed run dirs (one with a broken audit chain); scrubbed
// output and the code-disposes gate dropping fabricated evidence with
// reasons.
//
// Unit-constructed only: no real factory runs, no timing/perf assertions,
// no --open-pr (human TTY; existing pipe-refusal coverage stands).
import { describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  appendAuditEntry,
  disposedWithReasons,
  disposeReason,
  distillProposals,
  factoryLayout,
  TelemetrySchema,
  undisposed,
} from "@heretek-ai/es-core"
import { main } from "../src/main.ts"
import type { ConfirmIO } from "../src/tty.ts"

const pipe: ConfirmIO = { interactive: false, write: () => {}, readLine: async () => "y", readSecret: async () => "" }

const GH_A = "ghp_cliHarvest001AAA"
const GH_BROKEN = "ghu_cliBroken999aaa"
const SK_ANT = "sk-ant-cliplanted0000Z"
const AKIA = "AKIAIOSFODNN7EXAMPLE"
const BEARER = "eyJhbGciOiJIUzI1NiJ9"
const GATE_RULE = "lint/no-unused-vars"

async function writeGateSummary(root: string, id: string): Promise<void> {
  const dir = path.join(factoryLayout(root).runs, id, "gates", "2026-10-04T00-30-full")
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, "summary.json"),
    `${JSON.stringify(
      {
        passed: false,
        findings: [
          { file: "src/x.ts", line: 3, rule: GATE_RULE, severity: "error", message: "unused", check: "lint" },
          { file: "src/y.ts", line: 9, rule: GATE_RULE, severity: "error", message: "unused", check: "lint" },
        ],
      },
      null,
      2,
    )}\n`,
  )
}

async function writeAuditRecords(root: string): Promise<void> {
  const dir = factoryLayout(root).audits
  await mkdir(path.join(dir, "audit-01"), { recursive: true })
  const finding = (title: string, detail: string) => ({
    kind: "invariant",
    title,
    severity: "high",
    file: "packages/core/src/trust/policy.ts",
    lines: [59, 75],
    excerpt: "export function evaluateWrite(context, agentId, target)",
    detail,
    holds: false,
  })
  await writeFile(
    path.join(dir, "audit-01", "records.json"),
    `${JSON.stringify(
      [
        {
          audit: "audit-01",
          round: 1,
          seat: "auditor-thesis",
          by: "auditor",
          verdict: "fail",
          notes: "notes",
          findings: [
            finding("control files are deny-write", "the programmer seat can write a control file path"),
            finding("control files are deny-write again", "a second invariant detail here"),
          ],
          at: "2026-10-04T00:00:00.000Z",
        },
      ],
      null,
      2,
    )}\n`,
  )
}

async function writeChain(root: string, haltReason: string): Promise<void> {
  await appendAuditEntry(root, { actor: "system", action: "stage.build" })
  await appendAuditEntry(root, {
    actor: "agent:qa",
    action: "qa.fail",
    payload: { phase: "p1", reason: "lint gate red" },
  })
  await appendAuditEntry(root, { actor: "system", action: "stage.halted", payload: { reason: haltReason } })
}

async function makeRun(parent: string, id: string, haltReason: string, broken: boolean): Promise<string> {
  const root = path.join(parent, id)
  await writeGateSummary(root, id)
  await writeAuditRecords(root)
  await writeChain(root, haltReason)
  if (broken) await appendFile(factoryLayout(root).audit, "not-json\n")
  return root
}

async function writeEvals(dir: string, failures: { id: string; failures: string[] }[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, "agg.json"),
    `${JSON.stringify(
      {
        at: "2026-10-04T00-00-00-000Z",
        model: "test/model",
        results: failures.map((entry, index) => ({
          id: entry.id,
          pass: entry.failures.length === 0,
          failures: entry.failures,
          steps: 4 + index,
        })),
      },
      null,
      2,
    )}\n`,
  )
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const visit = async (current: string): Promise<void> => {
    for (const name of await readdir(current)) {
      const full = path.join(current, name)
      const info = await stat(full).catch(() => undefined)
      if (info?.isDirectory()) await visit(full)
      else out.push(full)
    }
  }
  await visit(dir)
  return out.sort()
}

describe("issue #341: es improve optimize writes review-only proposals with a holdout split", () => {
  const attempt = (caseId: string, pass: boolean) => ({
    caseId,
    category: "algorithms" as const,
    pass,
    failures: pass ? [] : ["oracle red"],
    durationMs: 5,
  })
  const telemetry = {
    version: 2,
    harvestedAt: "2026-10-11T00:00:00.000Z",
    runs: [
      {
        id: "run-a",
        mode: "build",
        stage: "HALTED",
        spend: { usd: 1, estimated: false, events: 5 },
        phases: [],
        gateRejections: [{ rule: GATE_RULE, count: 2, logs: ["gates/s1/summary.json"] }],
        auditFindings: [],
        auditChain: { entries: 1, valid: true, trail: [] },
        seal: { valid: true },
      },
      {
        id: "run-b",
        mode: "build",
        stage: "HALTED",
        spend: { usd: 1, estimated: false, events: 5 },
        phases: [],
        gateRejections: [{ rule: GATE_RULE, count: 1, logs: ["gates/s1/summary.json"] }],
        auditFindings: [],
        auditChain: { entries: 1, valid: true, trail: [] },
        seal: { valid: true },
      },
    ],
    evals: [],
  }
  const baseline = {
    a: { pass: true, durationMs: 4 },
    b: { pass: false, durationMs: 4 },
    c: { pass: true, durationMs: 4 },
    d: { pass: false, durationMs: 4 },
  }
  const BASE_PROMPT = "Solve the task. Keep the module compiling."
  // Stub grader: guidance that names the failing rule fixes the red cases.
  const grade = async (prompt: string) =>
    prompt.includes(GATE_RULE)
      ? {
          attempts: [attempt("a", true), attempt("b", true), attempt("c", true), attempt("d", true)],
          costUSD: 0.04,
          steps: 8,
        }
      : {
          attempts: [attempt("a", true), attempt("b", false), attempt("c", true), attempt("d", false)],
          costUSD: 0.04,
          steps: 8,
        }

  test("fake-grader end to end: proposal dir with before/after receipts, no prompt file changed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-341-cli-root-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-341-cli-state-"))
    try {
      const { improveOptimize } = await import("../src/improve.ts")
      const telemetryFile = path.join(root, "telemetry.json")
      const promptFile = path.join(root, "prompt.md")
      const baselineFile = path.join(root, "baseline.json")
      const proposalsDir = path.join(root, "proposals")
      await writeFile(telemetryFile, `${JSON.stringify(telemetry, null, 2)}\n`)
      await writeFile(promptFile, `${BASE_PROMPT}\n`)
      await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
      const assetsDir = path.join(import.meta.dir, "..", "..", "core", "assets", "prompts")
      const beforeAssets: Record<string, string> = {}
      for (const name of await readdir(assetsDir))
        beforeAssets[name] = await readFile(path.join(assetsDir, name), "utf8")
      const printed: string[] = []
      const code = await improveOptimize(
        {
          positionals: [],
          flags: {
            telemetry: telemetryFile,
            prompt: promptFile,
            baseline: baselineFile,
            out: proposalsDir,
            "max-usd": "5",
          },
        },
        { print: (text) => printed.push(text), cwd: root, confirm: pipe },
        root,
        { grade },
      )
      expect(code).toBe(0)
      expect(printed.join("\n")).toContain("Nothing was applied")
      const files = await walkFiles(proposalsDir)
      const proposals = files.filter((file) => path.basename(file) === "proposal.json")
      expect(proposals.length).toBeGreaterThan(0)
      for (const file of proposals) {
        const proposal = JSON.parse(await readFile(file, "utf8"))
        expect(proposal.candidate.prompt).toContain(GATE_RULE)
        expect(proposal.after.regressions).toEqual([])
        expect(proposal.after.holdoutRegressions).toEqual([])
        expect(proposal.after.selection.length).toBeGreaterThan(0)
        expect(proposal.after.holdout.length).toBeGreaterThan(0)
        expect([...proposal.after.selection, ...proposal.after.holdout].sort()).toEqual(["a", "b", "c", "d"])
        const patch = await readFile(path.join(path.dirname(file), "prompt.patch.md"), "utf8")
        expect(patch).toContain("## Before")
        expect(patch).toContain("## After")
      }
      // Review-only: the prompt file and every shipped asset are byte-identical.
      expect(await readFile(promptFile, "utf8")).toBe(`${BASE_PROMPT}\n`)
      for (const [name, content] of Object.entries(beforeAssets))
        expect(await readFile(path.join(assetsDir, name), "utf8")).toBe(content)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a spend cap is required, like the other spend-bearing verbs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-341-cli-cap-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-341-cli-cap-state-"))
    try {
      const run = async (argv: string[]) => {
        const printed: string[] = []
        const code = await main(argv, {
          print: (text) => printed.push(text),
          confirm: pipe,
          cwd: root,
          stateDir: state,
        })
        return { code, out: printed.join("\n") }
      }
      const telemetryFile = path.join(root, "telemetry.json")
      const promptFile = path.join(root, "prompt.md")
      const baselineFile = path.join(root, "baseline.json")
      await writeFile(telemetryFile, `${JSON.stringify(telemetry, null, 2)}\n`)
      await writeFile(promptFile, `${BASE_PROMPT}\n`)
      await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
      const noCap = await run([
        "improve",
        "optimize",
        "--telemetry",
        telemetryFile,
        "--prompt",
        promptFile,
        "--baseline",
        baselineFile,
        "--out",
        path.join(root, "proposals"),
      ])
      expect(noCap.code).toBe(2)
      expect(noCap.out).toContain("spend ceiling")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("the model grader stops at the spend cap instead of overspending", async () => {
    const { makeModelGrader } = await import("../src/improve.ts")
    const { BENCHMARKS } = await import("@heretek-ai/es-core")
    const cases = [BENCHMARKS[0]!, BENCHMARKS[1]!, BENCHMARKS[2]!]
    let calls = 0
    const runner = {
      runCase: async () => {
        calls++
        return { pass: true, failures: [] as string[], durationMs: 5, steps: 2, costUSD: 3 }
      },
    }
    // $5 covers two $3 cases; the third halts instead of overspending.
    const capped = makeModelGrader({ cases, runner, budgetUSD: 5 })
    await expect(capped("candidate")).rejects.toThrow("spend cap")
    expect(calls).toBe(2)
    // $7 covers all three.
    calls = 0
    const open = makeModelGrader({ cases, runner, budgetUSD: 7 })
    const result = await open("candidate")
    expect(result.attempts.map((attempt) => attempt.caseId)).toEqual(cases.map((testCase) => testCase.id))
    expect(result.costUSD).toBe(9)
    expect(result.steps).toBe(6)
    expect(calls).toBe(3)
  })

  test("without a terminal the model path refuses instead of spending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "es-341-cli-pipe-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-341-cli-pipe-state-"))
    try {
      const telemetryFile = path.join(root, "telemetry.json")
      const promptFile = path.join(root, "prompt.md")
      const baselineFile = path.join(root, "baseline.json")
      await writeFile(telemetryFile, `${JSON.stringify(telemetry, null, 2)}\n`)
      await writeFile(promptFile, `${BASE_PROMPT}\n`)
      await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
      const printed: string[] = []
      const code = await main(
        [
          "improve",
          "optimize",
          "--telemetry",
          telemetryFile,
          "--prompt",
          promptFile,
          "--baseline",
          baselineFile,
          "--out",
          path.join(root, "proposals"),
          "--max-usd",
          "5",
        ],
        { print: (text) => printed.push(text), confirm: pipe, cwd: root, stateDir: state },
      )
      // A pipe is not a terminal: the spend path refuses (3), never grades.
      expect(code).toBe(3)
      expect(printed.join("\n")).toContain("interactive terminal")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("issue #204: es improve harvest + distill over several runs incl. a broken chain", () => {
  test("harvest reports the broken chain and scrubs planted tokens; distill writes all three kinds, drops fabrications", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "es-204-cli-"))
    const root = await mkdtemp(path.join(tmpdir(), "es-204-cli-root-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-204-cli-state-"))
    try {
      const run = async (argv: string[]) => {
        const printed: string[] = []
        const code = await main(argv, {
          print: (text) => printed.push(text),
          confirm: pipe,
          cwd: root,
          stateDir: state,
        })
        return { code, out: printed.join("\n") }
      }
      const runA = await makeRun(parent, "run-a", `halt A: GITHUB_TOKEN=${GH_A}`, false)
      const runB = await makeRun(parent, "run-b", `halt B: Bearer ${BEARER}`, false)
      const runBroken = await makeRun(parent, "run-broken", `halt C: ${GH_BROKEN}`, true)
      const brokenFile = factoryLayout(runBroken).audit
      const before = await readFile(brokenFile, "utf8")
      const evals = path.join(parent, "evals")
      await writeEvals(evals, [
        { id: "case-x", failures: ["gate lint red", "gate lint red", `leaked ${SK_ANT}`] },
        { id: "case-y", failures: ["gate lint red", `key ${AKIA} here`] },
        { id: "case-ok", failures: [] },
      ])
      const telemetryFile = path.join(root, "telemetry.json")
      const harvested = await run([
        "improve",
        "harvest",
        "--runs",
        `${runA},${runB},${runBroken}`,
        "--evals",
        evals,
        "--out",
        telemetryFile,
      ])
      expect(harvested.code).toBe(0)
      expect(harvested.out).toContain("3 run(s) and 3 eval(s)")
      const raw = await readFile(telemetryFile, "utf8")
      const telemetry = TelemetrySchema.parse(JSON.parse(raw))
      expect(telemetry.runs.map((entry) => entry.id)).toEqual(["run-a", "run-b", "run-broken"])
      for (const secret of [GH_A, GH_BROKEN, SK_ANT, AKIA, BEARER]) expect(raw).not.toContain(secret)
      expect(raw).toContain("GITHUB_TOKEN=")
      expect(raw).toContain("Bearer")
      const brokenTelemetry = telemetry.runs.find((entry) => entry.id === "run-broken")!
      expect(brokenTelemetry.auditChain.valid).toBe(false)
      expect(typeof brokenTelemetry.auditChain.error).toBe("string")
      // Reported, never repaired.
      expect(await readFile(brokenFile, "utf8")).toBe(before)
      const proposalsDir = path.join(root, "proposals")
      const distilled = await run([
        "improve",
        "distill",
        "--telemetry",
        telemetryFile,
        "--out",
        proposalsDir,
        "--min-occurrences",
        "2",
        "--min-runs",
        "2",
      ])
      expect(distilled.code).toBe(0)
      expect(distilled.out).toContain("Nothing was applied")
      expect(distilled.out).toContain("prompt-guidance")
      expect(distilled.out).toContain("gate-tuning")
      expect(distilled.out).toContain("domain-pack")
      const files = await walkFiles(proposalsDir)
      expect(files.some((file) => path.basename(file) === "gates.json")).toBe(false)
      expect(files.some((file) => path.basename(file) === "proposal.json")).toBe(true)
      // Fabricated evidence against the CLI-harvested telemetry is dropped with reasons.
      const proposals = await distillProposals(telemetry, { minOccurrences: 2, minRuns: 2 })
      expect(undisposed(proposals, telemetry)).toEqual(proposals)
      const [first] = proposals
      const forged = { ...first!, cluster: { ...first!.cluster, evidence: ["run x: invented quote"] } }
      expect(disposeReason(forged, telemetry).some((reason) => reason.includes("verbatim"))).toBe(true)
      expect(undisposed([forged], telemetry)).toEqual([])
      expect(disposedWithReasons([forged], telemetry)[0]!.reasons.length).toBeGreaterThan(0)
    } finally {
      await rm(parent, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a hallucinated model numeral is disposed by the gate with its reason in output and dropped.json", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "es-204-cli-model-"))
    const root = await mkdtemp(path.join(tmpdir(), "es-204-cli-model-root-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-204-cli-model-state-"))
    try {
      const run = async (argv: string[]) => {
        const printed: string[] = []
        const code = await main(argv, {
          print: (text) => printed.push(text),
          confirm: pipe,
          cwd: root,
          stateDir: state,
        })
        return { code, out: printed.join("\n") }
      }
      const runA = await makeRun(parent, "run-a", "halt A", false)
      const evals = path.join(parent, "evals")
      await writeEvals(evals, [
        { id: "case-x", failures: ["fails like gpt-4 would", "fails like gpt-4 would"] },
        { id: "case-y", failures: ["fails like gpt-4 would"] },
      ])
      const telemetryFile = path.join(root, "telemetry.json")
      expect((await run(["improve", "harvest", "--runs", runA, "--evals", evals, "--out", telemetryFile])).code).toBe(0)
      const proposalsDir = path.join(root, "proposals")
      const distilled = await run([
        "improve",
        "distill",
        "--telemetry",
        telemetryFile,
        "--out",
        proposalsDir,
        "--min-occurrences",
        "3",
        "--min-runs",
        "2",
      ])
      expect(distilled.code).toBe(0)
      expect(distilled.out).toContain("Disposed by the gate")
      expect(distilled.out).toContain("hallucinated model numeral")
      const dropped = JSON.parse(await readFile(path.join(proposalsDir, "dropped.json"), "utf8")) as Array<{
        reasons: string[]
      }>
      expect(dropped.length).toBeGreaterThan(0)
      expect(
        dropped.some((entry) => entry.reasons.some((reason) => reason.includes("hallucinated model numeral"))),
      ).toBe(true)
    } finally {
      await rm(parent, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})
