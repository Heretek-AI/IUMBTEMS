// Factory stage ordering on the real host (issue #179, integration tests §2).
//
// For each stage, scripted calls to every phase-transition es_* tool that
// belongs to a later stage are refused with a stage error and leave the
// functional state (stage/phases) unchanged. Stage-free-by-design tools
// (es_status, es_spec_validate, es_request_approval, es_gates_run,
// es_audit_open, research/scout/brainstorm/harvest/design/lsp) are out of
// scope. Two known holes get explicit coverage: an audit tiebreak outside QA
// and gate-run recording outside BUILD must not change state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  approveStage,
  Factory,
  factoryLayout,
  gateRunner,
  type HumanSigner,
  readJournal,
  researchSourcesDir,
  SourceCache,
  sealHumanKey,
  stringifyFrontmatter,
  unlockHumanKey,
  writeJson,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

const GREEN = { passed: true, findings: [], summary: "green" }

describe("factory stage order (issue #179)", () => {
  let h: Harness
  let state: string
  let signer: HumanSigner
  const stub = () => new Factory(h.directory, { gates: async () => GREEN, stateDir: state })

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-stage-order-"))
    await sealHumanKey("test-passphrase-1234", state)
    signer = await unlockHumanKey("test-passphrase-1234", state)
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# stage order\n" },
    })
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  const snap = async () => {
    const s = (await stub().read())!
    return JSON.stringify({ stage: s.stage, active: s.activePhase ?? null, phases: s.phases })
  }
  const stageOf = async () => (await stub().read())!.stage

  const refused = async (tool: string, agent: string, args: Record<string, unknown>, match: RegExp) => {
    const before = await snap()
    const { tools } = await h.run(`stage-check ${call(tool, args)}`, { agent })
    expect([tool, tools[0]?.status]).toEqual([tool, "error"])
    expect([tool, tools[0]?.text ?? ""]).toEqual([tool, expect.stringMatching(match)])
    expect([tool, await snap()]).toEqual([tool, before])
  }

  const frontierDoc = {
    version: "1.1",
    idea: "a greeting library",
    spendCeiling: { currency: "USD", maxAmount: 10 },
    round: 1,
    settled: true,
    nodes: [{ id: "scope", question: "What ships first?", status: "settled", answer: "greet", round: 1 }],
  }

  const writeReport = async () => {
    const cache = new SourceCache(researchSourcesDir(h.directory), state)
    const source = await cache.put({
      url: "https://example.test/stage-order",
      text: "Stage order tests use a single greet function.",
      provider: "fetch",
    })
    await write(
      h.directory,
      ".factory/research/REPORT.md",
      `# Research\n\n- Greet is the API [VERIFIED: sha256:${source.meta.sha256} "a single greet function"]\n`,
    )
  }

  const writeSpec = async () => {
    await writeJson(path.join(h.directory, ".factory/roadmap.json"), {
      version: 1,
      title: "Greet",
      phases: [{ id: "alpha", title: "Alpha" }],
    })
    await write(
      h.directory,
      ".factory/specs/alpha/GOAL.md",
      stringifyFrontmatter(
        {
          phase: "alpha",
          title: "Alpha",
          acceptance: [{ kind: "file", id: "impl", description: "implementation exists", path: "src/alpha.ts" }],
        },
        "Implement alpha.\n",
      ),
    )
  }

  test("GRILL: every later-stage transition is refused", async () => {
    await stub().provisionRun("tester", 10)
    expect(await stageOf()).toBe("GRILL")
    await refused("es_research_complete", "factory", {}, /needs RESEARCH|Not allowed/i)
    await refused("es_build_start", "factory", {}, /needs SPEC|Not allowed|no spec approval/i)
    await refused("es_complete", "es-programmer", {}, /needs BUILD|Not allowed|Only the programmer/i)
    await refused("es_qa_verdict", "es-qa-functional", { verdict: "pass", notes: "x" }, /needs QA|Not allowed/i)
    await refused("es_tiebreak", "es-manager", { verdict: "pass", notes: "x" }, /needs QA|only possible|Not allowed/i)
    await refused("es_replan", "es-manager", { notes: "x" }, /needs BUILD|not awaiting|Not allowed/i)
    await refused("es_release", "factory", {}, /needs RELEASE|Not allowed/i)
    await refused(
      "es_audit_verdict",
      "es-auditor-thesis",
      { audit: "audit-01", verdict: "pass", findings: [], notes: "x" },
      /No audit|phase audits take verdicts|Not allowed/i,
    )
    // Audit tiebreak with no audit is refused and changes nothing.
    await refused(
      "es_tiebreak",
      "es-manager",
      { verdict: "pass", notes: "x", audit: "audit-01" },
      /No audit|only possible/i,
    )
  }, 120_000)

  test("RESEARCH: build and later transitions are refused", async () => {
    await stub().writeFrontier("grill", frontierDoc)
    await approveStage(h.directory, {
      stage: "frontier",
      channel: "cli",
      approvedBy: "tester",
      signer,
      stateDir: state,
    })
    expect(await stageOf()).toBe("RESEARCH")
    await refused("es_build_start", "factory", {}, /needs SPEC|no spec approval|Not allowed/i)
    await refused("es_complete", "es-programmer", {}, /needs BUILD|Not allowed|Only the programmer/i)
    await refused("es_qa_verdict", "es-qa-functional", { verdict: "pass", notes: "x" }, /needs QA|Not allowed/i)
    await refused("es_tiebreak", "es-manager", { verdict: "pass", notes: "x" }, /needs QA|only possible|Not allowed/i)
    await refused("es_replan", "es-manager", { notes: "x" }, /needs BUILD|not awaiting|Not allowed/i)
    await refused("es_release", "factory", {}, /needs RELEASE|Not allowed/i)
    // The grill tree is closed: frontier writes are refused past GRILL.
    await refused("es_frontier_write", "grill", { frontier: { ...frontierDoc, round: 2 } }, /needs GRILL|Not allowed/i)
  }, 120_000)

  test("SPEC: build-complete and later transitions are refused", async () => {
    await writeReport()
    await stub().completeResearch("factory")
    expect(await stageOf()).toBe("SPEC")
    await refused("es_research_complete", "factory", {}, /needs RESEARCH|Not allowed/i)
    await refused("es_complete", "es-programmer", {}, /needs BUILD|Not allowed|Only the programmer/i)
    await refused("es_qa_verdict", "es-qa-functional", { verdict: "pass", notes: "x" }, /needs QA|Not allowed/i)
    await refused("es_tiebreak", "es-manager", { verdict: "pass", notes: "x" }, /needs QA|only possible|Not allowed/i)
    await refused("es_replan", "es-manager", { notes: "x" }, /needs BUILD|not awaiting|Not allowed/i)
    await refused("es_release", "factory", {}, /needs RELEASE|Not allowed/i)
    // Gate-run recording outside BUILD must not touch phase history: there
    // are no phases yet, and the silent no-op (no throw) leaves state alone.
    const before = await snap()
    await stub().recordGateRun("es-programmer", {
      passed: false,
      findings: [],
      summary: "red",
      failedTests: ["test/alpha.test.ts"],
    })
    expect(await snap()).toBe(before)
  }, 120_000)

  test("BUILD: QA and release transitions are refused; audit verdicts wait for QA", async () => {
    await writeSpec()
    await approveStage(h.directory, { stage: "spec", channel: "cli", approvedBy: "tester", signer, stateDir: state })
    await stub().startBuild("factory")
    expect(await stageOf()).toBe("BUILD")
    await refused("es_research_complete", "factory", {}, /needs RESEARCH|Not allowed/i)
    await refused("es_build_start", "factory", {}, /needs SPEC|Not allowed/i)
    await refused("es_qa_verdict", "es-qa-functional", { verdict: "pass", notes: "x" }, /needs QA|Not allowed/i)
    await refused("es_tiebreak", "es-manager", { verdict: "pass", notes: "x" }, /needs QA|only possible|Not allowed/i)
    await refused("es_replan", "es-manager", { notes: "x" }, /not awaiting|needs BUILD|Not allowed/i)
    await refused("es_release", "factory", {}, /needs RELEASE|Not allowed/i)
    // A phase audit opened in BUILD takes no verdicts until QA.
    const { audit } = await stub().openAudit("factory", { kind: "phase", phase: "alpha" })
    const early = await h.run(
      `audit ${call("es_audit_verdict", { audit: audit.id, verdict: "pass", findings: [], notes: "early" })}`,
      { agent: "es-auditor-thesis" },
    )
    expect(early.tools[0]?.status).toBe("error")
    expect(early.tools[0]?.text).toMatch(/phase audits take verdicts in QA|Not allowed/i)
    // An audit tiebreak with no disagreeing verdicts is refused.
    await refused(
      "es_tiebreak",
      "es-manager",
      { verdict: "pass", notes: "x", audit: audit.id },
      /only possible|Not allowed/i,
    )
  }, 180_000)

  test("QA: build and release transitions are refused; gate runs record nothing", async () => {
    // Programmer cycle through the stub (fake green gates): red evidence,
    // sources, then the gated complete into QA.
    const wt = path.join(h.directory, ".factory/worktrees/alpha")
    await mkdir(path.join(wt, "src"), { recursive: true })
    await mkdir(path.join(wt, "test"), { recursive: true })
    await writeFile(path.join(wt, "test/alpha.test.ts"), `test("alpha", () => {})\n`)
    await stub().recordGateRun("es-programmer", {
      passed: false,
      findings: [],
      summary: "red",
      failedTests: ["test/alpha.test.ts"],
    })
    await writeFile(path.join(wt, "src/alpha.ts"), `export const alpha = 1\n`)
    const done = await stub().complete("es-programmer")
    expect(done.ok).toBe(true)
    expect(await stageOf()).toBe("QA")
    await refused("es_research_complete", "factory", {}, /needs RESEARCH|Not allowed/i)
    await refused("es_build_start", "factory", {}, /needs SPEC|Not allowed/i)
    await refused("es_complete", "es-programmer", {}, /needs BUILD|not building|Not allowed/i)
    await refused("es_replan", "es-manager", { notes: "x" }, /needs BUILD|not awaiting|Not allowed/i)
    await refused("es_release", "factory", {}, /needs RELEASE|Not allowed/i)
    // Gate-run recording outside BUILD is a silent no-op: the tool reports
    // gates, but the phase history gains no entry (finding: not a refusal).
    const history = (id: string) =>
      stub()
        .read()
        .then((s) => s!.phases.find((p) => p.id === id)!.history.length)
    const before = await history("alpha")
    const gates = await h.run(`gates ${call("es_gates_run", { files: [] })}`, { agent: "es-programmer" })
    expect(gates.tools[0]?.status).toBe("completed")
    expect(await history("alpha")).toBe(before)
  }, 180_000)

  test("RELEASE: everything before release is refused", async () => {
    await stub().qaVerdict("es-qa-functional", "pass", "criteria met")
    // The BUILD-opened audit still holds the merge; pass it to reach RELEASE.
    const stateNow = (await stub().read())!
    const auditId = stateNow.phases[0]!.audit!.id
    const wt = path.join(h.directory, ".factory/worktrees/alpha")
    const line = (await Bun.file(path.join(wt, "src/alpha.ts")).text()).split("\n")[0]!
    const holds = {
      kind: "invariant",
      title: "alpha is a constant",
      severity: "info",
      file: "src/alpha.ts",
      lines: [1, 1],
      excerpt: line,
      detail: "constant",
      holds: true,
    }
    // Witnessed verdicts go through the host auditor seats.
    for (const seat of ["es-auditor-thesis", "es-auditor-antithesis"]) {
      const { tools } = await h.run(
        `review ${call("es_audit_verdict", { audit: auditId, verdict: "pass", findings: seat === "es-auditor-thesis" ? [holds] : [], notes: "sound" })}`,
        { agent: seat },
      )
      expect([seat, tools[0]?.status]).toEqual([seat, "completed"])
    }
    // One QA seat already passed; the other merges the phase into RELEASE.
    const { tools } = await h.run(`qa ${call("es_qa_verdict", { verdict: "pass", notes: "nothing broke" })}`, {
      agent: "es-qa-adversarial",
    })
    expect(tools[0]?.status).toBe("completed")
    expect(await stageOf()).toBe("RELEASE")
    await refused("es_research_complete", "factory", {}, /needs RESEARCH|Not allowed/i)
    await refused("es_build_start", "factory", {}, /needs SPEC|Not allowed/i)
    await refused("es_complete", "es-programmer", {}, /needs BUILD|Not allowed|not building/i)
    await refused("es_qa_verdict", "es-qa-functional", { verdict: "pass", notes: "x" }, /needs QA|Not allowed/i)
    await refused("es_tiebreak", "es-manager", { verdict: "pass", notes: "x" }, /needs QA|only possible|Not allowed/i)
    await refused("es_replan", "es-manager", { notes: "x" }, /needs BUILD|not awaiting|Not allowed/i)
  }, 180_000)
})

describe("happy path Grill → DONE records the journal in order (issue #179)", () => {
  let h: Harness
  let state: string
  let signer: HumanSigner
  const factory = () => new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-journal-"))
    await sealHumanKey("test-passphrase-1234", state)
    signer = await unlockHumanKey("test-passphrase-1234", state)
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
      files: { "README.md": "# journal\n" },
    })
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("grill → research → spec → build → QA → release → DONE; journal steps in order", async () => {
    await factory().provisionRun("tester", 10)
    await factory().writeFrontier("grill", {
      version: "1.1",
      idea: "a greeting library",
      spendCeiling: { currency: "USD", maxAmount: 10 },
      round: 1,
      settled: true,
      nodes: [{ id: "scope", question: "What ships first?", status: "settled", answer: "greet", round: 1 }],
    })
    await approveStage(h.directory, {
      stage: "frontier",
      channel: "cli",
      approvedBy: "tester",
      signer,
      stateDir: state,
    })
    const cache = new SourceCache(researchSourcesDir(h.directory), state)
    const source = await cache.put({
      url: "https://example.test/greet",
      text: "Greeting libraries expose a single greet function.",
      provider: "fetch",
    })
    await write(
      h.directory,
      ".factory/research/REPORT.md",
      `# Research\n\n- Greet is conventional [VERIFIED: sha256:${source.meta.sha256} "a single greet function"]\n`,
    )
    const researched = await h.run(`research ${call("es_research_complete", {})}`, { agent: "factory" })
    expect(researched.tools[0]?.status).toBe("completed")
    expect((await factory().read())!.stage).toBe("SPEC")

    await writeJson(path.join(h.directory, ".factory/roadmap.json"), {
      version: 1,
      title: "Greet",
      phases: [{ id: "alpha", title: "Alpha" }],
    })
    await write(
      h.directory,
      ".factory/specs/alpha/GOAL.md",
      stringifyFrontmatter(
        {
          phase: "alpha",
          title: "Alpha",
          acceptance: [{ kind: "file", id: "impl", description: "implementation exists", path: "src/alpha.ts" }],
        },
        "Implement alpha.\n",
      ),
    )
    await approveStage(h.directory, { stage: "spec", channel: "cli", approvedBy: "tester", signer, stateDir: state })
    const started = await h.run(`build ${call("es_build_start", {})}`, { agent: "factory" })
    expect(started.tools[0]?.status).toBe("completed")
    const runId = (await factory().read())!.runId

    // Red first (direct core, as in pipeline.test.ts), then the gated
    // complete through the scripted programmer on the host.
    const wt = (await factory().activeWorktree())!
    const rel = (file: string) => path.relative(h.directory, path.join(wt, file))
    await write(h.directory, rel("test/alpha.test.ts"), `test("alpha", () => {})\n`)
    await factory().recordGateRun("es-programmer", {
      passed: false,
      findings: [],
      summary: "red",
      failedTests: ["test/alpha.test.ts"],
    })
    await write(h.directory, rel("src/alpha.ts"), `export const alpha = 1\n`)
    const completed = await h.run(`finish ${call("es_complete", {})}`, { agent: "es-programmer" })
    expect(completed.tools[0]?.status).toBe("completed")
    expect(completed.tools[0]?.text).toContain("in QA")

    for (const seat of ["es-qa-functional", "es-qa-adversarial"]) {
      const verdict = await h.run(`qa ${call("es_qa_verdict", { verdict: "pass", notes: "criteria met" })}`, {
        agent: seat,
      })
      expect([seat, verdict.tools[0]?.status]).toEqual([seat, "completed"])
    }
    const released = (await factory().read())!
    expect([released.stage, released.phases[0]!.status]).toEqual(["RELEASE", "passed"])

    // pr:off keeps es_release refused; the human records the PR to DONE.
    const noPr = await h.run(`ship ${call("es_release", {})}`, { agent: "factory" })
    expect(noPr.tools[0]?.status).toBe("error")
    const done = await factory().recordPr("tester", "https://example.test/pr/1")
    expect([done.stage, done.release?.prUrl]).toEqual(["DONE", "https://example.test/pr/1"])

    // The journal records every side-effecting transition in order.
    const steps = (await readJournal(h.directory)).map((entry) => entry.step)
    const expected = [
      `${runId}:run-branch`,
      `${runId}:alpha:worktree`,
      `${runId}:alpha:attempt-1:commit`,
      `${runId}:alpha:merge`,
      `${runId}:alpha:worktree-removed`,
    ]
    let at = -1
    for (const step of expected) {
      const found = steps.indexOf(step)
      expect([step, found]).toEqual([step, expect.any(Number)])
      expect(found).toBeGreaterThan(at)
      at = found
    }
  }, 240_000)
})
