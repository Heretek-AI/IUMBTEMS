// Browser approval tickets and CSRF binding (#131, ADR 0002 option b).
// Preview tickets are single-use and TTL-bound (I3): redeeming deletes the
// ticket whether it validates or not, so a failed attempt cannot be
// retried on the same ticket — the human previews again. CSRF tokens bind
// to the session cookie created by the #129 ticket exchange; the approve
// endpoint requires cookie + loopback Origin + matching CSRF (I6).
import { randomBytes, timingSafeEqual } from "node:crypto"

/** Preview tickets live this long (I3: TTL ≤ 120 s). */
export const APPROVE_TICKET_TTL_MS = 120_000

export interface ApproveTicket {
  readonly repoDir: string
  readonly stage: "frontier" | "spec"
  readonly subjectHash: string
}

export class ApproveTickets {
  private readonly live = new Map<string, { entry: ApproveTicket; exp: number }>()

  constructor(private readonly ttlMs: number = APPROVE_TICKET_TTL_MS) {}

  issue(entry: ApproveTicket): string {
    this.purge()
    const ticket = randomBytes(32).toString("hex")
    this.live.set(ticket, { entry, exp: Date.now() + this.ttlMs })
    return ticket
  }

  /** Single-use claim: the ticket dies on redeem, valid or not. */
  redeem(ticket: string): ApproveTicket | undefined {
    const found = this.live.get(ticket)
    this.live.delete(ticket)
    if (!found || found.exp <= Date.now()) return undefined
    return found.entry
  }

  private purge(): void {
    const now = Date.now()
    for (const [ticket, record] of this.live) if (record.exp <= now) this.live.delete(ticket)
  }
}

/** Per-session CSRF tokens for the approve endpoint (I6). */
export class CsrfTokens {
  private readonly live = new Map<string, string>()

  forSession(sessionId: string): string {
    const existing = this.live.get(sessionId)
    if (existing) return existing
    const token = randomBytes(32).toString("hex")
    this.live.set(sessionId, token)
    return token
  }

  check(sessionId: string, presented: string | undefined): boolean {
    const expected = this.live.get(sessionId)
    if (!expected || !presented) return false
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }
}
