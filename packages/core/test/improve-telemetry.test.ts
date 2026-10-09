// Telemetry harvester over runs and evals (#135): deterministic extraction,
// broken-chain reporting (never repaired), secret scrubbing and the versioned
// schema — plus the agent-safe CLI verb.
import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
    const sealed = await sealedCopy("run-clean")
    try {
      const run = await harvestRun(sealed.root, { stateDir: sealed.stateDir })
      expect(run.mode).toBe("build")
      expect(run.stage).toBe("DONE")
      expect(run.halt).toBeUndefined()
      expect(run.spend).toEqual({ usd: 1.25, estimated: false, events: 12 })
      expect(run.phases).toEqual([{ id: "p1", status: "passed", attempts: 1, replans: 0, failures: [] }])
      expect(run.gateRejections).toEqual([])
      expect(run.auditFindings).toEqual([])
      expect(run.auditChain).toEqual({
        entries: 3,
        valid: true,
        trail: [
          {
            seq: 0,
            hash: "0527b13077f6ea0a9ab4a334c1c49e8fd72ea962a795c4f8cbbbce174a69add5",
            action: "stage.grill",
          },
          {
            seq: 1,
            hash: "2a73de11fb7fa865fd9308f038438799e3be4be915ed35949a03eb0ebdf55730",
            action: "phase.pass",
            phase: "p1",
          },
          {
            seq: 2,
            hash: "32e10359c5ef09c95dd003f785c72f5f13ce3f9bba508116963f981b8cf0fa0b",
            action: "qa.pass",
            phase: "p1",
          },
        ],
      })
      expect(run.seal).toEqual({ valid: true })
    } finally {
      await sealed.cleanup()
    }
  })

  test("a rocky run reports the replan, gate rejection, audit finding and halt", async () => {
    const sealed = await sealedCopy("run-replan")
    try {
      const run = await harvestRun(sealed.root, { stateDir: sealed.stateDir })
      expect(run.phases).toEqual([
        {
          id: "p1",
          status: "failed",
          attempts: 6,
          replans: 1,
          failures: [
            { seat: "qa", kind: "qa", reason: "lint gate red" },
            { seat: "manager", kind: "replan", reason: "replan attempt 4" },
            { kind: "gate", rule: "lint/no-unused-vars", reason: "unused (src/x.ts:3)" },
            { kind: "gate", rule: "lint/no-unused-vars", reason: "unused (src/y.ts:9)" },
            {
              seat: "auditor-thesis",
              kind: "audit",
              category: "invariant/high",
              reason: "the programmer seat can write a control file path",
            },
          ],
        },
      ])
      expect(run.gateRejections).toEqual([
        {
          rule: "lint/no-unused-vars",
          count: 2,
          logs: [".factory/runs/run-replan/gates/2026-10-02T02-30-full/summary.json"],
        },
      ])
      expect(run.auditFindings).toEqual([
        {
          kind: "invariant",
          severity: "high",
          count: 1,
          sources: [".factory/audits/audit-01/records.json"],
        },
      ])
      expect(run.halt).toEqual({ reason: "phase p1 failed 5 times", from: "QA" })
      expect(run.auditChain.valid).toBe(true)
      expect(run.spend.estimated).toBe(true)
      expect(run.seal).toEqual({ valid: true })
    } finally {
      await sealed.cleanup()
    }
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
      expect(run.auditChain).toEqual({ entries: 0, valid: true, trail: [] })
      expect(run.seal.valid).toBe(false)
      expect(run.seal.error).toBeString()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("harvestEvals", () => {
  test("the aggregate maps to eval telemetry, preserving modelLimited", async () => {
    expect(await harvestEvals(evals)).toEqual([
      {
        case: "grill",
        pass: true,
        failures: [],
        steps: 5,
        model: "test/model",
        source: "2026-10-03T00-00-00-000Z.json",
      },
      {
        case: "programmer",
        pass: false,
        failures: ["gate lint red"],
        steps: 12,
        model: "test/model",
        modelLimited: true,
        source: "2026-10-03T00-00-00-000Z.json",
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

// ---------------------------------------------------------------- S3.1–S3.4
//
// Repair-151 failing witnesses: value-embedded secrets (S3.1), unsealed run
// state (S3.2) and per-phase failure entries (S3.4).

/** Copy a fixture run to tmp, optionally rewriting its state.json. */
async function fixtureCopy(name: string, mutate?: (state: Record<string, unknown>) => void): Promise<string> {
  // `cp` merges the fixture's contents into the (existing) tmp dir.
  const root = await mkdtemp(path.join(tmpdir(), "es-improve-s3-"))
  await cp(path.join(fixtures, name), root, { recursive: true })
  if (mutate) {
    const file = path.join(root, ".factory/runtime/state.json")
    const state = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    mutate(state)
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
  }
  return root
}

/** Sign a copied run's state.json under a fresh isolated state dir. */
async function sealedCopy(
  name: string,
  mutate?: (state: Record<string, unknown>) => void,
): Promise<{ root: string; stateDir: string; cleanup(): Promise<void> }> {
  const { signEngineFile } = await import("../src/trust/sidecar.ts")
  const root = await fixtureCopy(name, mutate)
  const stateDir = await mkdtemp(path.join(tmpdir(), "es-improve-s3-state-"))
  await signEngineFile(path.join(root, ".factory/runtime/state.json"), stateDir)
  return {
    root,
    stateDir,
    async cleanup() {
      await rm(root, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}

describe("S3.1 scrubSecrets redacts secret values, not just keys", () => {
  test("NAME=value, NAME: value, Bearer tokens, token shapes and PEM blocks", () => {
    const scrubbed = scrubSecrets({
      halt: { reason: "halt.reason: GITHUB_TOKEN=ghp_abc123def456789", from: "QA" },
      colon: "api-key: hunter2",
      bearer: "Bearer eyJhbGciOiJIUzI1NiJ9",
      authHeader: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9",
      bare: "leaked token ghp_zzz999qqq000 in prose",
      aws: "key AKIAIOSFODNN7EXAMPLE here",
      openai: "sk-abcDEF1234567890",
      anthropic: "sk-ant-abcDEF1234567890",
      slack: "xoxb-12345-abcdef",
      githubPat: "github_pat_abcDEF_123",
      pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      gateStderr: "$ lint\nsrc/x.ts:3 GITHUB_TOKEN=ghp_stderr999",
      auditPayload: "detail sk-ant-payload0000 rejected",
      plain: "phase p1 failed 5 times",
    })
    const text = JSON.stringify(scrubbed)
    for (const secret of [
      "ghp_abc123def456789",
      "hunter2",
      "eyJhbGciOiJIUzI1NiJ9",
      "ghp_zzz999qqq000",
      "AKIAIOSFODNN7EXAMPLE",
      "sk-abcDEF1234567890",
      "sk-ant-abcDEF1234567890",
      "xoxb-12345-abcdef",
      "github_pat_abcDEF_123",
      "MIIEowIBAAKCAQEA",
      "ghp_stderr999",
      "sk-ant-payload0000",
    ])
      expect(text).not.toContain(secret)
    // Shape is preserved: names stay, only values become [redacted].
    expect(scrubbed.halt.reason).toContain("GITHUB_TOKEN=")
    expect(scrubbed.colon).toContain("api-key:")
    expect(scrubbed.bearer).toContain("Bearer")
    expect(scrubbed.plain).toBe("phase p1 failed 5 times")
  })

  test("a halt reason carrying NAME=value harvests scrubbed and schema-valid", async () => {
    const sealed = await sealedCopy("run-replan", (state) => {
      ;(state.halt as Record<string, unknown>).reason = "phase p1 failed: GITHUB_TOKEN=ghp_harvestSecret001"
    })
    try {
      const telemetry = await harvestTelemetry({ runs: [sealed.root], evals: [] }, { stateDir: sealed.stateDir })
      const text = JSON.stringify(telemetry)
      expect(text).not.toContain("ghp_harvestSecret001")
      expect(text).toContain("GITHUB_TOKEN=")
      expect(TelemetrySchema.parse(telemetry)).toEqual(telemetry)
    } finally {
      await sealed.cleanup()
    }
  })
})

describe("S3.2 unsealed run state is reported, never trusted", () => {
  test("a missing seal yields a finding and no metrics from that run", async () => {
    const root = await fixtureCopy("run-replan")
    try {
      const stateDir = await mkdtemp(path.join(tmpdir(), "es-improve-s3-state-"))
      try {
        const run = await harvestRun(root, { stateDir })
        expect(run).toMatchObject({ seal: { valid: false } })
        expect(typeof run.seal.error).toBe("string")
        expect(run.phases).toEqual([])
        expect(run.spend).toEqual({ usd: 0, estimated: false, events: 0 })
        expect(run.halt).toBeUndefined()
        expect(run.mode).toBe("unknown")
      } finally {
        await rm(stateDir, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a forged seal (signed under another key) yields a finding and no metrics", async () => {
    const sealed = await sealedCopy("run-replan")
    try {
      const elsewhere = await mkdtemp(path.join(tmpdir(), "es-improve-s3-state-"))
      try {
        const run = await harvestRun(sealed.root, { stateDir: elsewhere })
        expect(run).toMatchObject({ seal: { valid: false } })
        expect(typeof run.seal.error).toBe("string")
        expect(run.phases).toEqual([])
        expect(run.spend).toEqual({ usd: 0, estimated: false, events: 0 })
      } finally {
        await rm(elsewhere, { recursive: true, force: true })
      }
    } finally {
      await sealed.cleanup()
    }
  })

  test("a sealed run trusts its state and reports a valid seal", async () => {
    const sealed = await sealedCopy("run-clean")
    try {
      const run = await harvestRun(sealed.root, { stateDir: sealed.stateDir })
      expect(run.seal).toEqual({ valid: true })
      expect(run.phases.length).toBe(1)
    } finally {
      await sealed.cleanup()
    }
  })
})

describe("S3.4 per-phase attempts, replans and failure entries", () => {
  test("the replan fixture yields deterministic failure entries", async () => {
    const sealed = await sealedCopy("run-replan")
    try {
      const run = await harvestRun(sealed.root, { stateDir: sealed.stateDir })
      expect(run.phases).toEqual([
        {
          id: "p1",
          status: "failed",
          attempts: 6,
          replans: 1,
          failures: [
            { seat: "qa", kind: "qa", reason: "lint gate red" },
            { seat: "manager", kind: "replan", reason: "replan attempt 4" },
            { kind: "gate", rule: "lint/no-unused-vars", reason: "unused (src/x.ts:3)" },
            { kind: "gate", rule: "lint/no-unused-vars", reason: "unused (src/y.ts:9)" },
            {
              seat: "auditor-thesis",
              kind: "audit",
              category: "invariant/high",
              reason: "the programmer seat can write a control file path",
            },
          ],
        },
      ])
    } finally {
      await sealed.cleanup()
    }
  })
})
