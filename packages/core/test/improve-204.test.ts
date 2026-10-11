// #204 integration: harvest + distill over several unit-constructed run
// dirs (one with a broken audit chain); scrubbed output and the
// code-disposes gate dropping fabricated evidence with reasons.
//
// Unit-constructed only: no real factory runs, no timing/perf assertions
// (#155 is flaky by nature and tracked separately), no --open-pr.
import { describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  appendAuditEntry,
  clusterTelemetry,
  disposedWithReasons,
  disposeReason,
  distillProposals,
  factoryLayout,
  harvestRun,
  harvestTelemetry,
  signEngineFile,
  TelemetrySchema,
  undisposed,
  writeDropped,
  writeProposals,
} from "../src/index.ts"

// Planted secrets (fake values in the style of the existing scrub tests).
// Every one must be absent from harvested telemetry.
const GH_A = "ghp_plantedHarvest001AAA"
const GH_BROKEN = "ghu_BrokenChain999aaa"
const SK_ANT = "sk-ant-planted0000XYZ"
const AKIA = "AKIAIOSFODNN7EXAMPLE"
const SLACK = "xoxb-12345-abcdef"
const BEARER = "eyJhbGciOiJIUzI1NiJ9"
const PEM_BODY = "MIIEowIBAAKCAQEAplanted"
const HUNTER = "hunter2-planted"

const QA_REASON = "lint gate red"
const GATE_RULE = "lint/no-unused-vars"

async function writeState(root: string, id: string, haltReason: string): Promise<void> {
  const file = factoryLayout(root).state
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(
    file,
    `${JSON.stringify(
      {
        version: 2,
        runId: id,
        stage: "HALTED",
        mode: "build",
        createdAt: "2026-10-04T00:00:00.000Z",
        updatedAt: "2026-10-04T01:00:00.000Z",
        spend: { usd: 1, estimated: false, events: 5 },
        phases: [
          {
            id: "p1",
            title: "phase",
            status: "failed",
            goalHash: "a".repeat(64),
            failures: 2,
            replanned: false,
            history: [],
          },
        ],
        halt: { reason: haltReason, at: "2026-10-04T01:00:00.000Z", from: "QA" },
        audits: [],
      },
      null,
      2,
    )}\n`,
  )
}

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

async function writeChain(root: string, haltReason: string): Promise<void> {
  await appendAuditEntry(root, { actor: "system", action: "stage.build" })
  await appendAuditEntry(root, { actor: "agent:qa", action: "qa.fail", payload: { phase: "p1", reason: QA_REASON } })
  await appendAuditEntry(root, { actor: "system", action: "stage.halted", payload: { reason: haltReason } })
}

/** Two sealed runs plus one sealed run with a broken chain, and an evals dir. */
async function buildFixture(): Promise<{
  parent: string
  stateDir: string
  runs: string[]
  broken: string
  evals: string
  cleanup(): Promise<void>
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "es-204-core-"))
  const stateDir = await mkdtemp(path.join(tmpdir(), "es-204-core-state-"))
  const haltA = `phase p1 failed: GITHUB_TOKEN=${GH_A} with Bearer ${BEARER}`
  const haltB =
    `phase p1 failed: api-key: ${HUNTER} plus ` +
    `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`
  const haltBroken = `phase p1 failed: slack ${SLACK} and ${GH_BROKEN}`
  const ids = ["run-a", "run-b"] as const
  const halts: Record<string, string> = { "run-a": haltA, "run-b": haltB }
  for (const id of ids) {
    const root = path.join(parent, id)
    await writeState(root, id, halts[id]!)
    await writeGateSummary(root, id)
    await writeChain(root, halts[id]!)
    await signEngineFile(factoryLayout(root).state, stateDir)
  }
  const broken = path.join(parent, "run-broken")
  await writeState(broken, "run-broken", haltBroken)
  await writeGateSummary(broken, "run-broken")
  await writeChain(broken, haltBroken)
  await signEngineFile(factoryLayout(broken).state, stateDir)
  // Break the chain with a corrupt trailing line: the valid prefix stays so
  // the run still contributes its gate/qa signals, but verification fails.
  await appendFile(factoryLayout(broken).audit, "not-json\n")
  const evals = path.join(parent, "evals")
  await mkdir(evals, { recursive: true })
  await writeFile(
    path.join(evals, "agg.json"),
    `${JSON.stringify(
      {
        at: "2026-10-04T00-00-00-000Z",
        model: "test/model",
        results: [
          { id: "case-x", pass: false, failures: ["gate lint red", "gate lint red", `leaked ${SK_ANT}`], steps: 9 },
          { id: "case-y", pass: false, failures: ["gate lint red", `key ${AKIA} here`], steps: 4 },
          { id: "case-ok", pass: true, failures: [], steps: 3 },
        ],
      },
      null,
      2,
    )}\n`,
  )
  return {
    parent,
    stateDir,
    runs: [path.join(parent, "run-a"), path.join(parent, "run-b"), broken],
    broken,
    evals,
    async cleanup() {
      await rm(parent, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    },
  }
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

describe("issue #204: harvest + distill over several runs incl. a broken chain", () => {
  test("harvest is scrubbed, schema-valid; the broken chain is reported, never repaired", async () => {
    const fix = await buildFixture()
    try {
      const brokenFile = factoryLayout(fix.broken).audit
      const before = await readFile(brokenFile, "utf8")
      const telemetry = await harvestTelemetry({ runs: fix.runs, evals: [fix.evals] }, { stateDir: fix.stateDir })
      expect(TelemetrySchema.parse(telemetry)).toEqual(telemetry)
      expect(telemetry.runs.map((run) => run.id)).toEqual(["run-a", "run-b", "run-broken"])
      const text = JSON.stringify(telemetry)
      for (const secret of [GH_A, GH_BROKEN, SK_ANT, AKIA, SLACK, BEARER, PEM_BODY, HUNTER])
        expect(text).not.toContain(secret)
      // Shape is preserved: names stay, only values become [redacted].
      expect(text).toContain("GITHUB_TOKEN=")
      expect(text).toContain("Bearer")
      // The broken chain is reported with an error and left on disk untouched.
      const brokenRun = telemetry.runs.find((run) => run.id === "run-broken")!
      expect(brokenRun.auditChain.valid).toBe(false)
      expect(typeof brokenRun.auditChain.error).toBe("string")
      expect(await readFile(brokenFile, "utf8")).toBe(before)
      // The sealed runs keep their valid chains and seals.
      for (const id of ["run-a", "run-b"]) {
        const run = telemetry.runs.find((entry) => entry.id === id)!
        expect(run.auditChain.valid).toBe(true)
        expect(run.seal).toEqual({ valid: true })
      }
      // Direct harvestRun agrees: broken is reported, not repaired.
      const direct = await harvestRun(fix.broken, { stateDir: fix.stateDir })
      expect(direct.auditChain.valid).toBe(false)
      expect(await readFile(brokenFile, "utf8")).toBe(before)
    } finally {
      await fix.cleanup()
    }
  })

  test("distill clusters all three kinds; fabricated evidence is dropped with reasons", async () => {
    const fix = await buildFixture()
    try {
      const telemetry = await harvestTelemetry({ runs: fix.runs, evals: [fix.evals] }, { stateDir: fix.stateDir })
      const thresholds = { minOccurrences: 2, minRuns: 2 }
      const clusters = clusterTelemetry(telemetry, thresholds)
      expect(clusters.length).toBeGreaterThanOrEqual(3)
      const proposals = await distillProposals(telemetry, thresholds)
      expect(proposals.length).toBeGreaterThanOrEqual(3)
      expect([...new Set(proposals.map((proposal) => proposal.kind))].sort()).toEqual([
        "domain-pack",
        "gate-tuning",
        "prompt-guidance",
      ])
      expect(undisposed(proposals, telemetry)).toEqual(proposals)
      // Fabricated evidence: a quote the harvester never said is disposed.
      const [first] = proposals
      const forged = { ...first!, cluster: { ...first!.cluster, evidence: ["run x: invented quote"] } }
      const reasons = disposeReason(forged, telemetry)
      expect(reasons.some((reason) => reason.includes("verbatim"))).toBe(true)
      expect(undisposed([forged], telemetry)).toEqual([])
      const dropped = disposedWithReasons([forged], telemetry)
      expect(dropped).toHaveLength(1)
      expect(dropped[0]!.reasons.some((reason) => reason.includes("verbatim"))).toBe(true)
      // Hallucinated model numerals are disposed too.
      const tainted = { ...first!, rationale: `${first!.rationale} As gpt-4 would suggest.` }
      expect(disposeReason(tainted, telemetry).some((reason) => reason.includes("hallucinated model numeral"))).toBe(
        true,
      )
      // Dropped proposals are reported with reasons, byte-identical on rerun.
      const out = await mkdtemp(path.join(tmpdir(), "es-204-distill-"))
      try {
        const rendered = new Map(
          await Promise.all(
            proposals.map(async (proposal) => {
              const { files } = await import("../src/improve/distill.ts").then((mod) =>
                mod.renderProposalFiles(proposal.cluster),
              )
              return [proposal.id, files] as const
            }),
          ),
        )
        const written = await writeProposals(out, proposals, rendered)
        expect(written.length).toBe(proposals.length)
        const droppedFile = await writeDropped(out, dropped)
        expect(await readFile(droppedFile, "utf8")).toContain("verbatim")
        await writeDropped(out, dropped)
        expect(await readFile(droppedFile, "utf8")).toContain("verbatim")
        // Gate-tuning explains only: gates.md, never the control file.
        const gate = proposals.find((proposal) => proposal.kind === "gate-tuning")!
        expect(gate.files).toEqual(["gates.md"])
        const files = await walkFiles(out)
        expect(files.some((file) => path.basename(file) === "gates.json")).toBe(false)
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    } finally {
      await fix.cleanup()
    }
  })
})
