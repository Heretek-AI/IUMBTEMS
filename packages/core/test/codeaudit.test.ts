// Code audits: the blocking lifecycle (decision 2) for path audits, the
// line-pointer law at es_audit_verdict, and the round's dossier and report.
// Phase audits are exercised in factory.test.ts (they need a built phase).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { recordApproval } from "../src/approval/index.ts"
import { codeAuditTools, renderAuditReport } from "../src/codeaudit/index.ts"
import { Factory, FactoryError, FactoryHalted } from "../src/factory/index.ts"
import { factoryLayout } from "../src/layout.ts"
import { esTools } from "../src/ops/tools.ts"
import { type Fixture, frontier, gitRepo } from "./helpers.ts"

const AUTH = [
  "export function login(db: Db, user: string) {",
  `  const sql = "SELECT * FROM users WHERE name = '" + user + "'"`,
  "  return db.query(sql)",
  "}",
  "",
].join("\n")

let fx: Fixture
let factory: Factory
beforeEach(async () => {
  fx = await gitRepo("es-audit-")
  factory = new Factory(fx.root, {
    gates: async () => ({ passed: true, findings: [], summary: "green" }),
    stateDir: fx.state,
  })
  await mkdir(path.join(fx.root, "src"), { recursive: true })
  await writeFile(path.join(fx.root, "src/auth.ts"), AUTH)
})
afterEach(() => fx.cleanup())

const tools = () => {
  const ops = { root: fx.root, factory, stateDir: fx.state }
  const all = [...codeAuditTools(ops), ...esTools(ops)]
  return (name: string) => all.find((tool) => tool.name === name)!
}

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

async function openPathAudit() {
  return (await factory.openAudit("human:tester", { kind: "path", path: "src" }, { ceilingUSD: 5 })).audit
}

describe("opening audits", () => {
  test("a 1.0 run state is refused with the fresh-run instruction", async () => {
    await mkdir(factoryLayout(fx.root).runtime, { recursive: true })
    await writeFile(factoryLayout(fx.root).state, JSON.stringify({ version: 1, runId: "run-old", stage: "GRILL" }))
    await expect(factory.read()).rejects.toThrow("1.1 needs a fresh run")
  })

  test("with no run, a human with a ceiling starts a GRILL run whose provisional ceiling it is (decision 7)", async () => {
    await expect(factory.openAudit("human:tester", { kind: "path", path: "src" })).rejects.toThrow("No factory run")
    const audit = await openPathAudit()
    expect(audit).toMatchObject({ id: "audit-01", round: 1, status: "open", target: { kind: "path", path: "src" } })
    const state = (await factory.read())!
    expect([state.stage, state.spendCeilingUSD, state.audits.length]).toEqual(["GRILL", 5, 1])
    expect(await factory.summary()).toContain("audit audit-01 path:src open r1 t:- a:-")
  })

  test("only the factory seat or a human opens audits; a run needs a ceiling; paths must be real project code", async () => {
    await factory.begin("human:tester")
    await expect(factory.openAudit("es-programmer", { kind: "path", path: "src" })).rejects.toThrow(
      "Only the factory seat",
    )
    await expect(factory.openAudit("factory", { kind: "path", path: "src" })).rejects.toThrow("needs a spend ceiling")
    await expect(factory.openAudit("human:t", { kind: "path", path: "../etc" }, { ceilingUSD: 5 })).rejects.toThrow(
      "outside the project",
    )
    await expect(factory.openAudit("human:t", { kind: "path", path: ".factory" }, { ceilingUSD: 5 })).rejects.toThrow(
      "factory state",
    )
    await expect(factory.openAudit("human:t", { kind: "path", path: "lib" }, { ceilingUSD: 5 })).rejects.toThrow(
      "does not exist",
    )
    await expect(factory.openAudit("human:t", { kind: "phase", phase: "alpha" }, { ceilingUSD: 5 })).rejects.toThrow(
      "No active phase",
    )
  })

  test("STOP halts audit operations like every other factory step", async () => {
    await openPathAudit()
    await writeFile(factoryLayout(fx.root).stop, "stop\n")
    await expect(openPathAudit()).rejects.toBeInstanceOf(FactoryHalted)
  })
})

describe("the line-pointer law at es_audit_verdict", () => {
  test("only auditor seats record verdicts", async () => {
    const audit = await openPathAudit()
    const verdict = tools()("es_audit_verdict")
    await expect(
      verdict.execute({ audit: audit.id, verdict: "pass", findings: [], notes: "" }, { agent: "factory" }),
    ).rejects.toThrow("Only the auditor seats")
  })

  test("a hallucinated file, a line past the end, a wrong excerpt or an out-of-target file refuses the whole verdict", async () => {
    const audit = await openPathAudit()
    await writeFile(path.join(fx.root, "README.md"), "# fixture\nThe whole README file text.\n")
    const verdict = tools()("es_audit_verdict")
    const attempt = (findings: unknown[]) =>
      verdict.execute({ audit: audit.id, verdict: "fail", findings, notes: "n" }, { agent: "es-auditor-antithesis" })
    await expect(attempt([{ ...injection, file: "src/session.ts" }])).rejects.toThrow(
      "src/session.ts#L2-L3: src/session.ts does not exist",
    )
    await expect(attempt([{ ...injection, lines: [2, 40] }])).rejects.toThrow("past the end of the file (4 lines)")
    await expect(attempt([{ ...injection, lines: [1, 1] }])).rejects.toThrow("excerpt not found verbatim")
    await expect(
      attempt([{ ...injection, file: "README.md", lines: [2, 2], excerpt: "The whole README file" }]),
    ).rejects.toThrow("outside the audit target (src)")
    await expect(attempt([injection, { ...injection, lines: [9, 9] }])).rejects.toThrow(
      "1 finding(s) do not point at real code",
    )
    // Nothing reached the state, the records or the dossier.
    expect((await factory.read())!.audits[0]!.antithesis).toBeUndefined()
    expect(await Bun.file(factoryLayout(fx.root).auditRecords(audit.id)).exists()).toBe(false)
  })

  test("malformed findings and verdicts that contradict their findings are refused", async () => {
    const audit = await openPathAudit()
    const verdict = tools()("es_audit_verdict")
    const call = (v: string, findings: unknown[], agent = "es-auditor-antithesis") =>
      verdict.execute({ audit: audit.id, verdict: v, findings, notes: "n" }, { agent })
    await expect(call("fail", [{ ...injection, cwe: undefined }])).rejects.toThrow("a vulnerability needs its CWE id")
    await expect(call("fail", [{ ...injection, cwe: "89" }])).rejects.toThrow("expected CWE-<number>")
    await expect(call("fail", [invariant])).rejects.toThrow("A fail needs at least one witnessed defect")
    await expect(call("pass", [injection])).rejects.toThrow("A pass cannot carry defects (src/auth.ts#L2-L3)")
  })
})

describe("blocking (decision 2)", () => {
  async function approvedFrontier() {
    await factory.writeFrontier("grill", frontier())
    await recordApproval(fx.root, { stage: "frontier", channel: "cli", approvedBy: "tester", stateDir: fx.state })
  }

  test("a split goes to the manager; a failed path audit blocks the next transition until a re-audit passes", async () => {
    const audit = await openPathAudit()
    await approvedFrontier()
    const tool = tools()
    const verdict = (agent: string, v: string, findings: unknown[]) =>
      tool("es_audit_verdict").execute({ audit: audit.id, verdict: v, findings, notes: `${agent} notes` }, { agent })
    expect(await verdict("es-auditor-thesis", "pass", [invariant])).toContain("waiting for the other auditor")
    expect(await verdict("es-auditor-antithesis", "fail", [injection])).toContain("the manager breaks the tie")
    await expect(factory.beginResearch("human:tester")).rejects.toThrow(
      "Blocked by code audit(s): audit-01 on path src is open",
    )
    await expect(
      tool("es_tiebreak").execute({ verdict: "fail", notes: "x", audit: audit.id }, { agent: "es-qa-functional" }),
    ).rejects.toThrow("Only the manager seat")
    const broken = await tool("es_tiebreak").execute(
      { verdict: "fail", notes: "the injection is real", audit: audit.id },
      { agent: "es-manager" },
    )
    expect(broken).toContain("audit audit-01 path:src failed r1 t:pass a:fail x:fail")
    expect(broken).toContain("antithesis: fail, 1 finding(s); defects: CWE-89 src/auth.ts#L2-L3")
    await expect(factory.beginResearch("human:tester")).rejects.toThrow("audit-01 on path src is failed")

    // The code is fixed; a new round passes and unblocks research.
    await writeFile(
      path.join(fx.root, "src/auth.ts"),
      AUTH.replace(`"SELECT * FROM users WHERE name = '" + user + "'"`, `"SELECT * FROM users WHERE name = ?"`).replace(
        "db.query(sql)",
        "db.query(sql, [user])",
      ),
    )
    expect(await tool("es_audit_open").execute({ target: "src" }, { agent: "factory" })).toContain(
      "Opened audit-01 (round 2)",
    )
    const fixed = { ...invariant, excerpt: "return db.query(sql, [user])" }
    await verdict("es-auditor-thesis", "pass", [fixed])
    expect(await verdict("es-auditor-antithesis", "pass", [])).toContain("the audit is passed")
    expect((await factory.beginResearch("human:tester")).stage).toBe("RESEARCH")
  })

  test("a human may dismiss a blocking audit, with the reason on record", async () => {
    const audit = await openPathAudit()
    await approvedFrontier()
    await expect(factory.dismissAudit("tester", audit.id, "  ")).rejects.toThrow("needs a reason")
    const state = await factory.dismissAudit("tester", audit.id, "third-party code we do not ship")
    expect(state.audits[0]).toMatchObject({ status: "dismissed", dismissed: { by: "human:tester" } })
    expect((await factory.beginResearch("human:tester")).stage).toBe("RESEARCH")
    await expect(factory.dismissAudit("tester", audit.id, "again")).rejects.toThrow(FactoryError)
  })
})

describe("dossier and report", () => {
  test("each round writes a witnessed code-audit dossier and a deterministic report", async () => {
    const audit = await openPathAudit()
    const verdict = tools()("es_audit_verdict")
    await verdict.execute(
      { audit: audit.id, verdict: "pass", findings: [invariant], notes: "mapped" },
      { agent: "es-auditor-thesis" },
    )
    await verdict.execute(
      { audit: audit.id, verdict: "fail", findings: [injection], notes: "1. CWE-89" },
      { agent: "es-auditor-antithesis" },
    )
    const dossier = JSON.parse(await readFile(factoryLayout(fx.root).auditDossier(audit.id), "utf8"))
    expect(dossier).toMatchObject({ mode: "code-audit", subject: "path src (round 1)" })
    expect(dossier.claims.map((claim: any) => [claim.severity, claim.location.file, claim.witness.ok])).toEqual([
      ["info", "src/auth.ts", true],
      ["high", "src/auth.ts", true],
    ])
    const report = await readFile(factoryLayout(fx.root).auditReport(audit.id), "utf8")
    expect(report).toContain(
      "| high | vulnerability | CWE-89 | `src/auth.ts#L2-L3` | SQL built by string concatenation | antithesis |",
    )
    expect(report.indexOf("SQL built by string concatenation")).toBeLessThan(
      report.indexOf("Queries go through the db handle"),
    )
    expect(report).toContain("**Remediation:** Use db.query('SELECT * FROM users WHERE name = ?', [user]).")
  })

  test("the report orders findings by severity, file and line, whatever the input order", () => {
    const audit = {
      id: "audit-09",
      target: { kind: "path", path: "src" },
      round: 1,
      status: "open",
      openedAt: "t",
      openedBy: "h",
    } as const
    const record = (seat: "auditor-thesis" | "auditor-antithesis", findings: any[]) => ({
      audit: "audit-09",
      round: 1,
      seat,
      by: seat,
      verdict: "fail" as const,
      notes: "",
      findings,
      at: "t",
    })
    const low = { ...injection, severity: "low", title: "Low one", lines: [1, 1] }
    const highB = { ...injection, title: "High b", file: "src/b.ts" }
    const highA = { ...injection, title: "High a" }
    const one = renderAuditReport(audit, 1, [record("auditor-antithesis", [low, highB, highA])])
    const two = renderAuditReport(audit, 1, [record("auditor-antithesis", [highA, low, highB])])
    expect(one).toBe(two)
    expect([one.indexOf("High a"), one.indexOf("High b"), one.indexOf("Low one")]).toEqual(
      [one.indexOf("High a"), one.indexOf("High b"), one.indexOf("Low one")].sort((a, b) => a - b),
    )
  })
})
