// Telemetry harvester over runs and evals (#135): deterministic extraction,
// broken-chain reporting (never repaired), secret scrubbing and the versioned
// schema — plus the agent-safe CLI verb.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  harvestEvals,
  harvestRun,
  harvestTelemetry,
  invokesHumanOnly,
  scrubSecrets,
  TELEMETRY_VERSION,
  TelemetrySchema,
} from "../src/index.ts"

const fixtures = path.join(import.meta.dir, "fixtures/improve")
const clean = path.join(fixtures, "run-clean")
const replan = path.join(fixtures, "run-replan")
const broken = path.join(fixtures, "run-broken")
const evals = path.join(fixtures, "evals")

describe("harvestRun", () => {
  test("a clean run extracts counts, spend and a valid chain", async () => {
    const run = await harvestRun(clean)
    expect(run.id).toBe("run-clean")
    expect(run.mode).toBe("build")
    expect(run.stage).toBe("DONE")
    expect(run.halt).toBeUndefined()
    expect(run.spend).toEqual({ usd: 1.25, estimated: false, events: 12 })
    expect(run.phases).toEqual([{ id: "p1", status: "passed", failures: 0, replanned: false }])
    expect(run.gateRejections).toEqual([])
    expect(run.auditFindings).toEqual([])
    expect(run.auditChain).toEqual({ entries: 3, valid: true })
  })

  test("a rocky run reports the replan, gate rejection, audit finding and halt", async () => {
    const run = await harvestRun(replan)
    expect(run.phases).toEqual([{ id: "p1", status: "failed", failures: 5, replanned: true }])
    expect(run.gateRejections).toEqual([{ rule: "lint/no-unused-vars", count: 2 }])
    expect(run.auditFindings).toEqual([{ kind: "invariant", severity: "high", count: 1 }])
    expect(run.halt).toEqual({ reason: "phase p1 failed 5 times", from: "QA" })
    expect(run.auditChain.valid).toBe(true)
    expect(run.spend.estimated).toBe(true)
  })

  test("a broken chain is reported, not repaired", async () => {
    const before = await readFile(path.join(broken, ".factory/runtime/audit.jsonl"), "utf8")
    const run = await harvestRun(broken)
    expect(run.auditChain.valid).toBe(false)
    expect(run.auditChain.error).toBeString()
    expect(await readFile(path.join(broken, ".factory/runtime/audit.jsonl"), "utf8")).toBe(before)
  })

  test("a missing run root still produces a record", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-improve-missing-"))
    try {
      const run = await harvestRun(dir)
      expect(run.phases).toEqual([])
      expect(run.auditChain).toEqual({ entries: 0, valid: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("harvestEvals", () => {
  test("the aggregate maps to eval telemetry, preserving modelLimited", async () => {
    expect(await harvestEvals(evals)).toEqual([
      { case: "grill", pass: true, failures: [], steps: 5, model: "test/model" },
      {
        case: "programmer",
        pass: false,
        failures: ["gate lint red"],
        steps: 12,
        model: "test/model",
        modelLimited: true,
      },
    ])
  })

  test("a missing eval dir harvests nothing", async () => {
    expect(await harvestEvals(path.join(tmpdir(), "es-improve-no-such-dir"))).toEqual([])
  })
})

describe("harvestTelemetry", () => {
  test("the dataset validates against the versioned schema and is deterministic", async () => {
    const first = await harvestTelemetry({ runs: [replan, clean], evals: [evals] })
    const second = await harvestTelemetry({ runs: [clean, replan], evals: [evals] })
    expect(first.version).toBe(TELEMETRY_VERSION)
    expect(TelemetrySchema.parse(first)).toEqual(first)
    expect(second).toEqual({ ...first, harvestedAt: second.harvestedAt })
    expect(first.runs.map((run) => run.id)).toEqual(["run-clean", "run-replan"])
  })
})

describe("scrubSecrets", () => {
  test("env-like values are redacted and state-dir paths collapsed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-state-"))
    try {
      const scrubbed = scrubSecrets(
        { apiToken: "abc123", nested: { password: "hunter2", note: `key at ${dir}/key` }, plain: "hello" },
        { stateDir: dir },
      )
      expect(scrubbed).toEqual({
        apiToken: "[redacted]",
        nested: { password: "[redacted]", note: "key at <state-dir>/key" },
        plain: "hello",
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("harvested telemetry carries no secrets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-state-"))
    const telemetry = await harvestTelemetry({ runs: [clean], evals: [] }, { stateDir: dir })
    expect(JSON.stringify(telemetry)).not.toContain(dir)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("es improve harvest is agent-safe", () => {
  test("the policy does not treat it as human-only", () => {
    expect(invokesHumanOnly("es improve harvest --runs . --out telemetry.json")).toBe(false)
    expect(invokesHumanOnly("es improve harvest --runs a,b --evals e --out o.json")).toBe(false)
  })
})
