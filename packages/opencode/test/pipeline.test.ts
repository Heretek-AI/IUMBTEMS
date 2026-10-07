// Pipeline A (deterministic, real host, merge-blocking): the full factory loop
// with audit.phase required and every seat reached through the factory's
// delegation (subagent tool + @@CHILD scripts, issues #33/#34):
// grill → research (deferred fact) → spec → two phases with build/QA/audit
// loops (beta fails QA once, is fixed, and passes) → RELEASE → DONE, with a
// STOP/resume interlude between the phases. Human actions (approvals, report
// and spec authoring, the red-test evidence, STOP removal/resume, recording
// the PR) are direct core calls, the same way fires-gates stages them; every
// seat transition goes through a scripted seat on the host.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  Factory,
  factoryLayout,
  gateRunner,
  type HumanSigner,
  recordApproval,
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
const child = (name: string, args: Record<string, unknown> = {}) => `@@CHILD ${name} ${JSON.stringify(args)}@@`
const delegate = (agent: string, prompt: string) => call("subagent", { agent, description: `${agent} step`, prompt })

const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

const SRC = (id: string) => `export function ${id}() { return 1 }\n`
const TEST = (id: string) =>
  `import { expect, test } from "bun:test"\nimport { ${id} } from "../src/${id}.ts"\ntest("${id}", () => expect(${id}()).toBe(1))\n`

describe("pipeline A", () => {
  let h: Harness
  let state: string
  let signer: HumanSigner
  const factory = () => new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-pipeline-a-"))
    await sealHumanKey("test-passphrase-1234", state)
    signer = await unlockHumanKey("test-passphrase-1234", state)
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off", audit: { phase: "required" } } }],
      files: { "README.md": "# pipeline A\n" },
    })
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  /** The phase's test genuinely fails before the fix (red) and passes after (green). */
  const redThenGreen = async (id: string) => {
    const wt = (await factory().activeWorktree())!
    await write(h.directory, path.relative(h.directory, path.join(wt, `test/${id}.test.ts`)), TEST(id))
    const red = Bun.spawnSync(["bun", "test", `test/${id}.test.ts`], { cwd: wt })
    expect([id, red.exitCode]).toEqual([id, 1])
    await factory().recordGateRun("es-programmer", {
      passed: false,
      findings: [],
      summary: "red",
      failedTests: [`test/${id}.test.ts`],
    })
    await write(h.directory, path.relative(h.directory, path.join(wt, `src/${id}.ts`)), SRC(id))
    const green = Bun.spawnSync(["bun", "test", `test/${id}.test.ts`], { cwd: wt })
    expect([id, green.exitCode]).toEqual([id, 0])
  }

  const completeViaProgrammer = async (id: string) => {
    const { tools } = await h.run(
      `build ${id} ${delegate("es-programmer", `finish ${id} ${child("es_complete", {})}`)}`,
      {
        agent: "factory",
      },
    )
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:completed"])
    expect(tools[0]?.text).toContain("in QA")
  }

  const qaPassViaDelegation = async (id: string) => {
    for (const seat of ["es-qa-functional", "es-qa-adversarial"]) {
      const { tools } = await h.run(
        `qa ${id} ${delegate(seat, `verdict on ${id} ${child("es_qa_verdict", { verdict: "pass", notes: "criteria met" })}`)}`,
        {
          agent: "factory",
        },
      )
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:completed"])
    }
  }

  const auditPassViaDelegation = async (id: string, auditId: string) => {
    const opened = await h.run(`audit ${id} ${call("es_audit_open", { target: id })}`, { agent: "factory" })
    expect(opened.tools[0]?.status).toBe("completed")
    expect(opened.tools[0]?.text).toContain(auditId)
    // The witnessed excerpt is read live: a fix may have rewritten the file.
    const wt = (await factory().activeWorktree())!
    const line = (await Bun.file(path.join(wt, `src/${id}.ts`)).text()).split("\n")[0]!
    for (const [seat, findings] of [
      [
        "es-auditor-thesis",
        [
          {
            kind: "invariant",
            title: `${id} is a pure constant function`,
            severity: "info",
            file: `src/${id}.ts`,
            lines: [1, 1],
            excerpt: line,
            detail: "No inputs, no state, no branches; the single return holds.",
            holds: true,
          },
        ],
      ],
      ["es-auditor-antithesis", []],
    ] as const) {
      const { tools } = await h.run(
        `review ${id} ${delegate(seat, `verdict on ${auditId} ${child("es_audit_verdict", { audit: auditId, verdict: "pass", findings, notes: "sound" })}`)}`,
        { agent: "factory" },
      )
      expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:completed"])
    }
  }

  test("grill → research (deferred fact) → spec → build", async () => {
    await factory().provisionRun("tester", 10)
    await factory().writeFrontier("grill", {
      version: "1.1",
      idea: "a greeting library",
      spendCeiling: { currency: "USD", maxAmount: 10 },
      round: 1,
      settled: true,
      nodes: [
        { id: "scope", question: "What ships first?", status: "settled", answer: "greet", round: 1 },
        { id: "compat", kind: "fact", question: "Does bun test run a single file?", status: "deferred", round: 1 },
      ],
    })
    await recordApproval(h.directory, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
    await factory().beginResearch("human:tester")
    const cache = new SourceCache(researchSourcesDir(h.directory), state)
    const source = await cache.put({
      url: "https://example.test/bun-test",
      text: "The bun test runner accepts a single file path argument.",
      provider: "fetch",
    })
    const layout = factoryLayout(h.directory)
    await write(
      h.directory,
      path.relative(h.directory, layout.researchReport),
      `- Bun runs one file (fact:compat) [VERIFIED: sha256:${source.meta.sha256} "accepts a single file path argument"]\n`,
    )
    const researched = await h.run(`research ${call("es_research_complete", {})}`, { agent: "factory" })
    expect(researched.tools[0]?.status).toBe("completed")
    expect((await factory().read())!.stage).toBe("SPEC")

    await writeJson(path.join(h.directory, ".factory/roadmap.json"), {
      version: 1,
      title: "Greeting library",
      phases: [
        { id: "alpha", title: "Greet" },
        { id: "beta", title: "Greet formally" },
      ],
    })
    for (const id of ["alpha", "beta"])
      await write(
        h.directory,
        `.factory/specs/${id}/GOAL.md`,
        stringifyFrontmatter(
          {
            phase: id,
            title: id,
            acceptance: [{ kind: "file", id: "impl", description: "implementation exists", path: `src/${id}.ts` }],
          },
          `Implement ${id}.\n`,
        ),
      )
    await recordApproval(h.directory, { stage: "spec", channel: "cli", approvedBy: "tester", signer })
    const started = await h.run(`build ${call("es_build_start", {})}`, { agent: "factory" })
    expect(started.tools[0]?.status).toBe("completed")
    expect((await factory().read())!.stage).toBe("BUILD")
    // audit.phase required reached the host factory: the state block says so.
    const status = await h.run(`status ${call("es_status", {})}`, { agent: "factory" })
    expect(status.tools[0]?.text).toContain("audit phase: required")
  }, 120_000)

  test("phase alpha: build → QA → audit → pass, then STOP/resume", async () => {
    await redThenGreen("alpha")
    await completeViaProgrammer("alpha")
    await qaPassViaDelegation("alpha")
    // Required mode holds the merge with no audit yet.
    expect((await factory().read())!.phases[0]!.status).toBe("qa")
    await auditPassViaDelegation("alpha", "audit-01")
    const state = (await factory().read())!
    expect([state.phases[0]!.status, state.phases[0]!.audit?.status, state.activePhase]).toEqual([
      "passed",
      "passed",
      "beta",
    ])

    // STOP halts the run between phases; a human resumes it.
    await write(h.directory, ".factory/STOP", "pipeline pause")
    const stopped = await h.run(`status ${call("es_status", {})}`, { agent: "factory" })
    expect(stopped.tools[0]?.status).toBe("error")
    expect(stopped.tools[0]?.text).toContain("pause")
    await rm(path.join(h.directory, ".factory/STOP"))
    expect((await factory().resume("tester")).stage).toBe("BUILD")
  }, 240_000)

  test("phase beta: a QA fail sends it back, the fix passes, audit passes, release → DONE", async () => {
    await redThenGreen("beta")
    await completeViaProgrammer("beta")
    const functional = await h.run(
      `qa beta ${delegate("es-qa-functional", `verdict on beta ${child("es_qa_verdict", { verdict: "pass", notes: "criteria met" })}`)}`,
      { agent: "factory" },
    )
    expect(functional.tools[0]?.status).toBe("completed")
    const adversarial = await h.run(
      `qa beta ${delegate("es-qa-adversarial", `verdict on beta ${child("es_qa_verdict", { verdict: "fail", notes: "1. beta drops empty input (src/beta.ts:1)" })}`)}`,
      { agent: "factory" },
    )
    expect(adversarial.tools[0]?.status).toBe("completed")
    // A QA split waits for the manager; the tiebreak for fail sends beta back.
    const tiebreak = await h.run(
      `split beta ${delegate("es-manager", `break the beta split ${child("es_tiebreak", { verdict: "fail", notes: "adversarial is right: beta must handle empty input" })}`)}`,
      { agent: "factory" },
    )
    expect(tiebreak.tools[0]?.status).toBe("completed")
    expect((await factory().read())!.phases[1]!).toMatchObject({ status: "building", failures: 1 })

    // Fix the flagged edge and complete again; the red-first evidence stands.
    const wt = (await factory().activeWorktree())!
    await write(
      h.directory,
      path.relative(h.directory, path.join(wt, "src/beta.ts")),
      `export function beta(name = "world") { return name === "" ? "hello" : \`hello \${name}\` }\n`,
    )
    await completeViaProgrammer("beta")
    await qaPassViaDelegation("beta")
    await auditPassViaDelegation("beta", "audit-02")
    const released = (await factory().read())!
    expect([released.stage, released.phases[1]!.status, released.phases[1]!.audit?.status]).toEqual([
      "RELEASE",
      "passed",
      "passed",
    ])

    // No PR opener in tests: es_release refuses, the human records the PR.
    const noPr = await h.run(`ship ${call("es_release", {})}`, { agent: "factory" })
    expect(noPr.tools[0]?.status).toBe("error")
    const done = await factory().recordPr("tester", "https://example.test/pr/1")
    expect([done.stage, done.release?.prUrl]).toEqual(["DONE", "https://example.test/pr/1"])
  }, 240_000)
})
