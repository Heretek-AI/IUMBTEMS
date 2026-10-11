// Issue #186 integration tests on the real v2 host (merge-blocking,
// deterministic): scripted seats drive the real plugin tools.
// - An auditor finding quoting a line that does not exist refuses the whole
//   verdict (nothing recorded); one that exists is accepted and blocks the
//   next stage transition (passPhase gating).
// - audit.phase required with no audit opened holds passPhase: a QA-passed
//   phase waits instead of merging.
// - Bug #241: a <12-char excerpt is refused at verdict level ("too short to
//   be evidence"); verifySpan and the schema are unchanged (pinned in
//   packages/core/test/codeaudit-186.test.ts).
// Live-model runs (#139, 5/5) are out of scope: no paid models here.
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
  readAuditRecords,
  recordApproval,
  researchSourcesDir,
  SourceCache,
  sealHumanKey,
  stringifyFrontmatter,
  unlockHumanKey,
} from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`

const AUTH = [
  "export function login(db: Db, user: string) {",
  `  const sql = "SELECT * FROM users WHERE name = '" + user + "'"`,
  "  return db.query(sql)",
  "}",
  "",
].join("\n")

const injection = {
  kind: "vulnerability",
  title: "SQL built by string concatenation",
  severity: "high",
  cwe: "CWE-89",
  file: "src/auth.ts",
  lines: [2, 3],
  excerpt: `"SELECT * FROM users WHERE name = '" + user`,
  detail: "user = \"' OR '1'='1\" returns every row; the query is concatenated, not parameterised.",
  remediation: "Use db.query('SELECT * FROM users WHERE name = ?', [user]).",
}
const invariant = {
  kind: "invariant",
  title: "Queries go through the db handle",
  severity: "info",
  file: "src/auth.ts",
  lines: [3, 3],
  excerpt: "return db.query(sql)",
  detail: "All database access in this module uses the injected db handle.",
  holds: true,
}

const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

async function bootHost(prefix: string, audit?: { phase: "required" }) {
  const state = await mkdtemp(path.join(tmpdir(), prefix))
  await sealHumanKey("test-passphrase-1234", state)
  const signer = await unlockHumanKey("test-passphrase-1234", state)
  const h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off", ...(audit ? { audit } : {}) } }],
    files: { "README.md": "# audit-186\n" },
  })
  const factory = () => new Factory(h.directory, { gates: gateRunner({ stateDir: state }), stateDir: state })
  return { state, h, factory, signer }
}

describe("audit-186 path audit on the host", () => {
  let h: Harness
  let state: string
  let factory: () => Factory
  let signer: HumanSigner
  beforeAll(async () => {
    ;({ h, state, factory, signer } = await bootHost("es-audit-186-"))
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("hallucinated and short findings are refused whole; witnessed ones are accepted and block", async () => {
    await write(h.directory, "src/auth.ts", AUTH)
    await factory().provisionRun("tester", 5)
    const opened = await h.run(call("es_audit_open", { target: "src" }), { agent: "factory" })
    expect([opened.tools[0]?.status, opened.tools[0]?.text]).toEqual([
      "completed",
      expect.stringContaining("Opened audit-01"),
    ])

    const verdict = (agent: string, findings: unknown[], v = "fail") =>
      h.run(call("es_audit_verdict", { audit: "audit-01", verdict: v, findings, notes: "n" }), { agent })

    // A line past the end of the file: refused, nothing recorded.
    const pastEnd = await verdict("es-auditor-antithesis", [{ ...injection, lines: [2, 40] }])
    expect([pastEnd.tools[0]?.status, pastEnd.tools[0]?.text]).toEqual([
      "error",
      expect.stringContaining("past the end of the file (4 lines)"),
    ])
    expect(await readAuditRecords(h.directory, "audit-01")).toEqual([])

    // A file that does not exist: refused, nothing recorded.
    const missing = await verdict("es-auditor-antithesis", [{ ...injection, file: "src/session.ts" }])
    expect([missing.tools[0]?.status, missing.tools[0]?.text]).toEqual([
      "error",
      expect.stringContaining("does not exist"),
    ])
    expect(await readAuditRecords(h.directory, "audit-01")).toEqual([])

    // One bad finding among good ones still refuses the whole verdict (#241 whole-verdict law).
    const mixed = await verdict("es-auditor-antithesis", [injection, { ...injection, lines: [9, 9] }])
    expect([mixed.tools[0]?.status, mixed.tools[0]?.text]).toEqual([
      "error",
      expect.stringContaining("1 finding(s) do not point at real code"),
    ])
    expect(await readAuditRecords(h.directory, "audit-01")).toEqual([])

    // Bug #241: a <12-char excerpt is refused at verdict level; the schema
    // (min 1) is untouched, the witness refuses.
    const short = await verdict("es-auditor-antithesis", [{ ...injection, lines: [3, 3], excerpt: "db.query" }])
    expect([short.tools[0]?.status, short.tools[0]?.text]).toEqual([
      "error",
      expect.stringContaining("too short to be evidence"),
    ])
    expect(await readAuditRecords(h.directory, "audit-01")).toEqual([])

    // Findings that exist: accepted.
    const thesis = await verdict("es-auditor-thesis", [invariant], "pass")
    expect(thesis.tools[0]?.status).toBe("completed")
    const antithesis = await verdict("es-auditor-antithesis", [injection])
    expect(antithesis.tools[0]?.status).toBe("completed")
    const records = await readAuditRecords(h.directory, "audit-01")
    expect(records.map((record) => [record.seat, record.verdict, record.findings.length])).toEqual([
      ["auditor-thesis", "pass", 1],
      ["auditor-antithesis", "fail", 1],
    ])

    // The split goes to the manager; a fail blocks the next transition.
    const tiebreak = await h.run(
      call("es_tiebreak", { verdict: "fail", notes: "the injection is real", audit: "audit-01" }),
      {
        agent: "es-manager",
      },
    )
    expect([tiebreak.tools[0]?.status, tiebreak.tools[0]?.text]).toEqual([
      "completed",
      expect.stringContaining("failed"),
    ])
    await factory().writeFrontier("grill", {
      version: "1.1",
      idea: "A greeting library",
      spendCeiling: { currency: "USD", maxAmount: 25 },
      settled: true,
      nodes: [{ id: "lang", question: "Language?", answer: "TypeScript", status: "settled" }],
    })
    // recordApproval (not approveStage): approveStage would auto-begin
    // research, which the failed audit must refuse — that refusal is what
    // the final assertion proves, from a clean GRILL run.
    await recordApproval(h.directory, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
    await expect(factory().beginResearch("human:tester")).rejects.toThrow("audit-01 on path src is failed")
  }, 120_000)
})

describe("audit-186 audit.phase required on the host", () => {
  let h: Harness
  let state: string
  let factory: () => Factory
  let signer: HumanSigner
  beforeAll(async () => {
    ;({ h, state, factory, signer } = await bootHost("es-audit-186-required-", { phase: "required" }))
  }, 60_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("a QA-passed phase with no audit opened waits instead of merging (passPhase held)", async () => {
    await factory().provisionRun("tester", 10)
    await factory().writeFrontier("grill", {
      version: "1.1",
      idea: "A greeting library",
      spendCeiling: { currency: "USD", maxAmount: 10 },
      settled: true,
      nodes: [{ id: "lang", question: "Language?", answer: "TypeScript", status: "settled" }],
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
      url: "https://example.test/greeting",
      text: "Greeting libraries usually expose a single greet function.",
      provider: "fetch",
    })
    const layout = factoryLayout(h.directory)
    await write(
      h.directory,
      path.relative(h.directory, layout.researchReport),
      `- A greet function is the conventional API [VERIFIED: sha256:${source.meta.sha256} "expose a single greet function"]\n`,
    )
    await factory().completeResearch("factory")
    await write(
      h.directory,
      ".factory/roadmap.json",
      JSON.stringify({ version: 1, title: "Greeting", phases: [{ id: "alpha", title: "Phase alpha" }] }, null, 2),
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
    await approveStage(h.directory, { stage: "spec", channel: "cli", approvedBy: "tester", signer, stateDir: state })
    await factory().startBuild("factory")

    // Programmer: failing test first (red), then the implementation, then complete.
    const wt = (await factory().activeWorktree())!
    await write(
      h.directory,
      path.relative(h.directory, path.join(wt, "test/alpha.test.ts")),
      `test("alpha", () => {})\n`,
    )
    await factory().recordGateRun("es-programmer", {
      passed: false,
      findings: [],
      summary: "red",
      failedTests: ["test/alpha.test.ts"],
    })
    await write(h.directory, path.relative(h.directory, path.join(wt, "src/alpha.ts")), `export const alpha = 1\n`)
    await factory().complete("es-programmer")

    // Both QA seats pass through the real host tools — with no audit opened.
    for (const seat of ["es-qa-functional", "es-qa-adversarial"]) {
      const qa = await h.run(call("es_qa_verdict", { verdict: "pass", notes: "criteria met" }), { agent: seat })
      expect([seat, qa.tools[0]?.status]).toEqual([seat, "completed"])
    }
    const held = (await factory().read())!
    expect([held.stage, held.phases[0]!.status, held.phases[0]!.history.at(-1)?.event]).toEqual([
      "QA",
      "qa",
      "qa-passed",
    ])
    expect(held.phases[0]!.history.at(-1)?.notes).toContain("audit.phase is required")
  }, 180_000)
})
