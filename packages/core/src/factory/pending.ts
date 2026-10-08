// Pending human approvals: `es_request_approval` appends, `es approve` clears.
import { factoryLayout } from "../layout.ts"
import type { ApprovalStage } from "../schema/approval.ts"
import { readJson } from "../util/fs.ts"

export interface PendingApproval {
  readonly stage: ApprovalStage
  readonly requestedBy: string
  readonly at: string
  readonly note?: string
}

export async function pendingApprovals(root: string): Promise<PendingApproval[]> {
  return (await readJson<PendingApproval[]>(factoryLayout(root).pending).catch(() => undefined)) ?? []
}
