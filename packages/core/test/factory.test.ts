import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import { approvalSubject, recordApproval, verifyApproval } from "../src/approval/index.ts"
import { verifyAuditChain } from "../src/audit/index.ts"
import { Factory, FactoryError, FactoryHalted, type GateRequest, type GateRunLike } from "../src/factory/index.ts"
import { factoryLayout } from "../src/layout.ts"
import { run } from "../src/util/proc.ts"
import { type Fixture, frontier, gitRepo, writeGoal, writeReport, writeSpecs } from "./helpers.ts"

let fx: Fixture
let gateCalls: GateRequest[]
let nextGate: GateRunLike
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
  gateCalls = []
  nextGate = green
  factory = make()
})
afterEach(() => fx.cleanup())

const approve = (stage: "frontier" | "spec") =>
  recordApproval(fx.root, { stage, channel: "cli", approvedBy: "tester", stateDir: fx.state })

async function toBuild(phases = ["alpha"]) {
  await factory.begin("human:tester")
  await factory.writeFrontier("grill", frontier())
  await approve("frontier")
  await factory.beginResearch("human:tester")
  await writeReport(fx.root)
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

    // A hand-written approval record is not signed by the machine key.
    await mkdir(factoryLayout(fx.root).approvals, { recursive: true })
    const forged = { ...(await approve("frontier")), mac: "0".repeat(64) }
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
    await writeReport(fx.root)
    expect((await factory.completeResearch("factory")).stage).toBe("SPEC")
  })

  test("a spec edited after approval blocks the build", async () => {
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier())
    await approve("frontier")
    await factory.beginResearch("human:tester")
    await expect(factory.completeResearch("factory")).rejects.toThrow("REPORT.md")
    await writeReport(fx.root)
    await factory.completeResearch("factory")
    await writeSpecs(fx.root, ["alpha"])
    await approve("spec")
    await writeGoal(fx.root, "alpha", "\nSneaky scope creep.")
    await expect(factory.startBuild("factory")).rejects.toThrow("changed after it was approved")
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
