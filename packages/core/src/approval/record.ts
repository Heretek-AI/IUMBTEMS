import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { appendAuditEntry } from "../audit/chain.ts"
import { type Approval, ApprovalSchema } from "../schema/approval.ts"
import { FrontierSchema } from "../schema/frontier.ts"
import { parseGoalMarkdown } from "../schema/goal.ts"
import { atomicWrite } from "../util/fs.ts"
import { sha256 } from "../util/hash.ts"

export interface CreateApprovalInput {
  readonly stage: string
  readonly phaseId?: string
  readonly artifactPath: string
  readonly approvedBy: string
  readonly spendCeilingConfirmed?: number
  readonly notes?: string
}

export async function recordApproval(rootDir: string, input: CreateApprovalInput): Promise<Approval> {
  const fullArtifactPath = path.isAbsolute(input.artifactPath)
    ? input.artifactPath
    : path.join(rootDir, input.artifactPath)

  let content: string
  try {
    content = await readFile(fullArtifactPath, "utf8")
  } catch (err: any) {
    throw new Error(`Cannot approve non-existent artifact at ${input.artifactPath}: ${err.message}`)
  }

  const artifactHash = sha256(content)

  // Validate artifact against stage-specific schema
  if (input.stage === "grill") {
    let json: unknown
    try {
      json = JSON.parse(content)
    } catch {
      throw new Error(`Grill frontier at ${input.artifactPath} is not valid JSON`)
    }
    const frontier = FrontierSchema.parse(json)
    if (!frontier.settled) {
      throw new Error(`Cannot approve grill stage: frontier is not marked as settled.`)
    }
    if (input.spendCeilingConfirmed !== undefined && input.spendCeilingConfirmed !== frontier.spendCeiling.maxAmount) {
      throw new Error(
        `Spend ceiling mismatch: confirmed ${input.spendCeilingConfirmed} USD, but frontier specifies ${frontier.spendCeiling.maxAmount} USD.`,
      )
    }
  } else if (input.stage === "spec") {
    parseGoalMarkdown(content) // Throws if invalid frontmatter or missing criteria
  }

  const approvalData: Approval = ApprovalSchema.parse({
    stage: input.stage,
    phaseId: input.phaseId,
    artifactPath: input.artifactPath,
    artifactHash,
    approvedBy: input.approvedBy,
    approvedAt: new Date().toISOString(),
    spendCeilingConfirmed: input.spendCeilingConfirmed,
    notes: input.notes,
  })

  const approvalsDir = path.join(rootDir, ".factory", "approvals")
  await mkdir(approvalsDir, { recursive: true })

  const filename = input.phaseId ? `${input.stage}-${input.phaseId}.json` : `${input.stage}.json`
  const targetFile = path.join(approvalsDir, filename)

  await atomicWrite(targetFile, JSON.stringify(approvalData, null, 2))

  // Audit entry
  await appendAuditEntry(rootDir, {
    actor: input.approvedBy,
    action: `approve_${input.stage}`,
    payload: {
      phaseId: input.phaseId,
      artifactPath: input.artifactPath,
      artifactHash,
    },
  })

  return approvalData
}

export async function getApproval(rootDir: string, stage: string, phaseId?: string): Promise<Approval | null> {
  const filename = phaseId ? `${stage}-${phaseId}.json` : `${stage}.json`
  const approvalPath = path.join(rootDir, ".factory", "approvals", filename)

  try {
    const raw = await readFile(approvalPath, "utf8")
    return ApprovalSchema.parse(JSON.parse(raw))
  } catch (err: any) {
    if (err.code === "ENOENT") return null
    throw err
  }
}
