// Deterministic distillation of telemetry into reviewable proposals (#136).
// Clustering keys on (seat, failure kind, rule or category): the same gate
// rule, audit category or QA failure reason across runs, with the seat the
// S3.4 failure data names and never a defaulted one. Each surviving cluster
// becomes exactly one proposal — prompt guidance (a version-bumped patch),
// gate tuning (an explanation only: gates.json is a control file a human
// applies with rebaseline) or a domain-pack candidate (validated against
// DomainPackSchema). Proposals are only written under the output dir; nothing
// is ever applied automatically. A proposal the gate drops is reported with
// its reasons (never silently) in the command output and `dropped.json`.
//
// The "code disposes" gate (clean-room): a proposal is disposed unless every
// evidence quote appears verbatim in the source telemetry and every model
// numeral it names is a model the telemetry actually records. Hallucinated
// counts and model names cannot become reviewable proposals.
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { loadPrompt } from "../agents/assets.ts"
import { DomainPackSchema } from "../schema/domain.ts"
import {
  type Cluster,
  type ClusterKind,
  type EvalTelemetry,
  type FailureEntry,
  type Proposal,
  type ProposalKind,
  ProposalSchema,
  type RunTelemetry,
  type Telemetry,
} from "../schema/improve.ts"
import { compareStrings } from "../util/compare.ts"
import { atomicWrite, withLock } from "../util/fs.ts"
import { shortHash } from "../util/hash.ts"

export interface DistillThresholds {
  /** Minimum total occurrences of one key (default 3). */
  readonly minOccurrences?: number
  /** Minimum distinct runs carrying the key (default 2). */
  readonly minRuns?: number
}

export const DEFAULT_THRESHOLDS = { minOccurrences: 3, minRuns: 2 } as const

interface Signal {
  readonly seat?: string
  readonly kind: ClusterKind
  /** The rule, category or failure text the cluster keys on. */
  readonly facet: string
  readonly runId: string
  readonly evidence: string
}

/** Failure kinds that cluster into proposals (anything else is not clusterable). */
const CLUSTERABLE: ReadonlySet<string> = new Set(["gate", "audit", "qa", "replan", "eval"])

/** The cluster key: (seat, kind, facet), with no defaulted seat. */
const signalKey = (seat: string | undefined, kind: ClusterKind, facet: string): string =>
  seat ? `${seat}:${kind}:${facet}` : `${kind}:${facet}`

/** Round-robin evidence across contributing logs (occurrence `index` of `count`). */
const gateEvidence = (run: RunTelemetry, rule: string, index: number): string => {
  const rejection = run.gateRejections.find((entry) => entry.rule === rule)
  const logs = rejection?.logs ?? []
  if (logs.length === 0) return `run ${run.id}: gate rejection ${rule}`
  const log = logs[index % logs.length]!
  return `run ${run.id} gate-log ${log}: ${rule}`
}

/** Round-robin evidence across contributing audit records. */
const auditEvidence = (run: RunTelemetry, category: string, index: number): string => {
  const slash = category.indexOf("/")
  const found = run.auditFindings.find(
    (entry) => entry.kind === category.slice(0, slash) && entry.severity === category.slice(slash + 1),
  )
  const sources = found?.sources ?? []
  if (sources.length === 0) return `run ${run.id}: audit finding ${category}`
  const source = sources[index % sources.length]!
  return `run ${run.id} audit ${source}: ${category}`
}

/** Evidence for a chain-backed failure: the chain entry's hash, or a plain quote. */
const chainEvidence = (run: RunTelemetry, action: string, phase: string | undefined, reason: string): string => {
  const hit = run.auditChain.trail.find(
    (entry) => entry.action === action && (entry.phase ?? "") === (phase ?? "") && (entry.reason ?? reason) === reason,
  )
  if (!hit) return `run ${run.id}: ${action}${phase ? ` ${phase}` : ""} ${reason}`
  return (
    `run ${run.id} audit-chain #${hit.seq} ${hit.hash}: ${hit.action}` +
    `${hit.phase ? ` ${hit.phase}` : ""}${hit.reason ? ` ${hit.reason}` : ""}`
  )
}

/** Evidence for one S3.4 failure entry, resolved against the run's links. */
function failureEvidence(run: RunTelemetry, phaseId: string, failure: FailureEntry, index: number): string {
  if (failure.kind === "gate" && failure.rule) return gateEvidence(run, failure.rule, index)
  if (failure.kind === "audit" && failure.category) return auditEvidence(run, failure.category, index)
  if (failure.kind === "qa") return chainEvidence(run, "qa.fail", phaseId, failure.reason)
  if (failure.kind === "replan") return chainEvidence(run, "phase.replan", phaseId, failure.reason)
  return `run ${run.id}: ${failure.kind} ${failure.reason}`
}

/**
 * Signals from one run's S3.4 phase failures: the seat the data names (never
 * a default), keyed on (seat, kind, rule or category). QA clusters on the
 * failure reason itself, so the same QA failure reason clusters (#136).
 */
function phaseFailureSignals(run: RunTelemetry): Signal[] {
  const out: Signal[] = []
  const seen = new Map<string, number>()
  for (const phase of run.phases) {
    for (const failure of phase.failures) {
      if (!CLUSTERABLE.has(failure.kind)) continue
      const kind = failure.kind as ClusterKind
      const facet = failure.rule ?? failure.category ?? (kind === "qa" ? failure.reason : kind)
      const seenKey = `${kind}:${facet}`
      const index = seen.get(seenKey) ?? 0
      seen.set(seenKey, index + 1)
      out.push({
        ...(failure.seat ? { seat: failure.seat } : {}),
        kind,
        facet,
        runId: run.id,
        evidence: failureEvidence(run, phase.id, failure, index),
      })
    }
  }
  return out
}

/** Halt evidence: the chain's halt entry hash when the trail records it. */
const haltEvidence = (run: RunTelemetry): string => {
  const halt = run.halt!
  const hit = [...run.auditChain.trail].reverse().find((entry) => entry.action === "stage.halted")
  if (hit) return `run ${run.id} audit-chain #${hit.seq} ${hit.hash}: stage.halted ${halt.reason}`
  return `run ${run.id}: halt from ${halt.from}: ${halt.reason}`
}

function runSignals(run: RunTelemetry): Signal[] {
  // Trusted phases carry the seat-attributed S3.4 failures; the aggregates
  // below are their fallback for unsealed or phaseless runs, keyed the same
  // way so sealed and unsealed harvests of one run cluster alike.
  if (run.phases.length > 0) {
    const halted = run.halt
      ? [{ kind: "eval" as const, facet: `halt/${run.halt.from}`, runId: run.id, evidence: haltEvidence(run) }]
      : []
    return [...phaseFailureSignals(run), ...halted]
  }
  const out: Signal[] = []
  for (const rejection of run.gateRejections)
    for (let index = 0; index < rejection.count; index++)
      out.push({
        kind: "gate",
        facet: rejection.rule,
        runId: run.id,
        evidence: gateEvidence(run, rejection.rule, index),
      })
  for (const finding of run.auditFindings) {
    const category = `${finding.kind}/${finding.severity}`
    for (let index = 0; index < finding.count; index++)
      out.push({ kind: "audit", facet: category, runId: run.id, evidence: auditEvidence(run, category, index) })
  }
  if (run.halt) out.push({ kind: "eval", facet: `halt/${run.halt.from}`, runId: run.id, evidence: haltEvidence(run) })
  return out
}

function evalSignals(evalCase: EvalTelemetry): Signal[] {
  if (evalCase.pass) return []
  const failures = evalCase.failures.length > 0 ? evalCase.failures : ["failed"]
  return failures.map((failure) => ({
    kind: "eval" as const,
    // Key on the failure text itself: the same reason across cases is
    // one cluster; the case and its aggregate file stay in the evidence.
    facet: failure,
    runId: `eval/${evalCase.case}`,
    evidence: `eval ${evalCase.case} (${evalCase.source}): ${failure}`,
  }))
}

function signals(telemetry: Telemetry): Signal[] {
  const out: Signal[] = []
  for (const run of telemetry.runs) out.push(...runSignals(run))
  for (const evalCase of telemetry.evals) out.push(...evalSignals(evalCase))
  return out
}

/**
 * Every verbatim evidence string the telemetry yields (audit-chain hashes,
 * gate-log and audit-record paths, eval aggregate files — never synthesized
 * phrases, sorted). The "code disposes" gate checks proposal quotes against
 * exactly this set: a quote counts as verbatim only when the harvester said it.
 */
export function signalEvidence(telemetry: Telemetry): string[] {
  const evidence = [...new Set(signals(telemetry).map((signal) => signal.evidence))]
  evidence.sort(compareStrings)
  return evidence
}

interface ClusterGroup {
  kind: ClusterKind
  facet: string
  seat?: string
  runIds: Set<string>
  evidence: string[]
}

const toCluster = (key: string, group: ClusterGroup): Cluster => {
  const runIds = [...group.runIds]
  runIds.sort(compareStrings)
  const evidence = [...new Set(group.evidence)]
  evidence.sort(compareStrings)
  return {
    key,
    kind: group.kind,
    label: group.facet,
    ...(group.seat ? { seat: group.seat } : {}),
    occurrences: group.evidence.length,
    runIds,
    evidence,
  }
}

/**
 * Deterministic clustering: group signals by (seat, kind, facet), count
 * occurrences, collect distinct run ids and verbatim evidence. Sorted by key.
 */
export function clusterTelemetry(telemetry: Telemetry, thresholds: DistillThresholds = {}): Cluster[] {
  const minOccurrences = thresholds.minOccurrences ?? DEFAULT_THRESHOLDS.minOccurrences
  const minRuns = thresholds.minRuns ?? DEFAULT_THRESHOLDS.minRuns
  const groups = new Map<string, ClusterGroup>()
  for (const signal of signals(telemetry)) {
    const key = signalKey(signal.seat, signal.kind, signal.facet)
    let group = groups.get(key)
    if (!group) {
      group = {
        kind: signal.kind,
        facet: signal.facet,
        ...(signal.seat ? { seat: signal.seat } : {}),
        runIds: new Set(),
        evidence: [],
      }
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
  qa: "prompt-guidance",
  replan: "prompt-guidance",
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

/**
 * Prompt asset for a prompt-guidance cluster: the failure's own seat when it
 * names a real prompt, else the asset for the failure kind. The old seat
 * guess (`programmer` for everything non-invariant) is gone: QA failures
 * guide the QA prompt, replans guide the manager prompt, and audit findings
 * guide their auditor seat's prompt.
 */
async function promptAssetFor(cluster: Cluster): Promise<{ id: string; version: number; body: string }> {
  const fallback = cluster.kind === "qa" ? "qa-functional" : cluster.kind === "replan" ? "manager" : "auditor-thesis"
  for (const id of [...new Set([cluster.seat, fallback])].filter((entry): entry is string => !!entry)) {
    try {
      const asset = await loadPrompt(id)
      return { id, version: asset.meta.version, body: asset.body }
    } catch {
      // Not a prompt seat (e.g. the chain actor `qa`): try the kind fallback.
    }
  }
  throw new Error(`no prompt asset for cluster ${cluster.key}`)
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
  const { id: promptId, version, body } = await promptAssetFor(cluster)
  const next = version + 1
  const pitfall = `Known pitfall (distilled from ${cluster.occurrences} occurrence(s) of ${cluster.label}): re-read the evidence above before recording a verdict.`
  const source = await readFile(promptFor(promptId), "utf8").catch(() => undefined)
  const lines = (source ?? `${body}\n`).replace(/\n$/, "").split("\n")
  const versionLine = lines.findIndex((line) => /^version:\s*\d+\s*$/.test(line))
  const hunks: string[] = []
  if (versionLine > 0) hunks.push(...replaceHunk(lines, versionLine, `version: ${version}`, `version: ${next}`))
  hunks.push(...appendHunk(lines, pitfall))
  const rationale =
    `Failure signal "${cluster.label}" (${cluster.kind}) recurred ${cluster.occurrences} time(s) across ${cluster.runIds.length} run(s). ` +
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
  // Atomic files under the proposal dir's lock (S3.3): a crashed or
  // concurrent distill never leaves a torn proposal.json behind.
  return withLock(dir, async () => {
    await mkdir(dir, { recursive: true })
    await atomicWrite(path.join(dir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`)
    await Promise.all(Object.entries(files).map(([name, content]) => atomicWrite(path.join(dir, name), content)))
    return { ...proposal, dir }
  })
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

// ------------------------------------------------- dropped proposals (never silent)

/** A proposal the "code disposes" gate dropped, with every reason. */
export interface DroppedProposal {
  readonly id: string
  readonly kind: ProposalKind
  readonly key: string
  readonly reasons: readonly string[]
}

/** Every disposed proposal with its reasons, sorted by id (deterministic). */
export function disposedWithReasons(
  proposals: Proposal[],
  telemetry: Telemetry,
): Array<{ proposal: Proposal; reasons: string[] }> {
  const out = proposals
    .map((proposal) => ({ proposal, reasons: disposeReason(proposal, telemetry) }))
    .filter((entry) => entry.reasons.length > 0)
  out.sort((a, b) => compareStrings(a.proposal.id, b.proposal.id))
  return out
}

/**
 * Write `<out>/dropped.json` (every disposed proposal with its reason)
 * atomically under a lock, so a rerun is byte-identical. Nothing the gate
 * drops is ever silent.
 */
export async function writeDropped(
  out: string,
  dropped: ReadonlyArray<{ proposal: Proposal; reasons: readonly string[] }>,
): Promise<string> {
  const file = path.join(out, "dropped.json")
  const entries: DroppedProposal[] = dropped.map((entry) => ({
    id: entry.proposal.id,
    kind: entry.proposal.kind,
    key: entry.proposal.cluster.key,
    reasons: [...entry.reasons],
  }))
  entries.sort((a, b) => compareStrings(a.id, b.id))
  const body = `${JSON.stringify(entries, null, 2)}\n`
  await withLock(file, () => atomicWrite(file, body))
  return file
}
