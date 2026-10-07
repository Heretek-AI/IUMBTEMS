// Living dossiers, ported from legacy runner/living_dossiers.py: a source that
// is retracted makes every claim citing it STALE; one that is revised makes
// them SUSPECT. Dossiers are never rewritten; degradation is applied when the
// store loads, so it is idempotent by construction. Fixes legacy bug B4: a
// corrupt ledger is an error (legacy silently reset it to []), and status
// events are derived, not re-appended on every pass.
import { appendAuditEntry } from "../audit/chain.ts"
import { factoryLayout } from "../layout.ts"
import { type Claim, type ClaimStatus, type Retraction, RetractionLedgerSchema } from "../schema/claims.ts"
import { readJson, withLock, writeJson } from "../util/fs.ts"

export interface StatusEvent {
  readonly claim: string
  readonly from: ClaimStatus
  readonly to: ClaimStatus
  readonly reason: string
  readonly at: string
}

export async function readRetractions(root: string): Promise<Retraction[]> {
  const file = factoryLayout(root).retractions
  const raw = await readJson(file).catch((error: Error) => {
    throw new Error(`${file} is unreadable: ${error.message}`)
  })
  if (raw === undefined) return []
  const parsed = RetractionLedgerSchema.safeParse(raw)
  if (!parsed.success)
    throw new Error(
      `${file} is corrupt (${parsed.error.issues.map((issue) => issue.message).join("; ")}); fix it by hand, it is never reset`,
    )
  return parsed.data.retractions
}

/** Human-only (es research retract): append to the ledger under its lock and audit it. */
export async function recordRetraction(
  root: string,
  input: Omit<Retraction, "at" | "note"> & { note?: string; at?: string },
): Promise<Retraction> {
  const file = factoryLayout(root).retractions
  const entry: Retraction = { note: "", ...input, at: input.at ?? new Date().toISOString() }
  await withLock(file, async () => {
    const retractions = await readRetractions(root)
    retractions.push(entry)
    await writeJson(file, RetractionLedgerSchema.parse({ version: 1, retractions }))
  })
  await appendAuditEntry(root, {
    actor: input.by,
    action: "claims.retract",
    payload: { source: entry.source, event: entry.event },
  })
  return entry
}

/** The latest event per source wins (ledger order). */
export function effectiveRetractions(retractions: readonly Retraction[]): Map<string, Retraction> {
  const out = new Map<string, Retraction>()
  for (const retraction of retractions) out.set(retraction.source, retraction)
  return out
}

/** Pure: degrade claims whose source was retracted or revised. Emits an event only on an actual change. */
export function applyDegradation(
  claims: readonly Claim[],
  retractions: readonly Retraction[] | ReadonlyMap<string, Retraction>,
): { claims: Claim[]; events: StatusEvent[] } {
  const effective = retractions instanceof Map ? retractions : effectiveRetractions(retractions as Retraction[])
  const events: StatusEvent[] = []
  const out = claims.map((claim) => {
    const retraction = claim.source ? effective.get(claim.source.sha256) : undefined
    if (!retraction || claim.status === "REJECTED") return claim
    const to: ClaimStatus = retraction.event === "RETRACTED" ? "STALE" : "SUSPECT"
    if (claim.status === to) return claim
    events.push({
      claim: claim.id,
      from: claim.status,
      to,
      reason: `source ${retraction.source.slice(0, 16)} ${retraction.event}: ${retraction.note || "no note"}`,
      at: retraction.at,
    })
    return { ...claim, status: to }
  })
  return { claims: out, events }
}
