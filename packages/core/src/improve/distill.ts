// Deterministic distillation of telemetry into reviewable proposals (#136).
// Clustering keys on (kind, label): the same gate rule, audit category or
// eval failure across runs. Each surviving cluster becomes exactly one
// proposal — prompt guidance (a version-bumped patch), gate tuning (an
// explanation only: gates.json is a control file a human applies with
// rebaseline) or a domain-pack candidate (validated against
// DomainPackSchema). Proposals are only written under the output dir; nothing
// is ever applied automatically.
//
// The "code disposes" gate (clean-room): a proposal is disposed unless every
// evidence quote appears verbatim in the source telemetry and every model
// numeral it names is a model the telemetry actually records. Hallucinated
// counts and model names cannot become reviewable proposals.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { loadPrompt } from "../agents/assets.ts"
import { DomainPackSchema } from "../schema/domain.ts"
import {
  type Cluster,
  type ClusterKind,
  type EvalTelemetry,
  type Proposal,
  type ProposalKind,
  ProposalSchema,
  type RunTelemetry,
  type Telemetry,
} from "../schema/improve.ts"
import { compareStrings } from "../util/compare.ts"
import { shortHash } from "../util/hash.ts"

export interface DistillThresholds {
  /** Minimum total occurrences of one key (default 3). */
  readonly minOccurrences?: number
  /** Minimum distinct runs carrying the key (default 2). */
  readonly minRuns?: number
}

export const DEFAULT_THRESHOLDS = { minOccurrences: 3, minRuns: 2 } as const

interface Signal {
  readonly kind: ClusterKind
  readonly label: string
  readonly runId: string
  readonly evidence: string
}

/** One signal per counted occurrence (a count-2 rejection is two signals). */
function repeat(count: number, signal: Signal): Signal[] {
  const out: Signal[] = []
  for (let i = 0; i < count; i++) out.push(signal)
  return out
}

function runSignals(run: RunTelemetry): Signal[] {
  const out: Signal[] = []
  for (const rejection of run.gateRejections)
    out.push(
      ...repeat(rejection.count, {
        kind: "gate",
        label: rejection.rule,
        runId: run.id,
        evidence: `run ${run.id}: gate rejection ${rejection.rule}`,
      }),
    )
  for (const finding of run.auditFindings)
    out.push(
      ...repeat(finding.count, {
        kind: "audit",
        label: `${finding.kind}/${finding.severity}`,
        runId: run.id,
        evidence: `run ${run.id}: audit finding ${finding.kind}/${finding.severity}`,
      }),
    )
  if (run.halt)
    out.push({
      kind: "eval",
      label: `halt/${run.halt.from}`,
      runId: run.id,
      evidence: `run ${run.id}: halt from ${run.halt.from}: ${run.halt.reason}`,
    })
  return out
}

function evalSignals(evalCase: EvalTelemetry): Signal[] {
  if (evalCase.pass) return []
  const failures = evalCase.failures.length > 0 ? evalCase.failures : ["failed"]
  return failures.map((failure) => ({
    kind: "eval" as const,
    // Key on the failure text itself: the same reason across cases is
    // one cluster; the case stays in the evidence and the run id.
    label: failure,
    runId: `eval/${evalCase.case}`,
    evidence: `eval ${evalCase.case}: ${failure}`,
  }))
}

function signals(telemetry: Telemetry): Signal[] {
  const out: Signal[] = []
  for (const run of telemetry.runs) out.push(...runSignals(run))
  for (const evalCase of telemetry.evals) out.push(...evalSignals(evalCase))
  return out
}

/**
 * Every verbatim evidence string the telemetry yields (the harvester's own
 * signal phrases, sorted). The "code disposes" gate checks proposal quotes
 * against exactly this set: a quote counts as verbatim only when the
 * harvester said it.
 */
export function signalEvidence(telemetry: Telemetry): string[] {
  const evidence = [...new Set(signals(telemetry).map((signal) => signal.evidence))]
  evidence.sort(compareStrings)
  return evidence
}

interface ClusterGroup {
  kind: ClusterKind
  label: string
  runIds: Set<string>
  evidence: string[]
}

const toCluster = (key: string, group: ClusterGroup): Cluster => {
  const runIds = [...group.runIds]
  runIds.sort(compareStrings)
  const evidence = [...new Set(group.evidence)]
  evidence.sort(compareStrings)
  return { key, kind: group.kind, label: group.label, occurrences: group.evidence.length, runIds, evidence }
}

/**
 * Deterministic clustering: group signals by (kind, label), count
 * occurrences, collect distinct run ids and verbatim evidence. Sorted by key.
 */
export function clusterTelemetry(telemetry: Telemetry, thresholds: DistillThresholds = {}): Cluster[] {
  const minOccurrences = thresholds.minOccurrences ?? DEFAULT_THRESHOLDS.minOccurrences
  const minRuns = thresholds.minRuns ?? DEFAULT_THRESHOLDS.minRuns
  const groups = new Map<string, ClusterGroup>()
  for (const signal of signals(telemetry)) {
    const key = `${signal.kind}:${signal.label}`
    let group = groups.get(key)
    if (!group) {
      group = { kind: signal.kind, label: signal.label, runIds: new Set(), evidence: [] }
      groups.set(key, group)
    }
    group.runIds.add(signal.runId)
    group.evidence.push(signal.evidence)
  }
  const entries = [...groups.entries()]
  entries.sort(([a], [b]) => compareStrings(a, b))
  const clusters: Cluster[] = []
  for (const [key, group] of entries) {
    if (group.evidence.length < minOccurrences) continue
    if (group.runIds.size < minRuns) continue
    clusters.push(toCluster(key, group))
  }
  return clusters
}

const KIND_FOR_CLUSTER: Record<ClusterKind, ProposalKind> = {
  gate: "gate-tuning",
  audit: "prompt-guidance",
  eval: "domain-pack",
}

const slug = (text: string): string => {
  const dashed = text.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  let start = 0
  while (dashed[start] === "-") start += 1
  let end = dashed.length
  while (end > start && dashed[end - 1] === "-") end -= 1
  return dashed.slice(start, end).slice(0, 48) || "proposal"
}

/** Stable proposal id from the cluster key (deterministic across runs). */
export const proposalId = (kind: ProposalKind, cluster: Pick<Cluster, "key">): string =>
  `${kind}-${slug(cluster.key)}-${shortHash(cluster.key)}`

const seatForAudit = (label: string): string => {
  if (label.startsWith("invariant/")) return "auditor-thesis"
  return "programmer"
}

const promptFor = (promptId: string): string => `packages/core/assets/prompts/${promptId}.md`

const evidenceSection = (evidence: readonly string[]): string =>
  ["## Evidence", ...evidence.map((quote) => `- ${quote}`), ``].join("\n")

interface RenderedProposal {
  readonly kind: ProposalKind
  readonly id: string
  readonly rationale: string
  readonly files: Record<string, string>
}

function renderGateTuning(cluster: Cluster): RenderedProposal {
  const kind = "gate-tuning" as const
  const rationale =
    `Gate rule "${cluster.label}" rejected ${cluster.occurrences} time(s) across ${cluster.runIds.length} run(s) ` +
    `(${cluster.runIds.join(", ")}). This proposal only explains the pattern: gates.json is a factory control ` +
    `file, so a human applies any tuning with \`es rebaseline\`. Nothing here changes a gate on its own.`
  return {
    kind,
    id: proposalId(kind, cluster),
    rationale,
    files: {
      "gates.md": [
        `# Gate-tuning proposal: ${cluster.label}`,
        ``,
        rationale,
        ``,
        evidenceSection(cluster.evidence),
        `## Suggested direction (human applies with \`es rebaseline\`)`,
        ``,
        `Consider whether rule "${cluster.label}" needs a waiver scope, a fix in the seats' guidance, or a ` +
          `tighter check. Do not apply this file mechanically: review the evidence first.`,
        ``,
      ].join("\n"),
    },
  }
}

/** A unified-diff hunk replacing one line with context on both sides. */
function replaceHunk(lines: readonly string[], index: number, oldLine: string, newLine: string): string[] {
  const before = lines.slice(Math.max(0, index - 2), index)
  const after = lines.slice(index + 1, index + 3)
  const start = index - before.length + 1
  const count = before.length + 1 + after.length
  return [
    `@@ -${start},${count} +${start},${count} @@`,
    ...before.map((line) => ` ${line}`),
    `-${oldLine}`,
    `+${newLine}`,
    ...after.map((line) => ` ${line}`),
  ]
}

/** A unified-diff hunk appending one line at the end of the file. */
function appendHunk(lines: readonly string[], newLine: string): string[] {
  const tail = lines.slice(-3)
  const start = lines.length - tail.length + 1
  return [
    `@@ -${start},${tail.length} +${start},${tail.length + 1} @@`,
    ...tail.map((line) => ` ${line}`),
    `+${newLine}`,
  ]
}

async function renderPromptGuidance(cluster: Cluster): Promise<RenderedProposal> {
  const kind = "prompt-guidance" as const
  const promptId = seatForAudit(cluster.label)
  const asset = await loadPrompt(promptId)
  const next = asset.meta.version + 1
  const pitfall = `Known pitfall (distilled from ${cluster.occurrences} occurrence(s) of ${cluster.label}): re-read the evidence above before recording a verdict.`
  const source = await readFile(promptFor(promptId), "utf8").catch(() => undefined)
  const lines = (source ?? `${asset.body}\n`).replace(/\n$/, "").split("\n")
  const versionLine = lines.findIndex((line) => /^version:\s*\d+\s*$/.test(line))
  const hunks: string[] = []
  if (versionLine > 0)
    hunks.push(...replaceHunk(lines, versionLine, `version: ${asset.meta.version}`, `version: ${next}`))
  hunks.push(...appendHunk(lines, pitfall))
  const rationale =
    `Audit signal "${cluster.label}" recurred ${cluster.occurrences} time(s) across ${cluster.runIds.length} run(s). ` +
    `This patch adds one known-pitfall line to the ${promptId} prompt and bumps its frontmatter to v${next}, ` +
    `so the assets drift check stays green when a human applies it. Review the evidence before applying.`
  return {
    kind,
    id: proposalId(kind, cluster),
    rationale,
    files: {
      "prompt.patch": [`--- a/${promptFor(promptId)}`, `+++ b/${promptFor(promptId)}`, ...hunks, ``].join("\n"),
      "rationale.md": [
        `# Prompt-guidance proposal: ${promptId}`,
        ``,
        rationale,
        ``,
        evidenceSection(cluster.evidence),
      ].join("\n"),
    },
  }
}

function renderDomainPack(cluster: Cluster): RenderedProposal {
  const kind = "domain-pack" as const
  const pack = DomainPackSchema.parse({
    packId: `distilled-${slug(cluster.label)}`.slice(0, 48),
    description:
      `Distilled from ${cluster.occurrences} occurrence(s) of ${cluster.label} across ` +
      `${cluster.runIds.join(", ")}: research touching this failure domain must cite primary evidence. ` +
      `Human-reviewed proposal; not applied.`,
    tierWeights: { __default__: 1 },
    mandatoryTags: ["VERIFIED"],
  })
  const rationale =
    `Failure signal "${cluster.label}" recurred ${cluster.occurrences} time(s) across ${cluster.runIds.length} run(s). ` +
    `This candidate domain pack (${pack.packId}) would require VERIFIED evidence on claims in this domain. ` +
    `It is schema-valid but unreviewed: a human adopts it by adding it to assets/domain-packs/.`
  return {
    kind,
    id: proposalId(kind, cluster),
    rationale,
    files: {
      "pack.json": `${JSON.stringify(pack, null, 2)}\n`,
      "rationale.md": [
        `# Domain-pack proposal: ${pack.packId}`,
        ``,
        rationale,
        ``,
        evidenceSection(cluster.evidence),
      ].join("\n"),
    },
  }
}

/**
 * Render one proposal's files (but write nothing): proposal.json metadata is
 * assembled by `writeProposals`. Prompt patches are unified diffs against the
 * seat's prompt asset: a version-bump hunk plus a known-pitfall insertion.
 */
export async function renderProposalFiles(cluster: Cluster): Promise<RenderedProposal> {
  const kind = KIND_FOR_CLUSTER[cluster.kind]
  if (kind === "gate-tuning") return renderGateTuning(cluster)
  if (kind === "prompt-guidance") return renderPromptGuidance(cluster)
  return renderDomainPack(cluster)
}

/** Distill every surviving cluster into a validated proposal (deterministic order). */
export async function distillProposals(telemetry: Telemetry, thresholds: DistillThresholds = {}): Promise<Proposal[]> {
  const clusters = clusterTelemetry(telemetry, thresholds)
  const rendered = await Promise.all(clusters.map((cluster) => renderProposalFiles(cluster)))
  const out = rendered.map((item, index) => {
    const files = Object.keys(item.files)
    files.sort(compareStrings)
    return ProposalSchema.parse({
      id: item.id,
      kind: item.kind,
      cluster: clusters[index],
      rationale: item.rationale,
      files,
    })
  })
  out.sort((a, b) => compareStrings(a.id, b.id))
  return out
}

// ------------------------------------------------- the "code disposes" gate

/**
 * Model-numeral candidates: a known model family name with a version number
 * (`gpt-4`, `llama-8b`). The vendor list keeps the pattern linear; anything
 * else never reads as a model claim.
 */
const MODEL_NUMERAL = /\b(?:gpt|claude|gemini|llama|mistral|qwen)[-_. ]?\d[\w.]*\b/gi

const KNOWN_NON_MODELS = new Set(["utf-8", "utf8", "sha-256", "sha256", "base-64", "base64", "v1", "v2"])

/** Model strings the telemetry actually records (eval models). */
export function telemetryModels(telemetry: Telemetry): Set<string> {
  const models = new Set<string>()
  for (const evalCase of telemetry.evals) {
    if (evalCase.model) models.add(evalCase.model.toLowerCase())
  }
  return models
}

const numeralAllowed = (numeral: string, allowed: ReadonlySet<string>): boolean => {
  if (KNOWN_NON_MODELS.has(numeral)) return true
  for (const model of allowed) {
    if (model.includes(numeral)) return true
    if (numeral.includes(model)) return true
  }
  return false
}

/**
 * Why this proposal is disposed (undefined when it stands): an evidence
 * quote must appear verbatim in the source telemetry, and a model numeral
 * must be a model the telemetry records. Returns every reason, sorted.
 */
export function disposeReason(proposal: Proposal, telemetry: Telemetry): string[] {
  const verbatim = new Set(signalEvidence(telemetry))
  const reasons: string[] = []
  for (const quote of proposal.cluster.evidence) {
    if (!verbatim.has(quote)) reasons.push(`evidence is not a verbatim quote: ${quote.slice(0, 80)}`)
  }
  const allowed = telemetryModels(telemetry)
  const text = `${proposal.rationale} ${proposal.cluster.label}`
  const matches = new Set(text.match(MODEL_NUMERAL) ?? [])
  for (const match of matches) {
    const numeral = match.toLowerCase()
    if (!numeralAllowed(numeral, allowed)) reasons.push(`hallucinated model numeral: ${match}`)
  }
  reasons.sort(compareStrings)
  return reasons
}

/** Every proposal that survives the gate (throws on none — callers report). */
export function undisposed(proposals: Proposal[], telemetry: Telemetry): Proposal[] {
  return proposals.filter((proposal) => disposeReason(proposal, telemetry).length === 0)
}

// ------------------------------------------------- writing (proposals only)

export interface WrittenProposal extends Proposal {
  /** Absolute directory holding this proposal's files. */
  readonly dir: string
}

async function writeOne(out: string, proposal: Proposal, files: Record<string, string>): Promise<WrittenProposal> {
  const dir = path.join(out, proposal.id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`)
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(path.join(dir, name), content)))
  return { ...proposal, dir }
}

/**
 * Write proposals under `<out>/<id>/` (proposal.json plus the rendered
 * files). Writes nowhere else: prompts, packs and gates.json are never
 * touched — a human applies what they review.
 */
export async function writeProposals(
  out: string,
  proposals: Proposal[],
  rendered: Map<string, Record<string, string>>,
): Promise<WrittenProposal[]> {
  const written = await Promise.all(
    proposals.map((proposal) => writeOne(out, proposal, rendered.get(proposal.id) ?? {})),
  )
  written.sort((a, b) => compareStrings(a.id, b.id))
  return written
}
