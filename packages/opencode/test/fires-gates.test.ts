// The pipeline fire suites (merge-blocking, deterministic): scripted seats
// drive the real plugin tools against traps with known answers.
//
// grill-fires: the design tree refuses lossy saves (no deletions, no silent
// edits to settled answers, no round regress), and a fact the grill deferred
// must be answered by RESEARCH before it can complete.
// factory-gate: implementation starts only through the approvals; STOP and the
// spend ceiling halt every seat tool except es_status.
// darkharvest-fires: whatever the harvester proposes, core keeps depend only
// for verified permissive licences (the licence line).
//
// The same graders score real-model runs nightly (evals/cases/*-fires.json).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  Factory,
  factoryLayout,
  gateRunner,
  gradeHarvestFire,
  readFrontier,
  readHarvestResult,
  recordApproval,
  researchSourcesDir,
  SourceCache,
  stringifyFrontmatter,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const fixtures = path.resolve(import.meta.dir, "../../core/test/fixtures")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const readFixture = (file: string) => Bun.file(path.join(fixtures, file)).text()
const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

async function bootHost(prefix: string) {
  const state = await mkdtemp(path.join(tmpdir(), prefix))
  const h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# fire suite\n" },
  })
  const factory = () => new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
  return { state, h, factory }
}

describe("grill-fires", () => {
  let h: Harness
  let state: string
  let factory: () => Factory
  beforeAll(async () => {
    ;({ h, state, factory } = await bootHost("es-grill-fires-"))
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    question: `Q ${id}?`,
    status: "open",
    round: 1,
    ...extra,
  })
  const settled = (id: string, answer: string, extra: Record<string, unknown> = {}) => ({
    ...node(id, extra),
    status: "settled",
    answer,
  })
  const tree = (round: number, nodes: unknown[], extra: Record<string, unknown> = {}) => ({
    version: "1.1",
    idea: "a session handoff feature",
    spendCeiling: { currency: "USD", maxAmount: 10 },
    round,
    settled: false,
    nodes,
    ...extra,
  })

  test("lossy saves are refused; a deferred fact must be answered before research completes", async () => {
    await factory().provisionRun("tester", 10)
    const scope = node("scope", { choices: ["opencode", "claude"], recommended: "opencode" })
    const protocol = node("protocol", { parent: "scope", choices: ["file", "mcp"], recommended: "file" })
    const compat = {
      id: "compat",
      kind: "fact",
      question: "Does the host expose a session export?",
      status: "deferred",
      round: 1,
    }
    const v1 = tree(1, [scope, protocol, compat])

    const first = await h.run(call("es_frontier_write", { frontier: v1 }), { agent: "grill" })
    expect(first.tools[0]?.status).toBe("completed")
    expect(first.tools[0]?.text).toContain("Next round (1): scope")

    // Trap: deleting a node. Refused, and nothing is recorded.
    const deleted = await h.run(call("es_frontier_write", { frontier: tree(1, [scope, compat]) }), { agent: "grill" })
    expect(deleted.tools[0]?.status).toBe("error")
    expect(deleted.tools[0]?.text).toContain("never deleted")
    expect((await readFrontier(h.directory))!.nodes.length).toBe(3)

    // Settle scope (its own answer is the recommendation, as the grill would).
    const v2 = tree(2, [
      settled("scope", "opencode", { choices: ["opencode", "claude"], recommended: "opencode" }),
      protocol,
      compat,
    ])
    const second = await h.run(call("es_frontier_write", { frontier: v2 }), { agent: "grill" })
    expect(second.tools[0]?.status).toBe("completed")
    expect(second.tools[0]?.text).toContain("Next round (1): protocol")

    // Trap: silently editing a settled answer instead of reopening it.
    const edited = tree(2, [
      settled("scope", "all harnesses", { choices: ["opencode", "claude"], recommended: "opencode" }),
      protocol,
      compat,
    ])
    const silent = await h.run(call("es_frontier_write", { frontier: edited }), { agent: "grill" })
    expect(silent.tools[0]?.status).toBe("error")
    expect(silent.tools[0]?.text).toContain("reopen it first")
    expect((await readFrontier(h.directory))!.nodes.find((item) => item.id === "scope")!.answer).toBe("opencode")

    // Trap: a round that goes backwards.
    const regressed = await h.run(call("es_frontier_write", { frontier: tree(1, v2.nodes) }), { agent: "grill" })
    expect(regressed.tools[0]?.status).toBe("error")
    expect(regressed.tools[0]?.text).toContain("round went back")
    expect((await readFrontier(h.directory))!.round).toBe(2)

    // Settle the last decision; the deferred fact stays for research; freeze.
    const v3 = tree(2, [
      settled("scope", "opencode", { choices: ["opencode", "claude"], recommended: "opencode" }),
      settled("protocol", "file", { parent: "scope", choices: ["file", "mcp"], recommended: "file" }),
      compat,
    ])
    const third = await h.run(call("es_frontier_write", { frontier: v3 }), { agent: "grill" })
    expect(third.tools[0]?.status).toBe("completed")
    const fourth = await h.run(call("es_frontier_write", { frontier: tree(2, v3.nodes, { settled: true }) }), {
      agent: "grill",
    })
    expect(fourth.tools[0]?.status).toBe("completed")
    expect(fourth.tools[0]?.text).toContain("frozen")

    // A granted frontier approval starts RESEARCH; the fact gates its completion.
    await recordApproval(h.directory, { stage: "frontier", channel: "cli", approvedBy: "tester", stateDir: state })
    await factory().beginResearch("human:tester")
    const cache = new SourceCache(researchSourcesDir(h.directory))
    const source = await cache.put({
      url: "https://example.test/handoff",
      text: "Session handoff writes a file the next agent reads.",
      provider: "fetch",
    })
    const layout = factoryLayout(h.directory)
    await write(
      h.directory,
      path.relative(h.directory, layout.researchReport),
      `- Handoff is file-based [VERIFIED: sha256:${source.meta.sha256} "file the next agent reads"]\n`,
    )
    const unanswered = await h.run(call("es_research_complete"), { agent: "factory" })
    expect(unanswered.tools[0]?.status).toBe("error")
    expect(unanswered.tools[0]?.text).toContain("compat")
    await write(
      h.directory,
      path.relative(h.directory, layout.researchReport),
      `- Handoff is file-based (fact:compat) [VERIFIED: sha256:${source.meta.sha256} "file the next agent reads"]\n`,
    )
    const answered = await h.run(call("es_research_complete"), { agent: "factory" })
    expect(answered.tools[0]?.status).toBe("completed")
    expect((await factory().read())!.stage).toBe("SPEC")
  })
})

describe("factory-gate", () => {
  let h: Harness
  let state: string
  let factory: () => Factory
  beforeAll(async () => {
    ;({ h, state, factory } = await bootHost("es-factory-gate-"))
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("builds start only through the approvals; STOP and the ceiling halt every seat tool", async () => {
    await factory().provisionRun("tester", 10)
    const layout = factoryLayout(h.directory)

    // From GRILL there is nothing to build.
    const early = await h.run(call("es_build_start"), { agent: "factory" })
    expect(early.tools[0]?.status).toBe("error")
    expect(early.tools[0]?.text).toContain("needs SPEC")

    // Walk the pipeline up to an UNapproved spec.
    await factory().writeFrontier("grill", {
      version: "1.1",
      idea: "a session handoff feature",
      spendCeiling: { currency: "USD", maxAmount: 10 },
      round: 1,
      settled: true,
      nodes: [{ id: "scope", question: "Which harness first?", status: "settled", answer: "opencode", round: 1 }],
    })
    await recordApproval(h.directory, { stage: "frontier", channel: "cli", approvedBy: "tester", stateDir: state })
    await factory().beginResearch("human:tester")
    const cache = new SourceCache(researchSourcesDir(h.directory))
    const source = await cache.put({
      url: "https://example.test/handoff",
      text: "Session handoff writes a file the next agent reads.",
      provider: "fetch",
    })
    await write(
      h.directory,
      path.relative(h.directory, layout.researchReport),
      `- Handoff is file-based [VERIFIED: sha256:${source.meta.sha256} "file the next agent reads"]\n`,
    )
    await factory().completeResearch("factory")
    await write(
      h.directory,
      ".factory/roadmap.json",
      JSON.stringify({ version: 1, title: "Handoff", phases: [{ id: "alpha", title: "Phase alpha" }] }, null, 2),
    )
    await write(
      h.directory,
      ".factory/specs/alpha/GOAL.md",
      stringifyFrontmatter(
        {
          phase: "alpha",
          title: "Phase alpha",
          acceptance: [{ kind: "file", id: "impl", description: "implementation exists", path: "src/alpha.ts" }],
        },
        "Implement alpha as a vertical slice.\n",
      ),
    )

    // An unapproved (or absent) spec approval refuses the build.
    const unapproved = await h.run(call("es_build_start"), { agent: "factory" })
    expect(unapproved.tools[0]?.status).toBe("error")
    expect(unapproved.tools[0]?.text).toContain("no spec approval")
    expect(existsSync(path.join(h.directory, ".factory/worktrees"))).toBe(false)

    // The human approves; the scripted factory seat can now build.
    await recordApproval(h.directory, { stage: "spec", channel: "cli", approvedBy: "tester", stateDir: state })
    const started = await h.run(call("es_build_start"), { agent: "factory" })
    expect(started.tools[0]?.status).toBe("completed")
    expect(existsSync(path.join(h.directory, ".factory/worktrees/alpha"))).toBe(true)

    // Release is a RELEASE-stage action, not a build-stage one.
    const earlyRelease = await h.run(call("es_release"), { agent: "factory" })
    expect(earlyRelease.tools[0]?.status).toBe("error")
    expect(earlyRelease.tools[0]?.text).toContain("needs RELEASE")

    // STOP stops every seat tool and es tool (plugin.test.ts contract); the
    // core brake records the halt, which only a human can resume.
    await write(h.directory, ".factory/STOP", "lunch")
    const stopped = await h.run(call("es_build_start"), { agent: "factory" })
    expect(stopped.tools[0]?.status).toBe("error")
    expect(stopped.tools[0]?.text).toContain("stopped")
    const reported = await h.run(call("es_status"), { agent: "factory" })
    expect(reported.tools[0]?.status).toBe("error")
    expect(reported.tools[0]?.text).toContain("stopped")
    await expect(factory().complete("es-programmer")).rejects.toThrow("Factory halted")
    expect((await factory().read())!.stage).toBe("HALTED")
    await rm(path.join(h.directory, ".factory/STOP"))
    expect((await factory().resume("tester")).stage).toBe("BUILD")

    // Spend at the ceiling halts too, until a human raises it. A halted run
    // still reports: es_status stays available, everything else is refused.
    await factory().recordSpend(30, true)
    const over = await h.run(call("es_build_start"), { agent: "factory" })
    expect(over.tools[0]?.status).toBe("error")
    expect(over.tools[0]?.text).toContain("halted")
    const stillThere = await h.run(call("es_status"), { agent: "factory" })
    expect(stillThere.tools[0]?.status).toBe("completed")
    expect((await factory().resume("tester", { raiseCeilingUSD: 50 })).stage).toBe("BUILD")
  })
})

describe("darkharvest-fires", () => {
  let h: Harness
  let state: string
  beforeAll(async () => {
    ;({ h, state } = await bootHost("es-harvest-fires-"))
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("core keeps depend only for verified permissive licences, whatever the harvester proposes", async () => {
    const expected = JSON.parse(await readFixture("fires/harvest/expected.json")).candidates as Array<{
      name: string
      license: string | null
      verdict: string
    }>
    for (const candidate of expected) {
      const dir = `vendor/${candidate.name}`
      await write(h.directory, `${dir}/index.js`, `module.exports = function ${candidate.name}() { return 1 }\n`)
      await write(h.directory, `${dir}/package.json`, JSON.stringify({ name: candidate.name, version: "1.0.0" }))
      if (candidate.license)
        await write(h.directory, `${dir}/LICENSE`, await readFixture(`licenses/${candidate.license}.txt`))
    }

    const calls = [
      call("es_harvest_plan", {
        objective: "a session handoff window manager",
        candidates: expected.map((candidate) => ({ name: candidate.name, source: `local:./vendor/${candidate.name}` })),
      }),
      ...expected.map((candidate) => call("es_harvest_scan", { candidate: candidate.name })),
      call("es_harvest_matrix", {
        rows: [
          {
            feature: "session handoff",
            cells: expected.map((candidate) => ({
              candidate: candidate.name,
              verdict: "depend",
              evidence: "it does what we need",
            })),
          },
        ],
      }),
      call("es_harvest_complete"),
    ]
    const { tools } = await h.run(`harvest ${calls.join(" ")}`, { agent: "harvester" })
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(tools.map((tool) => `${tool.name}:completed`))

    // The scans state the licence line; the matrix shows the rewrite.
    const scans = tools.filter((tool) => tool.name === "es_harvest_scan").map((tool) => tool.text ?? "")
    expect(scans.filter((text) => text.includes("NOT authorized")).length).toBe(3)
    const matrixText = tools.find((tool) => tool.name === "es_harvest_matrix")!.text ?? ""
    expect(matrixText).toContain("Policy downgrades:")

    const grade = gradeHarvestFire(
      (await readHarvestResult(h.directory))!.matrix,
      expected.map((candidate) => ({ candidate: candidate.name, verdict: candidate.verdict })),
    )
    expect([grade.failures, grade.pass]).toEqual([[], true])
  })
})
