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
  auditChain: { entries: 1, valid: true },
  ...extra,
})

/** Two runs whose shared signals clear the default thresholds (3 occurrences, 2 runs). */
const richTelemetry = (): Telemetry => ({
  version: 1,
  harvestedAt: "2026-10-03T00:00:00.000Z",
  runs: [
    runTelemetry("run-a", {
      gateRejections: [{ rule: "lint/no-unused-vars", count: 2 }],
      auditFindings: [{ kind: "invariant", severity: "high", count: 2 }],
    }),
    runTelemetry("run-b", {
      gateRejections: [{ rule: "lint/no-unused-vars", count: 1 }],
      auditFindings: [{ kind: "invariant", severity: "high", count: 1 }],
    }),
  ],
  evals: [
    { case: "case-x", pass: false, failures: ["gate lint red", "gate lint red"], steps: 9 },
    { case: "case-y", pass: false, failures: ["gate lint red"], steps: 4 },
    { case: "case-ok", pass: true, failures: [], steps: 3 },
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
  test("deterministic clusters keyed by kind and label", async () => {
    const telemetry = richTelemetry()
    const first = clusterTelemetry(telemetry)
    expect(first.map((cluster) => [cluster.key, cluster.occurrences, cluster.runIds])).toEqual([
      ["audit:invariant/high", 3, ["run-a", "run-b"]],
      ["eval:gate lint red", 3, ["eval/case-x", "eval/case-y"]],
      ["gate:lint/no-unused-vars", 3, ["run-a", "run-b"]],
    ])
    expect(clusterTelemetry(telemetry)).toEqual(first)
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
    telemetry.runs = [runTelemetry("only", { gateRejections: [{ rule: "lint/no-unused-vars", count: 1 }] })]
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
    telemetry.evals = [{ case: "case-x", pass: false, failures: ["gate lint red"], steps: 1, model: "acme/llama-8b" }]
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
    expect(proposals.length).toBe(3)
    expect(undisposed(proposals, telemetry)).toEqual(proposals)
  })
})

describe("es improve distill is agent-safe (except human-run --open-pr)", () => {
  test("the policy does not treat distill as human-only", () => {
    expect(invokesHumanOnly("es improve distill --telemetry t.json --out proposals")).toBe(false)
  })
})
