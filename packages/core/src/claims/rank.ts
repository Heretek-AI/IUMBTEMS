// Deterministic ranking of rival claims and rival dossiers (new in 1.1; legacy
// had no such ranker: runner/pcrb.py is the signed brief, runner/auctioneer.py
// ordered research scopes). Orders are lexicographic over counts and enums —
// no weights and no composite score, consistent with the research auditor —
// and every result carries the key it was sorted by, so the order explains
// itself. Ties end on a content hash, so the order never depends on input order.
import type { Claim, ClaimStatus, Dossier, Witness } from "../schema/claims.ts"

const STATUS_ORDER: Record<ClaimStatus, number> = { LIVE: 0, SUSPECT: 1, STALE: 2, REJECTED: 3 }

export interface ClaimRankKey {
  readonly status: ClaimStatus
  /** "ok", "unchecked" or "failed". */
  readonly witness: "ok" | "unchecked" | "failed"
  /** 0 strongest: VERIFIED, INFERRED from grounded parents, NEGATIVE_KNOWLEDGE, other INFERRED, HYPOTHESIS. */
  readonly strength: 0 | 1 | 2 | 3 | 4
  /** Distinct cached sources behind the claim (its own and its parents'). */
  readonly sources: number
}

export interface RankedClaim {
  readonly rank: number
  readonly claim: Claim
  readonly key: ClaimRankKey
}

export interface ClaimRankOptions {
  /** Fresh witnesses by claim id; otherwise the witness recorded on the claim. */
  readonly witnesses?: ReadonlyMap<string, Witness>
  /** Resolves INFERRED parents (the store, or the same dossier). */
  readonly lookup?: (id: string) => Claim | undefined
}

const witnessOf = (claim: Claim, options: ClaimRankOptions) => options.witnesses?.get(claim.id) ?? claim.witness

const grounded = (claim: Claim | undefined, options: ClaimRankOptions): boolean =>
  claim !== undefined && claim.tag === "VERIFIED" && claim.status === "LIVE" && witnessOf(claim, options)?.ok === true

function strength(claim: Claim, options: ClaimRankOptions): ClaimRankKey["strength"] {
  switch (claim.tag) {
    case "VERIFIED":
      return 0
    case "INFERRED": {
      const parents = (claim.parents ?? []).map((id) => options.lookup?.(id))
      return parents.length > 0 && parents.every((parent) => grounded(parent, options)) ? 1 : 3
    }
    case "NEGATIVE_KNOWLEDGE":
      return 2
    case "HYPOTHESIS":
      return 4
  }
}

export function claimRankKey(claim: Claim, options: ClaimRankOptions = {}): ClaimRankKey {
  const witness = witnessOf(claim, options)
  const sources = new Set<string>()
  if (claim.source) sources.add(claim.source.sha256)
  for (const id of claim.parents ?? []) {
    const parent = options.lookup?.(id)
    if (parent?.source) sources.add(parent.source.sha256)
  }
  return {
    status: claim.status,
    witness: witness === undefined ? "unchecked" : witness.ok ? "ok" : "failed",
    strength: strength(claim, options),
    sources: sources.size,
  }
}

const WITNESS_ORDER = { ok: 0, unchecked: 1, failed: 2 } as const
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function compareTuples(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!
    const right = b[i]!
    if (left === right) continue
    return typeof left === "number" && typeof right === "number"
      ? left - right
      : byCodePoint(String(left), String(right))
  }
  return 0
}

/** Rank rival claims, strongest first. */
export function rankClaims(claims: readonly Claim[], options: ClaimRankOptions = {}): RankedClaim[] {
  return claims
    .map((claim) => ({ claim, key: claimRankKey(claim, options) }))
    .map((item) => ({
      ...item,
      tuple: [
        STATUS_ORDER[item.key.status],
        WITNESS_ORDER[item.key.witness],
        item.key.strength,
        -item.key.sources,
        item.claim.id,
      ] as const,
    }))
    .sort((a, b) => compareTuples(a.tuple, b.tuple))
    .map((item, index) => ({ rank: index + 1, claim: item.claim, key: item.key }))
}

export interface DossierRankKey {
  /** Claims whose witness failed, or that an audit rejected. */
  readonly failed: number
  /** STALE or SUSPECT claims (their source was retracted or revised). */
  readonly degraded: number
  /** LIVE VERIFIED claims with a passing witness. */
  readonly grounded: number
  /** Distinct cached sources behind the grounded claims. */
  readonly sources: number
}

export interface RankedDossier {
  readonly rank: number
  readonly dossier: Dossier
  readonly key: DossierRankKey
}

export function dossierRankKey(dossier: Dossier, options: Pick<ClaimRankOptions, "witnesses"> = {}): DossierRankKey {
  let failed = 0
  let degraded = 0
  let groundedCount = 0
  const sources = new Set<string>()
  for (const claim of dossier.claims) {
    const witness = witnessOf(claim, options)
    if (claim.status === "REJECTED" || witness?.ok === false) failed++
    else if (claim.status === "STALE" || claim.status === "SUSPECT") degraded++
    else if (grounded(claim, options)) {
      groundedCount++
      if (claim.source) sources.add(claim.source.sha256)
    }
  }
  return { failed, degraded, grounded: groundedCount, sources: sources.size }
}

/**
 * Rank rival dossiers, best first: fewer failed claims, then fewer degraded
 * claims, then more grounded VERIFIED claims, then more distinct sources, then
 * evidenceHash, subject and createdAt (a total order). Pass dossiers from a
 * ClaimStore to rank with retractions applied.
 */
export function rankDossiers(
  dossiers: readonly Dossier[],
  options: Pick<ClaimRankOptions, "witnesses"> = {},
): RankedDossier[] {
  return dossiers
    .map((dossier) => ({ dossier, key: dossierRankKey(dossier, options) }))
    .map((item) => ({
      ...item,
      tuple: [
        item.key.failed,
        item.key.degraded,
        -item.key.grounded,
        -item.key.sources,
        item.dossier.evidenceHash,
        item.dossier.subject,
        item.dossier.createdAt,
      ] as const,
    }))
    .sort((a, b) => compareTuples(a.tuple, b.tuple))
    .map((item, index) => ({ rank: index + 1, dossier: item.dossier, key: item.key }))
}

/** One line per ranked item: what put it there. */
export function explainClaimRank(item: RankedClaim): string {
  const { key } = item
  return `#${item.rank} ${item.claim.tag} ${key.status} witness:${key.witness} strength:${key.strength} sources:${key.sources} — ${item.claim.statement.slice(0, 80)}`
}

export function explainDossierRank(item: RankedDossier): string {
  const { key } = item
  return `#${item.rank} ${item.dossier.mode} "${item.dossier.subject.slice(0, 60)}": failed ${key.failed}, degraded ${key.degraded}, grounded ${key.grounded}, sources ${key.sources}`
}
