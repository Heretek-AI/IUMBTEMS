// The one approval code path in core (#117). Every surface (CLI, TUI, web)
// records approvals through approveStage after unlocking the human key with
// the passphrase; nothing copies the record → clear-pending → begin-research
// sequence by hand. The service never sees the passphrase: it receives the
// unlocked HumanSigner.
import { userInfo } from "node:os"
import { Factory } from "../factory/machine.ts"
import type { Stage } from "../factory/state.ts"
import { gateRunner } from "../gates/index.ts"
import { factoryLayout } from "../layout.ts"
import type { Approval, ApprovalStage, Channel } from "../schema/approval.ts"
import { readJson, withLock, writeJson } from "../util/fs.ts"
import { hashJson } from "../util/hash.ts"
import type { HumanSigner } from "./keystore.ts"
import { ApprovalError, approvalSubject, readApproval, recordApproval, verifyApproval } from "./record.ts"

export interface ApproveStageInput {
  readonly stage: ApprovalStage
  readonly channel: Channel
  /** The unlocked human key (the service never handles the passphrase). */
  readonly signer: HumanSigner
  /** Defaults to the OS user running the surface. */
  readonly approvedBy?: string
  readonly notes?: string
  readonly stateDir?: string
  /**
   * ADR 0002 I3: hash of the previewed subject (`hashJson` of the subject
   * array, as bound into the preview ticket). Refuses on mismatch, so a
   * surface signs only what it previewed.
   */
  readonly expectedSubjectHash?: string
}

export interface ApproveStageResult {
  readonly record: Approval
  /** True when a valid record for the unchanged subject already existed (re-used, not re-signed). */
  readonly alreadyApproved: boolean
  /** Factory stage after the post-approval steps (undefined when no run exists yet). */
  readonly factoryStage: Stage | undefined
}

const subjectsEqual = (a: Approval["subject"], b: Approval["subject"]): boolean =>
  a.length === b.length && a.every((item, i) => item.path === b[i]?.path && item.sha256 === b[i]?.sha256)

/**
 * Record a frontier or spec approval and run its side effects, in order:
 * re-derive the subject (with the optional preview-hash check), sign and
 * record it, clear the stage from pending approvals, then for frontier
 * begin the run and enter research.
 *
 * The subject check, the record and the pending clear hold the factory state
 * lock together. The research begin follows under the Factory's own locks:
 * the state lock is not reentrant, so it cannot nest inside this one. The
 * window is the same one the CLI has always had; the record and the pending
 * clear are atomic with each other, which is what a retry needs.
 *
 * Failure policy: the signed record is never destroyed. When a later step
 * fails, the pending entry stays, and retrying re-uses the record
 * (`alreadyApproved`) while still ensuring the pending clear and the
 * research begin — the service is self-healing.
 */
export async function approveStage(root: string, input: ApproveStageInput): Promise<ApproveStageResult> {
  const approvedBy = input.approvedBy ?? userInfo().username
  const actor = `human:${approvedBy}`
  const factoryFor = () =>
    new Factory(root, {
      gates: gateRunner(input.stateDir ? { stateDir: input.stateDir } : {}),
      ...(input.stateDir ? { stateDir: input.stateDir } : {}),
    })

  const record = await withLock(factoryLayout(root).state, async () => {
    const { subject } = await approvalSubject(root, input.stage)
    if (input.expectedSubjectHash !== undefined && hashJson(subject) !== input.expectedSubjectHash)
      throw new ApprovalError("What was previewed changed since the preview; preview again and re-approve.")
    // Idempotency: a valid record for the unchanged subject is re-used.
    // The pending clear below still runs, so a retry after a midway failure heals.
    const existing = await readApproval(root, input.stage)
    let record: Approval
    let alreadyApproved = false
    if (
      existing &&
      subjectsEqual(existing.subject, subject) &&
      (await verifyApproval(root, input.stage, { stateDir: input.stateDir })).ok
    ) {
      record = existing
      alreadyApproved = true
    } else {
      record = await recordApproval(root, {
        stage: input.stage,
        channel: input.channel,
        approvedBy,
        ...(input.notes ? { notes: input.notes } : {}),
        signer: input.signer,
      })
    }
    const pending = (await readJson<Array<{ stage: string }>>(factoryLayout(root).pending).catch(() => undefined)) ?? []
    await writeJson(
      factoryLayout(root).pending,
      pending.filter((item) => item.stage !== input.stage),
    )
    return { record, alreadyApproved }
  })

  if (input.stage === "frontier") {
    const factory = factoryFor()
    if (!(await factory.read())) await factory.begin(actor)
    if ((await factory.read())?.stage === "GRILL") await factory.beginResearch(actor)
  }
  return { ...record, factoryStage: (await factoryFor().read())?.stage }
}
