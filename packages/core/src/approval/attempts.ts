// Approval attempt limiting (ADR 0002 I4): at most 5 wrong passphrases per
// 10 minutes per state dir, then a lockout. Lockouts are audited into the
// project's audit log. One surface's lockout does not affect the others.
import path from "node:path"
import { appendAuditEntry } from "../audit/chain.ts"
import { readJson, withLock, writeJson } from "../util/fs.ts"

/** Wrong passphrases before a lockout. */
export const MAX_APPROVAL_ATTEMPTS = 5
/** Window the attempts are counted in. */
export const APPROVAL_ATTEMPT_WINDOW_MS = 10 * 60_000

const ATTEMPTS_FILE = "approval-attempts.json"

interface AttemptRecord {
  readonly failures: string[]
}

export interface AttemptCheck {
  readonly allowed: boolean
  /** Seconds until the oldest failure leaves the window (present when locked). */
  readonly retryAfterSec?: number
  /** Wrong attempts left before a lockout (present when allowed). */
  readonly remaining?: number
}

const prune = (failures: string[], now: number): string[] =>
  failures.filter((at) => {
    const time = Date.parse(at)
    return !Number.isNaN(time) && time > now - APPROVAL_ATTEMPT_WINDOW_MS && time <= now
  })

async function readAttempts(dir: string, now: number): Promise<string[]> {
  const record = await readJson<AttemptRecord>(path.join(dir, ATTEMPTS_FILE)).catch(() => undefined)
  return prune(record?.failures ?? [], now)
}

function checkFailures(failures: string[], now: number): AttemptCheck {
  if (failures.length < MAX_APPROVAL_ATTEMPTS)
    return { allowed: true, remaining: MAX_APPROVAL_ATTEMPTS - failures.length }
  const oldest = Math.min(...failures.map((at) => Date.parse(at)))
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + APPROVAL_ATTEMPT_WINDOW_MS - now) / 1000)) }
}

/** Is a passphrase attempt currently allowed for this state dir? */
export async function checkApprovalAttempts(dir: string, now = Date.now()): Promise<AttemptCheck> {
  return checkFailures(await readAttempts(dir, now), now)
}

/** A correct passphrase clears the failure count. */
export async function noteApprovalSuccess(dir: string): Promise<void> {
  const file = path.join(dir, ATTEMPTS_FILE)
  await withLock(file, async () => writeJson(file, { failures: [] }))
}

export interface WrongPassphraseInput {
  readonly dir: string
  /** Project root whose audit log records the lockout. */
  readonly root: string
  readonly stage: string
  readonly channel: string
  readonly now?: number
}

/**
 * Record a wrong passphrase. Tripping the limit locks the surface out and
 * audits `approval.lockout` (actor `system`). Returns the post-write check.
 */
export async function noteWrongPassphrase(input: WrongPassphraseInput): Promise<AttemptCheck> {
  const now = input.now ?? Date.now()
  const file = path.join(input.dir, ATTEMPTS_FILE)
  const check = await withLock(file, async () => {
    const failures = [...(await readAttempts(input.dir, now)), new Date(now).toISOString()]
    await writeJson(file, { failures })
    return checkFailures(prune(failures, now), now)
  })
  if (!check.allowed)
    await appendAuditEntry(input.root, {
      actor: "system",
      action: "approval.lockout",
      payload: { stage: input.stage, channel: input.channel, retryAfterSec: check.retryAfterSec },
    })
  return check
}
