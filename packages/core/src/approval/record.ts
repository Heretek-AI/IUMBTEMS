// Human-only approvals. Callers never name the artifact: the subject is
// derived from the factory layout for the stage, validated, hashed and signed
// with the human key, which only the human's passphrase unlocks (1.1.1). Only
// the approval service (`approval/service.ts`, called by every surface after
// a passphrase unlock) calls recordApproval; no agent tool, MCP
// tool or RPC does. Transitions call verifyApproval, which re-hashes
// the current artifacts, so editing a spec after approval blocks the build.
import { readFile } from "node:fs/promises"
import { hostname, userInfo } from "node:os"
import path from "node:path"
import { appendAuditEntry, auditHead } from "../audit/chain.ts"
import { factoryLayout, stateDir } from "../layout.ts"
import { type Approval, ApprovalSchema, type ApprovalStage, type Channel } from "../schema/approval.ts"
import { type Frontier, FrontierSchema } from "../schema/frontier.ts"
import { type ParsedGoal, parseGoalMarkdown } from "../schema/goal.ts"
import { type Roadmap, RoadmapSchema } from "../schema/roadmap.ts"
import { rebaseline } from "../trust/control.ts"
import { readJson, writeJson } from "../util/fs.ts"
import { sha256 } from "../util/hash.ts"
import { type HumanSigner, signatureProblem } from "./keystore.ts"

export class ApprovalError extends Error {}

export interface ApprovalSubject {
  readonly subject: Array<{ path: string; sha256: string }>
  readonly spendCeilingUSD?: number
  /** Human-readable lines for the confirmation dialog. */
  readonly summary: string[]
}

const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/")

async function readArtifact(root: string, file: string): Promise<string> {
  try {
    return await readFile(file, "utf8")
  } catch {
    throw new ApprovalError(`missing artifact ${rel(root, file)}`)
  }
}

function zodMessage(error: unknown): string {
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> })?.issues
  if (!issues) return error instanceof Error ? error.message : String(error)
  return issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ")
}

/** Validate the artifacts a stage approves and compute the signed subject. */
export async function approvalSubject(root: string, stage: ApprovalStage): Promise<ApprovalSubject> {
  const layout = factoryLayout(root)
  if (stage === "frontier") {
    let text: string
    try {
      text = await readArtifact(root, layout.frontier)
    } catch {
      throw new ApprovalError(
        `missing artifact ${rel(root, layout.frontier)} — run /grill and save the design tree with es_frontier_write (grill seat only), then request approval again`,
      )
    }
    let frontier: Frontier
    try {
      frontier = FrontierSchema.parse(JSON.parse(text))
    } catch (error) {
      throw new ApprovalError(`frontier.json is invalid: ${zodMessage(error)}`)
    }
    if (!frontier.settled)
      throw new ApprovalError(
        "the frontier is not settled yet; finish the grill first (/grill), then request approval again",
      )
    const open = frontier.nodes.filter((node) => node.status !== "settled").length
    return {
      subject: [{ path: rel(root, layout.frontier), sha256: sha256(text) }],
      spendCeilingUSD: frontier.spendCeiling.maxAmount,
      summary: [
        `Idea: ${frontier.idea}`,
        `Decisions settled: ${frontier.nodes.length - open} (${open} deferred)`,
        `Spend ceiling: $${frontier.spendCeiling.maxAmount} USD (the run halts above it)`,
      ],
    }
  }
  const roadmapText = await readArtifact(root, layout.roadmap)
  let roadmap: Roadmap
  try {
    roadmap = RoadmapSchema.parse(JSON.parse(roadmapText))
  } catch (error) {
    throw new ApprovalError(`roadmap.json is invalid: ${zodMessage(error)}`)
  }
  const subject = [{ path: rel(root, layout.roadmap), sha256: sha256(roadmapText) }]
  const summary = [`Roadmap: ${roadmap.title} (${roadmap.phases.length} phases)`]
  for (const phase of roadmap.phases) {
    const file = layout.spec(phase.id)
    const text = await readArtifact(root, file)
    let goal: ParsedGoal
    try {
      goal = parseGoalMarkdown(text)
    } catch (error) {
      throw new ApprovalError(`${rel(root, file)} is invalid: ${zodMessage(error)}`)
    }
    if (goal.frontmatter.phase !== phase.id)
      throw new ApprovalError(`${rel(root, file)} declares phase "${goal.frontmatter.phase}", expected "${phase.id}"`)
    subject.push({ path: rel(root, file), sha256: sha256(text) })
    summary.push(`  ${phase.id}: ${phase.title} — ${goal.frontmatter.acceptance.length} acceptance criteria`)
  }
  summary.push("After this approval the build runs autonomously until release (a human merges the PR).")
  return { subject, summary }
}

export interface RecordApprovalInput {
  readonly stage: ApprovalStage
  readonly channel: Channel
  /** Defaults to the OS user running the CLI/TUI. */
  readonly approvedBy?: string
  readonly notes?: string
  /** The unlocked human key. */
  readonly signer: HumanSigner
}

export async function recordApproval(root: string, input: RecordApprovalInput): Promise<Approval> {
  const { subject, spendCeilingUSD } = await approvalSubject(root, input.stage)
  const unsigned = {
    version: 2 as const,
    stage: input.stage,
    subject,
    approvedBy: input.approvedBy ?? userInfo().username,
    host: hostname(),
    approvedAt: new Date().toISOString(),
    channel: input.channel,
    auditHead: await auditHead(root),
    ...(spendCeilingUSD !== undefined ? { spendCeilingUSD } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  }
  const record = ApprovalSchema.parse({ ...unsigned, signature: input.signer.sign(unsigned) })
  await writeJson(factoryLayout(root).approval(input.stage), record)
  await appendAuditEntry(root, {
    actor: `human:${record.approvedBy}`,
    action: `approval.${input.stage}`,
    payload: { channel: record.channel, subject: record.subject },
  })
  await rebaseline(root, `human:${record.approvedBy}`)
  return record
}

export type ApprovalCheck =
  | { readonly ok: true; readonly record: Approval }
  | { readonly ok: false; readonly reason: string }

/** Is there a genuine approval for `stage` that still matches the artifacts on disk? */
export async function verifyApproval(
  root: string,
  stage: ApprovalStage,
  options: { readonly stateDir?: string } = {},
): Promise<ApprovalCheck> {
  const raw = await readJson<Record<string, unknown>>(factoryLayout(root).approval(stage)).catch(() => undefined)
  if (!raw)
    return { ok: false, reason: `no ${stage} approval; a human must run \`es approve ${stage}\` or /es-approve` }
  const unsigned = await signatureProblem(raw, `the ${stage} approval`, options.stateDir ?? stateDir())
  if (unsigned) return { ok: false, reason: `${unsigned} (\`es approve ${stage}\`)` }
  const parsed = ApprovalSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: `the ${stage} approval record is malformed` }
  for (const item of parsed.data.subject) {
    let text: string
    try {
      text = await readFile(path.join(root, item.path), "utf8")
    } catch {
      return { ok: false, reason: `${item.path} was approved but no longer exists` }
    }
    if (sha256(text) !== item.sha256)
      return { ok: false, reason: `${item.path} changed after it was approved; re-approve it` }
  }
  if (stage === "spec") {
    // Phases added to the roadmap after approval change roadmap.json, caught above;
    // a GOAL.md for a phase not in the subject is not part of the approval.
    const current = await approvalSubject(root, "spec").catch((error: Error) => error)
    if (current instanceof Error) return { ok: false, reason: current.message }
    if (current.subject.length !== parsed.data.subject.length)
      return { ok: false, reason: "the set of phase specs differs from what was approved; re-approve" }
  }
  return { ok: true, record: parsed.data }
}

export async function readApproval(root: string, stage: ApprovalStage): Promise<Approval | undefined> {
  const parsed = ApprovalSchema.safeParse(await readJson(factoryLayout(root).approval(stage)).catch(() => undefined))
  return parsed.success ? parsed.data : undefined
}
