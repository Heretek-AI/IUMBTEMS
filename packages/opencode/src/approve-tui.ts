// In-TUI approval signing (#119, ADR 0002). The TUI process runs on the
// human's machine, so it unlocks the sealed key and signs in-process through
// the core approveStage service — no passphrase and no approval ever cross
// RPC (the #49 property still holds: there is no approve RPC). Trust, waive
// and resume keep routing to the terminal (ADR 0002 I7).
import { userInfo } from "node:os"
import {
  type Approval,
  type ApprovalStage,
  approveStage,
  checkApprovalAttempts,
  stateDir as defaultStateDir,
  exists,
  factoryLayout,
  HumanKeyError,
  hasHumanKey,
  noteApprovalSuccess,
  noteWrongPassphrase,
  unlockHumanKey,
  zeroCodepoints,
} from "@heretek-ai/es-core"

export interface ApproveTuiInput {
  readonly root: string
  readonly stage: ApprovalStage
  /** ADR 0002 I3: hashJson of the previewed subject, from previewApproval. */
  readonly expectedSubjectHash: string
  readonly approvedBy?: string
  readonly stateDir?: string
  /**
   * ADR 0002 I3: the preview ticket redeemed exactly once before signing
   * (single-use + 120 s TTL). Production passes the token from
   * previewApproval and a redeem that calls the validate-only
   * `redeemApproval` RPC (it signs nothing); tests script the ticket map.
   */
  readonly previewToken?: string
  /** `issuedAt` from previewApproval; a preview older than 120 s is refused. */
  readonly previewIssuedAt?: number
  /** Validate-only redeem of the preview token (signs nothing). */
  readonly redeemPreview?: (token: string) => Promise<void>
  /** Clock override (tests). */
  readonly now?: () => number
  /**
   * The masked passphrase dialog (production: readMaskedPassphrase over
   * dialog.show; tests: a scripted function). Resolves to the entered code
   * points, or undefined on cancel. The array is zeroed by the caller.
   */
  readonly readPassphrase: (title: string) => Promise<string[] | undefined>
}

export type ApproveTuiOutcome =
  | { readonly ok: true; readonly record: Approval }
  | { readonly ok: false; readonly fallback: true; readonly reason: string }
  | { readonly ok: false; readonly locked: true; readonly retryAfterSec: number }
  | { readonly ok: false; readonly cancelled: true }

const TERMINAL_FALLBACK = (stage: ApprovalStage) =>
  `Run \`es approve ${stage}\` at a terminal with your passphrase (approvals need the sealed human key).`

/** ADR 0002 I3: a preview older than this is refused instead of signed. */
export const APPROVAL_PREVIEW_TTL_MS = 120_000

/**
 * Complete a frontier/spec approval inside the TUI: throttle check, masked
 * passphrase loop, unlock, preview-ticket redeem, approveStage with channel
 * "tui" and the preview's subject hash, key destruction. Returns a fallback when this TUI cannot
 * sign (remote attach without the project root or sealed key): the caller
 * shows the terminal alert. ApprovalError (subject changed since preview),
 * an expired or already-used preview, and unexpected failures propagate to
 * the caller's guard.
 */
export async function approveInTui(input: ApproveTuiInput): Promise<ApproveTuiOutcome> {
  const dir = input.stateDir ?? defaultStateDir()
  // A TUI that cannot see the project root and the sealed key (a remote
  // attach) keeps the "approve in a terminal" alert instead of signing
  // anywhere else.
  if (!(await exists(factoryLayout(input.root).dir)) || !(await hasHumanKey(dir)))
    return { ok: false, fallback: true, reason: TERMINAL_FALLBACK(input.stage) }

  const gate = await checkApprovalAttempts(dir)
  if (!gate.allowed) return { ok: false, locked: true, retryAfterSec: gate.retryAfterSec ?? 0 }

  const title = `Approve ${input.stage} as ${input.approvedBy ?? userInfo().username}`
  for (;;) {
    const codepoints = await input.readPassphrase(title)
    if (codepoints === undefined) return { ok: false, cancelled: true }
    // The string cannot be zeroed in JS (same as the CLI's echo-off input):
    // it lives in this local only, and the array is zeroed at once.
    const passphrase = codepoints.join("")
    zeroCodepoints(codepoints)
    try {
      const signer = await unlockHumanKey(passphrase, dir)
      try {
        // ADR 0002 I3: the preview ticket is redeemed exactly once, after
        // the unlock (a typo must not consume it) and before anything is
        // signed. An expired or already-used preview refuses here.
        const now = input.now ?? Date.now
        if (input.previewIssuedAt !== undefined && now() - input.previewIssuedAt > APPROVAL_PREVIEW_TTL_MS)
          throw new Error("The approval preview expired (> 120 s old); preview again.")
        if (input.previewToken !== undefined && input.redeemPreview !== undefined)
          await input.redeemPreview(input.previewToken)
        await noteApprovalSuccess(dir)
        const { record } = await approveStage(input.root, {
          stage: input.stage,
          channel: "tui",
          signer,
          ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
          stateDir: dir,
          expectedSubjectHash: input.expectedSubjectHash,
        })
        return { ok: true, record }
      } finally {
        signer.destroy()
      }
    } catch (error) {
      if (error instanceof HumanKeyError && error.message === "wrong passphrase") {
        const check = await noteWrongPassphrase({ dir, root: input.root, stage: input.stage, channel: "tui" })
        if (!check.allowed) return { ok: false, locked: true, retryAfterSec: check.retryAfterSec ?? 0 }
        continue
      }
      throw error
    }
  }
}
