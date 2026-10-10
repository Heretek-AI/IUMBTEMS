// Distillation of telemetry into reviewable proposals (#136): deterministic
// clustering, thresholds, all three proposal kinds, and the "code disposes"
// gate that bans hallucinated model numerals and non-verbatim evidence.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AGENTS,
  clusterTelemetry,
  DomainPackSchema,
  disposeReason,
  distillProposals,
  harvestTelemetry,
  invokesHumanOnly,
  loadPrompt,
  type Proposal,
  type RunTelemetry,
  type Telemetry,
  undisposed,
  writeProposals,
} from "../src/index.ts"

const fixtures = path.join(import.meta.dir, "fixtures/improve")
const repoRoot = path.join(import.meta.dir, "..", "..", "..")

const runTelemetry = (id: string, extra: Partial<RunTelemetry> = {}): RunTelemetry => ({
  id,
  mode: "build",
  stage: "HALTED",
  spend: { usd: 1, estimated: false, events: 5 },
  phases: [],
  gateRejections: [],
  auditFindings: [],
  auditChain: { entries: 1, valid: true, trail: [] },
  seal: { valid: true },
  ...extra,
})

/** Two runs whose shared signals clear the default thresholds (3 occurrences, 2 runs). */
const richTelemetry = (): Telemetry => ({
  version: 2,
  harvestedAt: "2026-10-03T00:00:00.000Z",
  runs: [
    runTelemetry("run-a", {
      gateRejections: [{ rule: "lint/no-unused-vars", count: 2, logs: [".factory/runs/run-a/gates/s1/summary.json"] }],
      auditFindings: [{ kind: "invariant", severity: "high", count: 2, sources: [".factory/audits/a1/records.json"] }],
    }),
    runTelemetry("run-b", {
      gateRejections: [{ rule: "lint/no-unused-vars", count: 1, logs: [".factory/runs/run-b/gates/s1/summary.json"] }],
      auditFindings: [{ kind: "invariant", severity: "high", count: 1, sources: [".factory/audits/a1/records.json"] }],
    }),
  ],
  evals: [
    { case: "case-x", pass: false, failures: ["gate lint red", "gate lint red"], steps: 9, source: "agg.json" },
    { case: "case-y", pass: false, failures: ["gate lint red"], steps: 4, source: "agg.json" },
    { case: "case-ok", pass: true, failures: [], steps: 3, source: "agg.json" },
  ],
})

const git = async (args: string[], cwd: string) => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe("clusterTelemetry", () => {
  test("deterministic clusters keyed by (seat, kind, facet)", async () => {
    const telemetry = richTelemetry()
    const first = clusterTelemetry(telemetry)
    expect(first.map((cluster) => [cluster.key, cluster.occurrences, cluster.runIds])).toEqual([
      ["audit:invariant/high", 3, ["run-a", "run-b"]],
      ["eval:gate lint red", 3, ["eval/case-x", "eval/case-y"]],
      ["gate:lint/no-unused-vars", 3, ["run-a", "run-b"]],
    ])
    expect(clusterTelemetry(telemetry)).toEqual(first)
    // Evidence links to gate-log paths, audit records and eval files.
    const byKey = new Map(first.map((cluster) => [cluster.key, cluster]))
    expect(byKey.get("gate:lint/no-unused-vars")!.evidence).toEqual([
      "run run-a gate-log .factory/runs/run-a/gates/s1/summary.json: lint/no-unused-vars",
      "run run-b gate-log .factory/runs/run-b/gates/s1/summary.json: lint/no-unused-vars",
    ])
    expect(byKey.get("audit:invariant/high")!.evidence).toEqual([
      "run run-a audit .factory/audits/a1/records.json: invariant/high",
      "run run-b audit .factory/audits/a1/records.json: invariant/high",
    ])
    expect(byKey.get("eval:gate lint red")!.evidence).toEqual([
      "eval case-x (agg.json): gate lint red",
      "eval case-y (agg.json): gate lint red",
    ])
  })

  test("thresholds filter: defaults need 3 occurrences across 2 runs", async () => {
    const telemetry = richTelemetry()
    expect(clusterTelemetry(telemetry, { minOccurrences: 4 })).toEqual([])
    expect(clusterTelemetry(telemetry, { minRuns: 3 })).toEqual([])
    expect(clusterTelemetry(telemetry, { minOccurrences: 3, minRuns: 2 })).toHaveLength(3)
  })

  test("the #135 fixtures clear nothing by default (single occurrences stay silent)", async () => {
    const telemetry = await harvestTelemetry({
      runs: [path.join(fixtures, "run-clean"), path.join(fixtures, "run-replan")],
      evals: [path.join(fixtures, "evals")],
    })
    expect(clusterTelemetry(telemetry)).toEqual([])
    expect(clusterTelemetry(telemetry, { minOccurrences: 1, minRuns: 1 }).length).toBeGreaterThan(0)
  })

  test("one lone occurrence never proposes", async () => {
    const telemetry = richTelemetry()
    telemetry.runs = [runTelemetry("only", { gateRejections: [{ rule: "lint/no-unused-vars", count: 1, logs: [] }] })]
    telemetry.evals = []
    expect(clusterTelemetry(telemetry)).toEqual([])
  })
})

describe("distillProposals", () => {
  test("all three kinds, deterministic and evidence-linked", async () => {
    const telemetry = richTelemetry()
    const first = await distillProposals(telemetry)
    expect(first.map((proposal) => proposal.kind).sort()).toEqual(["domain-pack", "gate-tuning", "prompt-guidance"])
    expect(await distillProposals(telemetry)).toEqual(first)
    for (const proposal of first) {
      expect(proposal.cluster.evidence.length).toBeGreaterThan(0)
      expect(proposal.rationale).toContain(proposal.cluster.label)
    }
  })

  test("the gate-tuning proposal explains only: no control-file change", async () => {
    const [proposal] = (await distillProposals(richTelemetry())).filter((item) => item.kind === "gate-tuning")
    expect(proposal!.files).toEqual(["gates.md"])
    expect(proposal!.files).not.toContain("gates.json")
    const dir = await mkdtemp(path.join(tmpdir(), "es-distill-"))
    try {
      const rendered = new Map([[proposal!.id, { "gates.md": "explanation" }]])
      const [written] = await writeProposals(dir, [proposal!], rendered)
      expect(written!.dir).toBe(path.join(dir, proposal!.id))
      expect(await readFile(path.join(written!.dir, "gates.md"), "utf8")).toBe("explanation")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the domain-pack proposal validates against DomainPackSchema", async () => {
    const [proposal] = (await distillProposals(richTelemetry())).filter((item) => item.kind === "domain-pack")
    const dir = await mkdtemp(path.join(tmpdir(), "es-distill-"))
    try {
      const rendered = new Map([[proposal!.id, { "pack.json": "{}", "rationale.md": "r" }]])
      const [written] = await writeProposals(dir, [proposal!], rendered)
      expect(written!.dir).toStartWith(dir)
      // The real pack payload (not the stub above) parses as a domain pack.
      const { files } = await import("../src/improve/distill.ts").then((mod) =>
        mod.renderProposalFiles(proposal!.cluster),
      )
      expect(DomainPackSchema.parse(JSON.parse(files["pack.json"]!)).packId).toStartWith("distilled-")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the prompt patch applies cleanly with its version bump, keeping asset checks green", async () => {
    const [proposal] = (await distillProposals(richTelemetry())).filter((item) => item.kind === "prompt-guidance")
    const { files } = await import("../src/improve/distill.ts").then((mod) =>
      mod.renderProposalFiles(proposal!.cluster),
    )
    const patch = files["prompt.patch"]!
    expect(patch).toContain("+++ b/packages/core/assets/prompts/auditor-thesis.md")
    const asset = await loadPrompt("auditor-thesis")
    expect(patch).toContain(`-version: ${asset.meta.version}`)
    expect(patch).toContain(`+version: ${asset.meta.version + 1}`)
    // `git apply --check` reads the asset but writes nothing: clean apply.
    const dir = await mkdtemp(path.join(tmpdir(), "es-patch-"))
    const patchFile = path.join(dir, "proposal.patch")
    await writeFile(patchFile, patch)
    try {
      const checked = await git(["apply", "--check", patchFile], repoRoot)
      expect(`${checked.code} ${checked.stderr}`).toBe("0 ")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    // The patched body keeps every tool the seat may call (the assets.test.ts rule).
    const agent = AGENTS.find((item) => item.seat === "auditor-thesis")!
    const pitfall = patch
      .split("\n")
      .find((line) => line.startsWith("+Known pitfall"))!
      .slice(1)
    const body = `${asset.body}\n${pitfall}`
    expect(body.length).toBeGreaterThan(300)
    for (const tool of agent.tools.filter((name) => name !== "es_status" && name !== "es_gates_run"))
      expect(body.includes(tool)).toBe(true)
  })

  test("nothing is applied automatically: the repo tree is untouched", async () => {
    const before = await readFile(path.join(repoRoot, "packages/core/assets/prompts/auditor-thesis.md"), "utf8")
    const dir = await mkdtemp(path.join(tmpdir(), "es-distill-"))
    try {
      const proposals = await distillProposals(richTelemetry())
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
      await writeProposals(dir, proposals, rendered)
      expect(await readFile(path.join(repoRoot, "packages/core/assets/prompts/auditor-thesis.md"), "utf8")).toBe(before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("the code-disposes gate", () => {
  test("hallucinated model numerals dispose the proposal", async () => {
    const [proposal] = await distillProposals(richTelemetry())
    const tainted = { ...proposal!, rationale: `${proposal!.rationale} As gpt-4-turbo would suggest.` }
    const reasons = disposeReason(tainted, richTelemetry())
    expect(reasons.some((reason) => reason.includes("hallucinated model numeral"))).toBe(true)
    expect(undisposed([tainted], richTelemetry())).toEqual([])
  })

  test("a model the telemetry records is allowed; utf-8/sha-256 are not numerals", async () => {
    const telemetry = richTelemetry()
    telemetry.evals = [
      {
        case: "case-x",
        pass: false,
        failures: ["gate lint red"],
        steps: 1,
        model: "acme/llama-8b",
        source: "agg.json",
      },
    ]
    const [proposal] = await distillProposals(telemetry, { minOccurrences: 1, minRuns: 1 })
    const ok = {
      ...proposal!,
      rationale: `${proposal!.rationale} Observed on acme/llama-8b (utf-8 logs, sha-256 pinned).`,
    }
    expect(disposeReason(ok, telemetry)).toEqual([])
  })

  test("non-verbatim evidence disposes the proposal", async () => {
    const [proposal] = await distillProposals(richTelemetry())
    const forged = { ...proposal!, cluster: { ...proposal!.cluster, evidence: ["run x: invented quote"] } }
    expect(disposeReason(forged, richTelemetry()).some((reason) => reason.includes("verbatim"))).toBe(true)
  })

  test("distilled proposals stand undisposed", async () => {
    const telemetry = richTelemetry()
    const proposals = await distillProposals(telemetry)
    expect(proposals).toHaveLength(3)
    expect(undisposed(proposals, telemetry)).toEqual(proposals)
  })
})

describe("es improve distill is agent-safe (except human-run --open-pr)", () => {
  test("the policy does not treat distill as human-only", () => {
    expect(invokesHumanOnly("es improve distill --telemetry t.json --out proposals")).toBe(false)
  })
})

// ---------------------------------------------------------------- S3.5
//
// Repair-151 failing witnesses: cluster keys on (seat, kind, rule/category)
// with no defaulted seat, evidence linked to chain hashes and gate-log
// paths, and disposed proposals reported with reasons (byte-identical rerun).

/** A v2 telemetry pair whose phase failures carry seats (S3.4 data). */
const seatedTelemetry = (): Telemetry => ({
  version: 2,
  harvestedAt: "2026-10-03T00:00:00.000Z",
  runs: [
    {
      id: "run-a",
      mode: "build",
      stage: "HALTED",
      spend: { usd: 1, estimated: false, events: 5 },
      phases: [
        {
          id: "p1",
          status: "failed",
          attempts: 3,
          replans: 0,
          failures: [
            { seat: "qa", kind: "qa", reason: "lint gate red" },
            { kind: "gate", rule: "lint/no-unused-vars", reason: "unused (src/x.ts:3)" },
          ],
        },
      ],
      gateRejections: [{ rule: "lint/no-unused-vars", count: 1, logs: [".factory/runs/run-a/gates/s1/summary.json"] }],
      auditFindings: [],
      auditChain: {
        entries: 2,
        valid: true,
        trail: [{ seq: 1, hash: "a".repeat(64), action: "qa.fail", phase: "p1", reason: "lint gate red" }],
      },
      seal: { valid: true },
    },
    {
      id: "run-b",
      mode: "build",
      stage: "HALTED",
      spend: { usd: 1, estimated: false, events: 5 },
      phases: [
        {
          id: "p1",
          status: "failed",
          attempts: 2,
          replans: 0,
          failures: [
            { seat: "qa", kind: "qa", reason: "lint gate red" },
            { kind: "gate", rule: "lint/no-unused-vars", reason: "unused (src/y.ts:9)" },
          ],
        },
      ],
      gateRejections: [{ rule: "lint/no-unused-vars", count: 1, logs: [".factory/runs/run-b/gates/s1/summary.json"] }],
      auditFindings: [],
      auditChain: {
        entries: 2,
        valid: true,
        trail: [{ seq: 1, hash: "b".repeat(64), action: "qa.fail", phase: "p1", reason: "lint gate red" }],
      },
      seal: { valid: true },
    },
  ],
  evals: [],
})

describe("S3.5 cluster key and evidence", () => {
  test("keys cluster on (seat, kind, rule/category) with no defaulted seat", async () => {
    const clusters = clusterTelemetry(seatedTelemetry(), { minOccurrences: 2, minRuns: 2 })
    expect(clusters.map((cluster) => [cluster.key, cluster.occurrences, cluster.runIds])).toEqual([
      ["gate:lint/no-unused-vars", 2, ["run-a", "run-b"]],
      ["qa:qa:lint gate red", 2, ["run-a", "run-b"]],
    ])
    // The seatless gate cluster never claims a seat; the qa cluster keeps its own.
    expect(clusters[0]!.seat).toBeUndefined()
    expect(clusters[1]!.seat).toBe("qa")
  })

  test("evidence links to audit-chain hashes and gate-log paths", async () => {
    const clusters = clusterTelemetry(seatedTelemetry(), { minOccurrences: 2, minRuns: 2 })
    const gate = clusters.find((cluster) => cluster.kind === "gate")!
    expect(gate.evidence).toEqual([
      "run run-a gate-log .factory/runs/run-a/gates/s1/summary.json: lint/no-unused-vars",
      "run run-b gate-log .factory/runs/run-b/gates/s1/summary.json: lint/no-unused-vars",
    ])
    const qa = clusters.find((cluster) => cluster.kind === "qa")!
    expect(qa.evidence).toEqual([
      `run run-a audit-chain #1 ${"a".repeat(64)}: qa.fail p1 lint gate red`,
      `run run-b audit-chain #1 ${"b".repeat(64)}: qa.fail p1 lint gate red`,
    ])
  })

  test("a dropped proposal is reported with its reason; a rerun is byte-identical", async () => {
    const mod = (await import("../src/improve/distill.ts")) as Record<string, unknown>
    expect(typeof mod.disposedWithReasons).toBe("function")
    expect(typeof mod.writeDropped).toBe("function")
    const disposedWithReasons = mod.disposedWithReasons as (
      proposals: Proposal[],
      telemetry: Telemetry,
    ) => Array<{ proposal: Proposal; reasons: string[] }>
    const writeDropped = mod.writeDropped as (
      out: string,
      dropped: Array<{ proposal: Proposal; reasons: string[] }>,
    ) => Promise<string>
    const telemetry: Telemetry = {
      version: 2,
      harvestedAt: "2026-10-03T00:00:00.000Z",
      runs: [],
      evals: [
        {
          case: "case-x",
          pass: false,
          failures: ["fails like gpt-4 would", "fails like gpt-4 would"],
          steps: 9,
          source: "agg.json",
        },
        { case: "case-y", pass: false, failures: ["fails like gpt-4 would"], steps: 4, source: "agg.json" },
      ],
    }
    const proposals = await distillProposals(telemetry, { minOccurrences: 3, minRuns: 2 })
    expect(proposals).toHaveLength(1)
    expect(undisposed(proposals, telemetry)).toEqual([])
    const dropped = disposedWithReasons(proposals, telemetry)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.reasons.some((reason) => reason.includes("hallucinated model numeral"))).toBe(true)
    const first = await mkdtemp(path.join(tmpdir(), "es-dropped-a-"))
    const second = await mkdtemp(path.join(tmpdir(), "es-dropped-b-"))
    try {
      const a = await writeDropped(first, dropped)
      const before = await readFile(a, "utf8")
      expect(before).toContain("hallucinated model numeral")
      const b = await writeDropped(second, dropped)
      expect(await readFile(b, "utf8")).toBe(before)
      // A rerun into the same dir is byte-identical too.
      await writeDropped(first, dropped)
      expect(await readFile(a, "utf8")).toBe(before)
    } finally {
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  })
})
