// Issue #186 integration pins, core side (bug #241 closers): the verifySpan
// short-excerpt branch at es_audit_verdict level. The schema keeps excerpt
// min(1); the 12-char witness in verifySpan is what refuses — this file pins
// that current behavior without weakening either.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { codeAuditTools } from "../src/codeaudit/index.ts"
import { Factory } from "../src/factory/index.ts"
import { factoryLayout } from "../src/layout.ts"
import { esTools } from "../src/ops/tools.ts"
import { verifySpan } from "../src/research/quote.ts"
import { AuditFindingSchema } from "../src/schema/codeaudit.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

const AUTH = [
  "export function login(db: Db, user: string) {",
  `  const sql = "SELECT * FROM users WHERE name = '" + user + "'"`,
  "  return db.query(sql)",
  "}",
  "",
].join("\n")

let fx: Fixture
let factory: Factory
const PASSPHRASE = "test-passphrase-1234"
let signer: HumanSigner
beforeEach(async () => {
  fx = await gitRepo("es-audit-186-")
  await sealHumanKey(PASSPHRASE, fx.state)
  signer = await unlockHumanKey(PASSPHRASE, fx.state)
  void signer
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

async function openPathAudit() {
  return (await factory.openAudit("human:tester", { kind: "path", path: "src" }, { ceilingUSD: 5 })).audit
}

describe("verifySpan short branch (#241)", () => {
  test("an 11-char span is too short; a 12-char verbatim span is evidence", () => {
    const source = "return db.query(sql)"
    expect(verifySpan(source, "db.query(sq")).toEqual({
      ok: false,
      reason: "too short to be evidence (need at least 12 characters)",
    })
    expect(verifySpan(source, "db.query(sql")).toEqual({ ok: true, index: 7 })
    expect(verifySpan(source, "db.query(no)").ok).toBe(false)
  })

  test("the schema still accepts a short excerpt; the witness is what refuses", () => {
    // #241 item 2 premise: schema/codeaudit.ts promises "at least 12
    // characters" in the comment but enforces min(1). Pin the behavior:
    // parsing succeeds, so only the witness stands in the way.
    const parsed = AuditFindingSchema.safeParse({ ...injection, lines: [3, 3], excerpt: "db.query" })
    expect(parsed.success).toBe(true)
  })
})

describe("short excerpts at es_audit_verdict (#241)", () => {
  test("a <12-char excerpt refuses the whole verdict with 'too short to be evidence'; nothing is recorded", async () => {
    const audit = await openPathAudit()
    const verdict = tools()("es_audit_verdict")
    const short = { ...injection, lines: [3, 3], excerpt: "db.query" }
    await expect(
      verdict.execute(
        { audit: audit.id, verdict: "fail", findings: [short], notes: "n" },
        { agent: "es-auditor-antithesis" },
      ),
    ).rejects.toThrow("too short to be evidence")
    // One short excerpt among good findings still refuses everything.
    await expect(
      verdict.execute(
        { audit: audit.id, verdict: "fail", findings: [injection, short], notes: "n" },
        { agent: "es-auditor-antithesis" },
      ),
    ).rejects.toThrow("1 finding(s) do not point at real code")
    // Nothing reached the state, the records or the dossier.
    expect((await factory.read())!.audits[0]!.antithesis).toBeUndefined()
    expect(await Bun.file(factoryLayout(fx.root).auditRecords(audit.id)).exists()).toBe(false)
  })
})
