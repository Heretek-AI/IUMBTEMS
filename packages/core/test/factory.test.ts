import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import { approvalSubject, recordApproval, verifyApproval } from "../src/approval/index.ts"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { verifyAuditChain } from "../src/audit/index.ts"
import { Factory, FactoryError, FactoryHalted, type GateRequest, type GateRunLike } from "../src/factory/index.ts"
import { factoryLayout } from "../src/layout.ts"
import { run } from "../src/util/proc.ts"
import { type Fixture, frontier, gitRepo, writeGoal, writeReport, writeSpecs } from "./helpers.ts"

let fx: Fixture
let gateCalls: GateRequest[]
let nextGate: GateRunLike
const PASSPHRASE = "test-passphrase-1234"
let signer: HumanSigner
const prs: string[] = []

const gates = async (request: GateRequest) => {
  gateCalls.push(request)
  return nextGate
}
const green: GateRunLike = { passed: true, findings: [], summary: "green" }
const pr = {
  id: "fake",
  available: async () => true,
  open: async (request: { branch: string }) => {
    prs.push(request.branch)
    return { url: `https://example.test/pr/${prs.length}` }
  },
}

let factory: Factory
const make = (overrides: Partial<ConstructorParameters<typeof Factory>[1]> = {}) =>
  new Factory(fx.root, { gates, pr, stateDir: fx.state, ...overrides })

beforeEach(async () => {
  fx = await gitRepo()
  await sealHumanKey(PASSPHRASE, fx.state)
  signer = await unlockHumanKey(PASSPHRASE, fx.state)
  gateCalls = []
  nextGate = green
  factory = make()
})
afterEach(() => fx.cleanup())

const approve = (stage: "frontier" | "spec") =>
  recordApproval(fx.root, { stage, channel: "cli", approvedBy: "tester", signer })

async function toBuild(phases = ["alpha"]) {
  await factory.begin("human:tester")
  await factory.writeFrontier("grill", frontier())
  await approve("frontier")
  await factory.beginResearch("human:tester")
  await writeReport(fx.root, fx.state)
  await factory.completeResearch("factory")
  await writeSpecs(fx.root, phases)
  await approve("spec")
  return factory.startBuild("factory")
}

async function worktreeOf() {
  return (await factory.activeWorktree())!
}

/** Programmer: failing test first (recorded red run), then the implementation, then complete. */
async function programmerCycle(id: string) {
  const dir = await worktreeOf()
  await mkdir(path.join(dir, "src"), { recursive: true })
  await mkdir(path.join(dir, "test"), { recursive: true })
  await writeFile(path.join(dir, `test/${id}.test.ts`), `test("${id}", () => {})\n`)
  await factory.recordGateRun("es-programmer", {
    passed: false,
    findings: [],
    summary: "red",
    failedTests: [`test/${id}.test.ts`],
  })
  await writeFile(path.join(dir, `src/${id}.ts`), `export const ${id.replace(/-/g, "_")} = 1\n`)
  return factory.complete("es-programmer")
}

describe("grill → research → spec", () => {
  test("only the grill/factory seats may write the frontier, and only in GRILL", async () => {
    await factory.begin("human:tester")
    await expect(factory.writeFrontier("build", frontier())).rejects.toThrow(FactoryError)
    await expect(factory.writeFrontier("es-programmer", frontier())).rejects.toThrow("Only the grill or factory seat")
    await factory.writeFrontier("grill", frontier())
    expect(JSON.parse(await readFile(factoryLayout(fx.root).frontier, "utf8")).idea).toBe("A greeting library")
  })

  test("a missing or unsettled frontier points at the grill recording step", async () => {
    await expect(approvalSubject(fx.root, "frontier")).rejects.toThrow("/grill")
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier({ settled: false }))
    await expect(approvalSubject(fx.root, "frontier")).rejects.toThrow("/grill")
  })

  test("es_request_approval refusal routes a missing frontier to the grill flow", async () => {
    const { esTools } = await import("../src/ops/tools.ts")
    const request = esTools({ root: fx.root, factory, stateDir: fx.state }).find(
      (def) => def.name === "es_request_approval",
    )!
    await expect(request.execute({ stage: "frontier" }, { agent: "grill" })).rejects.toThrow("/grill")
  })

  test("research needs a genuine, unchanged frontier approval and takes the ceiling from it", async () => {
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier())
    await expect(factory.beginResearch("human:tester")).rejects.toThrow("no frontier approval")

    // A hand-written approval record is not signed by the human key.
    await mkdir(factoryLayout(fx.root).approvals, { recursive: true })
    const genuine = await approve("frontier")
    const forged = { ...genuine, signature: { ...genuine.signature, sig: "0".repeat(64) } }
    await writeFile(factoryLayout(fx.root).approval("frontier"), JSON.stringify(forged))
    expect((await verifyApproval(fx.root, "frontier", { stateDir: fx.state })).ok).toBe(false)

    await approve("frontier")
    const state = await factory.beginResearch("human:tester")
    expect(state.stage).toBe("RESEARCH")
    expect(state.spendCeilingUSD).toBe(25)
  })

  test("research completes only when the report passes the epistemic audit", async () => {
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier())
    await approve("frontier")
    await factory.beginResearch("human:tester")
    await mkdir(path.join(fx.root, ".factory/research"), { recursive: true })
    await writeFile(
      path.join(fx.root, ".factory/research/REPORT.md"),
      "# Research\n\n- Everyone uses greet() [VERIFIED: sha256:" +
        "a".repeat(64) +
        ' "everyone uses greet"]\n- untagged opinion\n',
    )
    await expect(factory.completeResearch("factory")).rejects.toThrow("does not pass the epistemic audit")
    const coverage = JSON.parse(await readFile(path.join(fx.root, ".factory/research/coverage.json"), "utf8"))
    expect(coverage).toMatchObject({ claims: 2, ungrounded: 1, untagged: 1, passed: false })
    await writeReport(fx.root, fx.state)
    expect(await Bun.file(factoryLayout(fx.root).researchDossier).exists()).toBe(false)
    expect((await factory.completeResearch("factory")).stage).toBe("SPEC")
    // The audited report's claims become the research dossier, witnessed.
    const dossier = JSON.parse(await readFile(factoryLayout(fx.root).researchDossier, "utf8"))
    expect(dossier).toMatchObject({ version: "1.1", mode: "research", subject: "A greeting library" })
    expect(dossier.claims.map((claim: any) => [claim.tag, claim.statement, claim.witness.ok])).toEqual([
      ["VERIFIED", "A greet function is the conventional API", true],
    ])
  })

  test("the summary shows the configured research depth during RESEARCH only", async () => {
    const deep = make({ researchDepth: 3 })
    await deep.begin("human:tester")
    await deep.writeFrontier("grill", frontier())
    expect(await deep.summary()).not.toContain("research depth")
    await approve("frontier")
    await deep.beginResearch("human:tester")
    expect(await deep.summary()).toContain("research depth 3: thesis + antithesis, then a verification pass")
  })

  test("research must answer every fact the grill deferred, on a grounded claim line", async () => {
    const db = { id: "db", kind: "fact", status: "deferred", question: "Which Node versions does the runtime support?" }
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier({ nodes: [...frontier().nodes, db] }))
    await approve("frontier")
    await factory.beginResearch("human:tester")
    await writeReport(fx.root, fx.state)
    await expect(factory.completeResearch("factory")).rejects.toThrow(
      "Missing: db — Which Node versions does the runtime support?",
    )
    // An answer on an ungrounded line does not count: the audit fails first.
    const report = await readFile(factoryLayout(fx.root).researchReport, "utf8")
    await writeFile(factoryLayout(fx.root).researchReport, `${report}- Node 22 is supported (fact:db)\n`)
    await expect(factory.completeResearch("factory")).rejects.toThrow("does not pass the epistemic audit")
    await writeFile(
      factoryLayout(fx.root).researchReport,
      `${report}- Node 22 is the minimum (fact:db) [INFERRED: the package engines field requires node >=22]\n`,
    )
    expect((await factory.completeResearch("factory")).stage).toBe("SPEC")
  })

  test("a spec edited after approval blocks the build", async () => {
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier())
    await approve("frontier")
    await factory.beginResearch("human:tester")
    await expect(factory.completeResearch("factory")).rejects.toThrow("REPORT.md")
    await writeReport(fx.root, fx.state)
    await factory.completeResearch("factory")
    await writeSpecs(fx.root, ["alpha"])
    await approve("spec")
    await writeGoal(fx.root, "alpha", "\nSneaky scope creep.")
    await expect(factory.startBuild("factory")).rejects.toThrow("changed after it was approved")
  })
})

describe("design tree (frontier 1.1; d66328c:skills/grilling/socratic_tree.py)", () => {
  const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, question: `${id}?`, ...extra })
  const tree = (nodes: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    frontier({ settled: false, round: 1, nodes, ...extra })

  test("the frontier is every open node whose ancestors are all settled (compute_frontier)", async () => {
    const { computeFrontier } = await import("../src/factory/tree.ts")
    const { FrontierSchema } = await import("../src/schema/frontier.ts")
    const ids = (raw: Record<string, unknown>) => computeFrontier(FrontierSchema.parse(raw)).map((item) => item.id)
    expect(ids(tree([node("scope"), node("users", { parent: "scope" })]))).toEqual(["scope"])
    const settledScope = node("scope", { status: "settled", answer: "CLI only" })
    expect(ids(tree([settledScope, node("users", { parent: "scope" }), node("auth", { parent: "users" })]))).toEqual([
      "users",
    ])
    // A deferred parent holds its children back; a deferred node is not asked.
    expect(ids(tree([node("scope", { status: "deferred" }), node("users", { parent: "scope" })]))).toEqual([])
  })

  test("the schema refuses parent cycles, rounds ahead of the frontier, and unevidenced settled facts", async () => {
    const { FrontierSchema } = await import("../src/schema/frontier.ts")
    const issues = (raw: Record<string, unknown>) =>
      FrontierSchema.safeParse(raw).error?.issues.map((issue) => issue.message) ?? []
    expect(issues(tree([node("a", { parent: "b" }), node("b", { parent: "a" })]))).toContain('parent cycle through "a"')
    expect(issues(tree([node("a", { round: 3 })]))).toContain("asked in round 3, but the frontier is at round 1")
    expect(issues(tree([node("db", { kind: "fact", status: "settled", answer: "Postgres 16" })]))).toContain(
      "a settled fact needs its evidence (where it was looked up)",
    )
    expect(issues({ ...tree([]), version: "1.0" })).not.toEqual([])
  })

  test("writes are checked against the previous tree; settled answers change only after a reopen", async () => {
    await factory.begin("human:tester")
    const lang = node("lang", { status: "settled", answer: "TypeScript", round: 1 })
    await factory.writeFrontier("grill", tree([lang, node("runtime", { round: 1 })]))
    const refused = (raw: Record<string, unknown>) => factory.writeFrontier("grill", raw)
    await expect(refused(tree([lang]))).rejects.toThrow('node "runtime" was removed')
    await expect(refused(tree([{ ...lang, answer: "Rust" }, node("runtime")]))).rejects.toThrow(
      'settled node "lang" changed its answer; reopen it first',
    )
    await expect(refused(tree([{ ...lang, round: undefined }, node("runtime")], { round: 0 }))).rejects.toThrow(
      "round went back from 1 to 0",
    )
    await expect(refused(tree([lang, node("runtime")], { idea: "Something else" }))).rejects.toThrow(
      "the idea changed after decisions were settled",
    )
    // Reopen, then settle again with the new answer: two audited writes.
    await factory.writeFrontier(
      "grill",
      tree([{ ...lang, status: "open", answer: undefined }, node("runtime")], { round: 2 }),
    )
    await factory.writeFrontier("grill", tree([{ ...lang, answer: "Rust" }, node("runtime")], { round: 2 }))
    const writes = (await verifyAuditChain(fx.root)).entries.filter((entry) => entry.action === "frontier.write")
    expect(writes.map((entry) => (entry.payload as { reopened: string[] }).reopened)).toEqual([[], ["lang"], []])
  })

  test("a 1.0 frontier on disk is refused with the fresh-run instruction", async () => {
    await factory.begin("human:tester")
    await mkdir(factoryLayout(fx.root).dir, { recursive: true })
    await writeFile(factoryLayout(fx.root).frontier, JSON.stringify({ ...frontier(), version: "1.0" }))
    await expect(factory.writeFrontier("grill", frontier())).rejects.toThrow("1.1 needs a fresh run")
  })

  test("the summary and es_frontier_write show tree progress and the next round", async () => {
    const { esTools } = await import("../src/ops/tools.ts")
    const write = esTools({ root: fx.root, factory, stateDir: fx.state }).find(
      (def) => def.name === "es_frontier_write",
    )!
    const out = await write.execute(
      {
        frontier: tree([
          node("scope", { status: "settled", answer: "CLI", round: 1 }),
          node("users", { parent: "scope", round: 1 }),
          node("db", { kind: "fact", status: "deferred", question: "Which Postgres versions are supported?" }),
        ]),
      },
      { agent: "grill" },
    )
    expect(out).toContain("1 settled, 1 open, 1 deferred (1 fact(s) for research)")
    expect(out).toContain("Next round (1): users.")
    const summary = await factory.summary()
    expect(summary.split("\n").slice(0, 3)).toEqual([
      "<factory-state>",
      expect.stringMatching(/^run run-\d{8}-\d{6}-[0-9a-f]{4} · stage GRILL$/),
      "tree r1: 1 settled · 1 open · 1 deferred (1 fact for research)",
    ])
  })
})

describe("build and QA", () => {
  test("startBuild creates a run branch and a phase worktree; only the programmer may write there", async () => {
    const state = await toBuild()
    expect(state.stage).toBe("BUILD")
    const dir = await worktreeOf()
    expect(dir).toBe(path.join(fx.root, ".factory/worktrees/alpha"))
    const branches = (await run(["git", "branch", "--list", "factory/*"], { cwd: fx.root })).stdout
    expect(branches).toContain(`factory/${state.runId}/integration`)
    expect(branches).toContain(`factory/${state.runId}/phase-alpha`)
  })

  test("complete is gated: seat, changes, red-first evidence, criteria, and gates in the worktree", async () => {
    await toBuild()
    await expect(factory.complete("es-qa-functional")).rejects.toThrow("Only the programmer seat")
    const empty = await factory.complete("es-programmer")
    expect(empty.ok).toBe(false)
    expect(empty.findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(["factory/no-changes", "tdd/test-change", "tdd/red-first", "acceptance/unmet"]),
    )

    nextGate = {
      passed: false,
      findings: [{ file: "src/alpha.ts", line: 1, rule: "lint/x", severity: "error", message: "bad" }],
      summary: "red",
    }
    const red = await programmerCycle("alpha")
    expect(red.ok).toBe(false)
    expect(gateCalls.at(-1)?.dir).toBe(path.join(fx.root, ".factory/worktrees/alpha"))
    expect(gateCalls.at(-1)?.scope).toBe("full")

    nextGate = green
    const done = await factory.complete("es-programmer")
    expect(done.ok).toBe(true)
    const state = (await factory.read())!
    expect(state.stage).toBe("QA")
    expect(state.phases[0]!.headCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  test("QA verdicts come only from QA seats; a split needs the manager's tiebreak", async () => {
    await toBuild(["alpha", "beta"])
    await programmerCycle("alpha")
    await expect(factory.qaVerdict("es-programmer", "pass", "lgtm")).rejects.toThrow("qa-functional or qa-adversarial")
    await expect(factory.qaVerdict("factory", "pass", "lgtm")).rejects.toThrow(FactoryError)
    await factory.qaVerdict("es-qa-functional", "pass", "criteria met")
    await factory.qaVerdict("es-qa-adversarial", "fail", "edge case")
    await expect(factory.tiebreak("es-qa-functional", "pass", "")).rejects.toThrow("Only the manager seat")
    const state = await factory.tiebreak("es-manager", "pass", "edge case is out of scope")
    expect(state.phases[0]!.status).toBe("passed")
    expect(state.activePhase).toBe("beta")
    expect(state.stage).toBe("BUILD")
    const integration = (
      await run(["git", "rev-parse", `factory/${state.runId}/integration`], { cwd: fx.root })
    ).stdout.trim()
    expect(integration).toBe(state.phases[0]!.headCommit!)
  })

  test("failure policy: 3 attempts, one replan, 2 more attempts, then halt (5 failures)", async () => {
    await toBuild()
    const fail = async () => {
      await factory.qaVerdict("es-qa-functional", "fail", "no")
      return factory.qaVerdict("es-qa-adversarial", "fail", "no")
    }
    await programmerCycle("alpha")
    for (let attempt = 1; attempt <= 2; attempt++) {
      const state = await fail()
      expect(state.phases[0]!.status).toBe("building")
      expect((await factory.complete("es-programmer")).ok).toBe(true)
    }
    let state = await fail()
    expect(state.phases[0]!.failures).toBe(3)
    expect(state.phases[0]!.status).toBe("replanning")
    await expect(factory.complete("es-programmer")).rejects.toThrow("replanning")
    await expect(factory.replan("es-manager", "same spec")).rejects.toThrow("unchanged")
    await writeGoal(fx.root, "alpha", "\nNarrower slice.")
    await expect(factory.replan("es-programmer", "x")).rejects.toThrow("Only the manager seat")
    state = await factory.replan("es-manager", "narrowed")
    expect(state.phases[0]!.status).toBe("building")
    expect((await factory.complete("es-programmer")).ok).toBe(true)
    state = await fail()
    expect(state.phases[0]!.failures).toBe(4)
    expect((await factory.complete("es-programmer")).ok).toBe(true)
    state = await fail()
    expect(state.stage).toBe("HALTED")
    expect(state.halt?.reason).toContain("failed 5 times")
  })

  test("release opens a PR from the integration branch after green gates", async () => {
    await toBuild()
    await programmerCycle("alpha")
    await factory.qaVerdict("es-qa-functional", "pass", "ok")
    const state = await factory.qaVerdict("es-qa-adversarial", "pass", "ok")
    expect(state.stage).toBe("RELEASE")
    const done = await factory.release("factory")
    expect(done.stage).toBe("DONE")
    expect(done.release?.prUrl).toBe("https://example.test/pr/1")
    expect(prs.at(-1)).toBe(`factory/${done.runId}/integration`)
  })

  test("release without a PR opener stays in RELEASE until a human records the PR", async () => {
    factory = make({ pr: undefined })
    await toBuild()
    await programmerCycle("alpha")
    await factory.qaVerdict("es-qa-functional", "pass", "ok")
    await factory.qaVerdict("es-qa-adversarial", "pass", "ok")
    await expect(factory.release("factory")).rejects.toThrow("no PR opener")
    expect((await factory.recordPr("tester", "https://example.test/pr/9")).stage).toBe("DONE")
  })
})

describe("phase audits (decision 2)", () => {
  const verdictTool = async () => {
    const { codeAuditTools } = await import("../src/codeaudit/index.ts")
    return codeAuditTools({ root: fx.root, factory, stateDir: fx.state }).find(
      (tool) => tool.name === "es_audit_verdict",
    )!
  }
  const holds = {
    kind: "invariant",
    title: "The export is a constant",
    severity: "info",
    file: "src/alpha.ts",
    lines: [1, 1],
    excerpt: "export const alpha = 1",
    detail: "alpha is a module-level constant; nothing mutates it.",
    holds: true,
  }
  const defect = {
    ...holds,
    kind: "vulnerability",
    title: "Magic constant without validation",
    severity: "medium",
    cwe: "CWE-1188",
    remediation: "Derive it from validated config.",
    holds: undefined,
  }

  test("an open phase audit holds the merge after QA passes; its pass merges the phase", async () => {
    await toBuild(["alpha", "beta"])
    const { audit } = await factory.openAudit("factory", { kind: "phase", phase: "alpha" })
    await expect(factory.auditVerdict("es-auditor-thesis", audit.id, "pass", "early")).rejects.toThrow(
      "phase audits take verdicts in QA",
    )
    await programmerCycle("alpha")
    await factory.qaVerdict("es-qa-functional", "pass", "criteria met")
    const held = await factory.qaVerdict("es-qa-adversarial", "pass", "nothing broke")
    expect([held.stage, held.phases[0]!.status, held.phases[0]!.history.at(-1)?.event]).toEqual([
      "QA",
      "qa",
      "qa-passed",
    ])
    const verdict = await verdictTool()
    await verdict.execute(
      { audit: audit.id, verdict: "pass", findings: [holds], notes: "sound" },
      { agent: "es-auditor-thesis" },
    )
    await verdict.execute(
      { audit: audit.id, verdict: "pass", findings: [], notes: "tried injection, races" },
      { agent: "es-auditor-antithesis" },
    )
    const state = (await factory.read())!
    expect([state.phases[0]!.status, state.phases[0]!.audit?.status, state.activePhase]).toEqual([
      "passed",
      "passed",
      "beta",
    ])
  })

  test("a failed phase audit sends the phase back to the programmer and re-opens the audit", async () => {
    await toBuild()
    const { audit } = await factory.openAudit("factory", { kind: "phase", phase: "alpha" })
    await programmerCycle("alpha")
    const verdict = await verdictTool()
    await verdict.execute(
      { audit: audit.id, verdict: "fail", findings: [defect], notes: "1. magic" },
      { agent: "es-auditor-thesis" },
    )
    const out = await verdict.execute(
      { audit: audit.id, verdict: "fail", findings: [defect], notes: "1. magic" },
      { agent: "es-auditor-antithesis" },
    )
    expect(out).toContain("the phase went back to the programmer (audit re-opened as round 2)")
    const phase = (await factory.read())!.phases[0]!
    expect([phase.status, phase.failures, phase.audit?.status, phase.audit?.round]).toEqual(["building", 1, "open", 2])
    expect(phase.history.at(-1)?.notes).toContain("audit audit-01: 1. magic")
  })
})

describe("guards", () => {
  test("the STOP file halts every operation until a human resumes", async () => {
    await toBuild()
    await writeFile(factoryLayout(fx.root).stop, "lunch")
    await expect(factory.complete("es-programmer")).rejects.toThrow(FactoryHalted)
    expect((await factory.read())!.halt?.reason).toContain("lunch")
    await expect(factory.resume("tester")).rejects.toThrow("Remove .factory/STOP")
    await Bun.file(factoryLayout(fx.root).stop).delete()
    expect((await factory.resume("tester")).stage).toBe("BUILD")
  })

  test("spend at the ceiling halts", async () => {
    await toBuild()
    const state = await factory.recordSpend(30, true)
    expect(state?.stage).toBe("HALTED")
    expect(state?.halt?.reason).toContain("(estimated)")
    await expect(factory.resume("tester")).rejects.toThrow("raise it")
    expect((await factory.resume("tester", { raiseCeilingUSD: 50 })).stage).toBe("BUILD")
  })

  test("control-file drift halts; resuming requires accepting it", async () => {
    await toBuild()
    await writeFile(factoryLayout(fx.root).frontier, "{}")
    await expect(factory.complete("es-programmer")).rejects.toThrow("frontier.json changed")
    await expect(factory.resume("tester")).rejects.toThrow("Control files changed")
    expect((await factory.resume("tester", { acceptControlDrift: true })).stage).toBe("BUILD")
  })

  test("the runtime cap counts from autonomy start", async () => {
    let now = new Date("2026-10-06T10:00:00Z")
    factory = make({ now: () => now })
    await toBuild()
    now = new Date("2026-10-06T19:00:00Z")
    await expect(factory.complete("es-programmer")).rejects.toThrow("runtime cap")
  })

  test("the audit chain verifies, and truncation past an approval anchor is detected", async () => {
    await toBuild()
    expect((await verifyAuditChain(fx.root)).valid).toBe(true)
    await truncate(factoryLayout(fx.root).audit, 0)
    const check = await verifyAuditChain(fx.root)
    expect(check.valid).toBe(false)
    expect(check.error).toContain("truncated")
  })
})
