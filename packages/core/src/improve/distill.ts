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
  type Proposal,
  type ProposalKind,
  ProposalSchema,
  type Telemetry,
} from "../schema/improve.ts"
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

function signals(telemetry: Telemetry): Signal[] {
  const out: Signal[] = []
  for (const run of telemetry.runs) {
    for (const rejection of run.gateRejections)
      for (let i = 0; i < rejection.count; i++)
        out.push({
          kind: "gate",
          label: rejection.rule,
          runId: run.id,
          evidence: `run ${run.id}: gate rejection ${rejection.rule}`,
        })
    for (const finding of run.auditFindings)
      for (let i = 0; i < finding.count; i++)
        out.push({
          kind: "audit",
          label: `${finding.kind}/${finding.severity}`,
          runId: run.id,
          evidence: `run ${run.id}: audit finding ${finding.kind}/${finding.severity}`,
        })
    if (run.halt)
      out.push({
        kind: "eval",
        label: `halt/${run.halt.from}`,
        runId: run.id,
        evidence: `run ${run.id}: halt from ${run.halt.from}: ${run.halt.reason}`,
      })
  }
  for (const evalCase of telemetry.evals) {
    if (evalCase.pass) continue
    for (const failure of evalCase.failures.length ? evalCase.failures : ["failed"])
      out.push({
        kind: "eval",
        // Key on the failure text itself: the same reason across cases is
        // one cluster; the case stays in the evidence and the run id.
        label: failure,
        runId: `eval/${evalCase.case}`,
        evidence: `eval ${evalCase.case}: ${failure}`,
      })
  }
  return out
}

/**
 * Every verbatim evidence string the telemetry yields (the harvester's own
 * signal phrases, sorted). The "code disposes" gate checks proposal quotes
 * against exactly this set: a quote counts as verbatim only when the
 * harvester said it.
 */
export function signalEvidence(telemetry: Telemetry): string[] {
  return [...new Set(signals(telemetry).map((signal) => signal.evidence))].sort()
}

/**
 * Deterministic clustering: group signals by (kind, label), count
 * occurrences, collect distinct run ids and verbatim evidence. Sorted by key.
 */
export function clusterTelemetry(telemetry: Telemetry, thresholds: DistillThresholds = {}): Cluster[] {
  const minOccurrences = thresholds.minOccurrences ?? DEFAULT_THRESHOLDS.minOccurrences
  const minRuns = thresholds.minRuns ?? DEFAULT_THRESHOLDS.minRuns
  const groups = new Map<string, { kind: ClusterKind; label: string; runIds: Set<string>; evidence: string[] }>()
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
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([, group]) => group.evidence.length >= minOccurrences && group.runIds.size >= minRuns)
    .map(([key, group]) => ({
      key,
      kind: group.kind,
      label: group.label,
      occurrences: group.evidence.length,
      runIds: [...group.runIds].sort(),
      evidence: [...new Set(group.evidence)].sort(),
    }))
}

const KIND_FOR_CLUSTER: Record<ClusterKind, ProposalKind> = {
  gate: "gate-tuning",
  audit: "prompt-guidance",
  eval: "domain-pack",
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "proposal"

/** Stable proposal id from the cluster key (deterministic across runs). */
export const proposalId = (kind: ProposalKind, cluster: Pick<Cluster, "key">): string =>
  `${kind}-${slug(cluster.key)}-${shortHash(cluster.key)}`

const SEAT_FOR_AUDIT = (label: string): string => (label.startsWith("invariant/") ? "auditor-thesis" : "programmer")

const promptFor = (promptId: string): string => `packages/core/assets/prompts/${promptId}.md`

/**
 * Render one proposal's files (but write nothing): proposal.json metadata is
 * assembled by `writeProposals`. Prompt patches are unified diffs against the
 * seat's prompt asset: a version-bump hunk plus a known-pitfall insertion.
 */
export async function renderProposalFiles(
  cluster: Cluster,
): Promise<{ kind: ProposalKind; id: string; rationale: string; files: Record<string, string> }> {
  const kind = KIND_FOR_CLUSTER[cluster.kind]
  const id = proposalId(kind, cluster)
  if (kind === "gate-tuning") {
    const rationale =
      `Gate rule "${cluster.label}" rejected ${cluster.occurrences} time(s) across ${cluster.runIds.length} run(s) ` +
      `(${cluster.runIds.join(", ")}). This proposal only explains the pattern: gates.json is a factory control ` +
      `file, so a human applies any tuning with \`es rebaseline\`. Nothing here changes a gate on its own.`
    return {
      kind,
      id,
      rationale,
      files: {
        "gates.md": [
          `# Gate-tuning proposal: ${cluster.label}`,
          ``,
          rationale,
          ``,
          `## Evidence`,
          ...cluster.evidence.map((quote) => `- ${quote}`),
          ``,
          `## Suggested direction (human applies with \`es rebaseline\`)`,
          ``,
          `Consider whether rule "${cluster.label}" needs a waiver scope, a fix in the seats' guidance, or a ` +
            `tighter check. Do not apply this file mechanically: review the evidence first.`,
          ``,
        ].join("\n"),
      },
    }
  }
  if (kind === "prompt-guidance") {
    const promptId = SEAT_FOR_AUDIT(cluster.label)
    const asset = await loadPrompt(promptId)
    const next = asset.meta.version + 1
    const pitfall = `Known pitfall (distilled from ${cluster.occurrences} occurrence(s) of ${cluster.label}): re-read the evidence above before recording a verdict.`
    const source = await readFile(promptFor(promptId), "utf8").catch(() => undefined)
    const lines = (source ?? `${asset.body}\n`).replace(/\n$/, "").split("\n")
    const versionLine = lines.findIndex((line) => /^version:\s*\d+\s*$/.test(line))
    const hunks: string[] = []
    if (versionLine > 0) {
      const ctxBefore = lines.slice(Math.max(0, versionLine - 2), versionLine)
      const ctxAfter = lines.slice(versionLine + 1, versionLine + 3)
      const oldStart = versionLine - ctxBefore.length + 1
      const oldCount = ctxBefore.length + 1 + ctxAfter.length
      hunks.push(
        `@@ -${oldStart},${oldCount} +${oldStart},${oldCount} @@`,
        ...ctxBefore.map((line) => ` ${line}`),
        `-version: ${asset.meta.version}`,
        `+version: ${next}`,
        ...ctxAfter.map((line) => ` ${line}`),
      )
    }
    const tail = lines.slice(-3)
    const tailStart = lines.length - tail.length + 1
    hunks.push(
      `@@ -${tailStart},${tail.length} +${tailStart},${tail.length + 1} @@`,
      ...tail.map((line) => ` ${line}`),
      `+${pitfall}`,
    )
    const rationale =
      `Audit signal "${cluster.label}" recurred ${cluster.occurrences} time(s) across ${cluster.runIds.length} run(s). ` +
      `This patch adds one known-pitfall line to the ${promptId} prompt and bumps its frontmatter to v${next}, ` +
      `so the assets drift check stays green when a human applies it. Review the evidence before applying.`
    return {
      kind,
      id,
      rationale,
      files: {
        "prompt.patch": [`--- a/${promptFor(promptId)}`, `+++ b/${promptFor(promptId)}`, ...hunks, ``].join("\n"),
        "rationale.md": [
          `# Prompt-guidance proposal: ${promptId}`,
          ``,
          rationale,
          ``,
          `## Evidence`,
          ...cluster.evidence.map((quote) => `- ${quote}`),
          ``,
        ].join("\n"),
      },
    }
  }
  const packId = `distilled-${slug(cluster.label)}`.slice(0, 48)
  const pack = DomainPackSchema.parse({
    packId,
    description: `Distilled from ${cluster.occurrences} occurrence(s) of ${cluster.label} across ${cluster.runIds.join(", ")}: research touching this failure domain must cite primary evidence. Human-reviewed proposal; not applied.`,
    tierWeights: { __default__: 1 },
    mandatoryTags: ["VERIFIED"],
  })
  const rationale =
    `Failure signal "${cluster.label}" recurred ${cluster.occurrences} time(s) across ${cluster.runIds.length} run(s). ` +
    `This candidate domain pack (${pack.packId}) would require VERIFIED evidence on claims in this domain. ` +
    `It is schema-valid but unreviewed: a human adopts it by adding it to assets/domain-packs/.`
  return {
    kind,
    id,
    rationale,
    files: {
      "pack.json": `${JSON.stringify(pack, null, 2)}\n`,
      "rationale.md": [
        `# Domain-pack proposal: ${pack.packId}`,
        ``,
        rationale,
        ``,
        `## Evidence`,
        ...cluster.evidence.map((quote) => `- ${quote}`),
        ``,
      ].join("\n"),
    },
  }
}

/** Distill every surviving cluster into a validated proposal (deterministic order). */
export async function distillProposals(telemetry: Telemetry, thresholds: DistillThresholds = {}): Promise<Proposal[]> {
  const out: Proposal[] = []
  for (const cluster of clusterTelemetry(telemetry, thresholds)) {
    const rendered = await renderProposalFiles(cluster)
    const files = Object.keys(rendered.files).sort()
    out.push(
      ProposalSchema.parse({ id: rendered.id, kind: rendered.kind, cluster, rationale: rendered.rationale, files }),
    )
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ------------------------------------------------- the "code disposes" gate

/** Model-numeral candidates: letters, then a separator, then a version number (`gpt-4`, `claude 3.5`). */
const MODEL_NUMERAL =
  /\b[a-z][a-z0-9]*(?:[-_ ][a-z0-9]+)*[-_ ]\d+(?:\.\d+)+\b|\b(?:gpt|claude|gemini|llama|mistral|qwen)[-_. ]?\d[\w.]*\b/gi

const KNOWN_NON_MODELS = new Set(["utf-8", "utf8", "sha-256", "sha256", "base-64", "base64", "v1", "v2"])

/** Model strings the telemetry actually records (eval models). */
export function telemetryModels(telemetry: Telemetry): Set<string> {
  const models = new Set<string>()
  for (const evalCase of telemetry.evals) if (evalCase.model) models.add(evalCase.model.toLowerCase())
  return models
}

/**
 * Why this proposal is disposed (undefined when it stands): an evidence
 * quote must appear verbatim in the source telemetry, and a model numeral
 * must be a model the telemetry records. Returns every reason, sorted.
 */
export function disposeReason(proposal: Proposal, telemetry: Telemetry): string[] {
  const verbatim = new Set(signalEvidence(telemetry))
  const reasons: string[] = []
  for (const quote of proposal.cluster.evidence)
    if (!verbatim.has(quote)) reasons.push(`evidence is not a verbatim quote: ${quote.slice(0, 80)}`)
  const allowed = telemetryModels(telemetry)
  const text = `${proposal.rationale} ${proposal.cluster.label}`
  for (const match of new Set(text.match(MODEL_NUMERAL) ?? [])) {
    const numeral = match.toLowerCase()
    if (KNOWN_NON_MODELS.has(numeral)) continue
    if (![...allowed].some((model) => model.includes(numeral) || numeral.includes(model)))
      reasons.push(`hallucinated model numeral: ${match}`)
  }
  return reasons.sort()
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
  const written: WrittenProposal[] = []
  for (const proposal of proposals) {
    const dir = path.join(out, proposal.id)
    await mkdir(dir, { recursive: true })
    const files = rendered.get(proposal.id) ?? {}
    await writeFile(path.join(dir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`)
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content)
    written.push({ ...proposal, dir })
  }
  return written.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
