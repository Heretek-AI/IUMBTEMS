// The domain-pack constitution: a full port of 0.7.25 `runner/refinement.py`.
// It decides per-claim verdicts (banned domains, mandatory tags, parent
// resolution, the retraction policy) and the tier-aware epistemic score E(D)
// with its accept threshold. The structural claim rules (a VERIFIED claim
// needs a source and a quote, and so on) live in the witness in 1.x
// (`claims/witness.ts`) and are not duplicated here; the legacy checker's
// remaining rules are the pack rules below.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ClaimStatus } from "../schema/claims.ts"
import { type DomainPack, DomainPackSchema } from "../schema/domain.ts"
import { cleanNk } from "./claim.ts"

export interface Constitution {
  /** Per-verified-claim weight by source tier; `__default__` covers unlisted tiers. */
  readonly tierWeights: Readonly<Record<string, number>>
  readonly negBonus: number
  readonly rejectPenalty: number
  readonly acceptThreshold: number
  readonly bannedDomains: readonly string[]
  readonly mandatoryTags: readonly string[]
  readonly retractionPolicy: "standard" | "zero_tolerance"
}

/** The no-pack constitution: flat weights, no rules, standard retraction (legacy defaults). */
export const LEGACY_CONSTITUTION: Constitution = {
  tierWeights: { __default__: 1 },
  negBonus: 0.5,
  rejectPenalty: 2.5,
  acceptThreshold: 0.65,
  bannedDomains: [],
  mandatoryTags: [],
  retractionPolicy: "standard",
}

export const constitutionFromPack = (pack: DomainPack): Constitution => ({
  tierWeights: { __default__: 1, ...pack.tierWeights },
  negBonus: pack.negBonus,
  rejectPenalty: pack.rejectPenalty,
  acceptThreshold: pack.acceptThreshold,
  bannedDomains: pack.bannedDomains,
  mandatoryTags: pack.mandatoryTags,
  retractionPolicy: pack.retractionPolicy,
})

export const weightFor = (constitution: Constitution, tier: string | undefined): number =>
  (tier !== undefined && constitution.tierWeights[tier] !== undefined
    ? constitution.tierWeights[tier]
    : constitution.tierWeights.__default__) ?? 1

/**
 * The tier evidence composes at (#113): the highest-weighted tier wins, ties
 * keep the first listed, and no tier means __default__. Claims built from one
 * cited source carry that source's tier; multi-source evidence (scout/audit
 * modes) resolves through here under the active pack.
 */
export function highestTier(
  tiers: readonly (string | undefined)[],
  constitution: Constitution = LEGACY_CONSTITUTION,
): string | undefined {
  let best: string | undefined
  let bestWeight = -Infinity
  for (const tier of tiers) {
    if (tier === undefined) continue
    const weight = weightFor(constitution, tier)
    if (weight > bestWeight) {
      best = tier
      bestWeight = weight
    }
  }
  return best
}

const PACKS = fileURLToPath(new URL("../../assets/domain-packs/", import.meta.url))

/**
 * Load a shipped pack by id. Unknown ids are an error, never a silent fallback
 * to the legacy constitution (legacy raised FileNotFoundError for the same
 * reason: a regulatory misconfiguration must not pass quietly). Whitespace is
 * stripped first, as legacy did.
 */
export async function loadDomainPack(id: string, options: { packsDir?: string } = {}): Promise<DomainPack> {
  const clean = id.trim()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) throw new Error(`domain pack not found: ${id}`)
  const file = path.join(options.packsDir ?? PACKS, `${clean}.json`)
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) throw new Error(`domain pack not found: ${id}`)
  return DomainPackSchema.parse(JSON.parse(text))
}

/** The claim-shaped fields the pack rules reason about (a dossier Claim satisfies this). */
export interface ConstitutionClaim {
  readonly id: string
  /** Empty or absent counts as untagged, for parity with legacy fixtures. */
  readonly tag?: string | undefined
  readonly status?: ClaimStatus | undefined
  readonly tier?: string | undefined
  readonly source?:
    | {
        readonly sha256?: string | undefined
        readonly quote?: string | undefined
        readonly url?: string | undefined
      }
    | undefined
  /** A verified code location is evidence too (1.x addition; legacy had sources only). */
  readonly location?: unknown
  readonly parents?: readonly string[] | undefined
  readonly reasoning?: string | undefined
  readonly falsification?: string | undefined
  readonly query?: string | undefined
  readonly finding?: string | undefined
  /** R11 full-key hash for NEGATIVE_KNOWLEDGE (set by normalizeClaim). */
  readonly nkKey?: string | undefined
}

export interface ClaimVerdict {
  readonly claimId: string
  readonly verdict: "ACCEPTED" | "REJECTED"
  readonly reasons: readonly string[]
}

export interface ClaimVerdictOptions {
  readonly constitution?: Constitution
  /** Every claim id in the dossier, for parent resolution (defaults to the claim alone). */
  readonly knownIds?: ReadonlySet<string>
  /** Source hashes with a retraction in the ledger. */
  readonly retractedHashes?: ReadonlySet<string>
}

/**
 * The per-claim ACCEPTED/REJECTED gate used by domain packs. A claim is
 * REJECTED when the legacy structural rules fire (VERIFIED needs its source
 * hash + verbatim quote or a code location; INFERRED needs its reasoning;
 * HYPOTHESIS needs its falsification; NEGATIVE_KNOWLEDGE needs query and
 * finding), when any pack rule fires (parent unresolved, missing mandatory
 * tag, banned domain), or when the retraction policy is zero_tolerance and
 * its source was retracted or its status is STALE/SUSPECT (downgrade
 * regardless of quote match or score).
 *
 * One legacy rule is deliberately not enforced: INFERRED's "parent_claims
 * non-empty". 1.x REPORT.md claims carry no parent ids (the dossier graph is
 * composed by the ranker), so enforcing it would reject every INFERRED line
 * under a pack; the PARENT_UNRESOLVED rule still fires whenever parents are
 * present and the known set says otherwise.
 */
export function claimVerdict(claim: ConstitutionClaim, options: ClaimVerdictOptions = {}): ClaimVerdict {
  const constitution = options.constitution ?? LEGACY_CONSTITUTION
  const reasons: string[] = []
  const known = options.knownIds ?? new Set([claim.id])
  for (const parent of claim.parents ?? [])
    if (!known.has(parent)) reasons.push(`PARENT_UNRESOLVED: parent_claims '${parent}' not in dossier set`)
  // Structural rules, ported from legacy check_invariants (R10: presence
  // checks are trim-based, never truthiness on non-strings).
  const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0
  if (claim.tag === "VERIFIED" && !claim.location) {
    if (!nonEmpty(claim.source?.sha256)) reasons.push("VERIFIED_REQUIRES_HASH: source_hash missing")
    if (!nonEmpty(claim.source?.quote)) reasons.push("VERIFIED_REQUIRES_QUOTE: verbatim_quote missing")
  }
  if (claim.tag === "INFERRED" && !nonEmpty(claim.reasoning))
    reasons.push("INFERRED_REQUIRES_LOGIC: deductive_logic missing")
  if (claim.tag === "HYPOTHESIS" && !nonEmpty(claim.falsification))
    reasons.push("HYPOTHESIS_REQUIRES_FALSIFICATION: falsification missing")
  if (claim.tag === "NEGATIVE_KNOWLEDGE") {
    if (!nonEmpty(claim.query)) reasons.push("NEG_KNOWLEDGE_REQUIRES_QUERY: query missing")
    if (!nonEmpty(claim.finding)) reasons.push("NEG_KNOWLEDGE_REQUIRES_FINDING: finding missing")
  }
  if (constitution.mandatoryTags.length && !claim.tag) reasons.push("MISSING_TAG: tag required by constitution")
  const url = claim.source?.url
  if (constitution.bannedDomains.length && typeof url === "string" && url) {
    const lower = url.toLowerCase()
    for (const domain of constitution.bannedDomains)
      if (lower.includes(domain.toLowerCase())) reasons.push(`BANNED_DOMAIN: source_url on banned domain '${domain}'`)
  }
  if (constitution.retractionPolicy === "zero_tolerance") {
    const sha = claim.source?.sha256
    if (typeof sha === "string" && sha && options.retractedHashes?.has(sha))
      reasons.push(`ZERO_TOLERANCE_RETRACTION: source ${sha} was retracted`)
    else if (claim.status === "STALE" || claim.status === "SUSPECT")
      reasons.push(`ZERO_TOLERANCE_RETRACTION: claim status ${claim.status}`)
  }
  return { claimId: claim.id, verdict: reasons.length ? "REJECTED" : "ACCEPTED", reasons }
}

export interface ScoreBreakdown {
  readonly totalClaimsAudited: number
  readonly verifiedPassed: number
  readonly unverifiedRejected: number
  readonly negativeKnowledgeCount: number
  readonly inferredCount: number
  readonly hypothesisCount: number
  readonly verifiedWeight: number
  readonly totalAssertions: number
  readonly rawScore: number
}

/**
 * The tier-aware E(D) score, ported from `compute_epistemic_score_from_claims`.
 * Verified claims contribute their tier weight when the constitution weights
 * any tier away from 1.0 (otherwise a flat 1.0, preserving legacy numbers);
 * rejected claims cost `rejectPenalty`; counted negative knowledge earns
 * `negBonus`. Valid, deduplicated NK rows only, via the M1 port of the legacy
 * normalized key. The score is clamped to [0, 1] and rounded to 3 places.
 */
export function computeEpistemicScoreFromClaims(
  claims: readonly ConstitutionClaim[],
  constitution: Constitution = LEGACY_CONSTITUTION,
): { score: number; breakdown: ScoreBreakdown } {
  let tierWeighted = false
  for (const weight of Object.values(constitution.tierWeights)) if (Math.abs(weight - 1) > 1e-7) tierWeighted = true

  // NEGATIVE_KNOWLEDGE: valid rows only (both sides non-empty after the R4
  // clean), deduplicated on the full-key hash when present (R11 — the stored
  // query/finding are capped copies, so the key is what keeps distinct
  // past-2k rows distinct); hand-built claims without a key fall back to the
  // cleaned stored pair.
  const seenNk = new Set<string>()
  let negKnowledge = 0
  for (const claim of claims) {
    if (claim.tag !== "NEGATIVE_KNOWLEDGE") continue
    const q = cleanNk(typeof claim.query === "string" ? claim.query : undefined)
    const f = cleanNk(typeof claim.finding === "string" ? claim.finding : undefined)
    if (!q || !f) continue
    const key = claim.nkKey ?? JSON.stringify([q, f])
    if (seenNk.has(key)) continue
    seenNk.add(key)
    negKnowledge++
  }
  const counts = { verified: 0, rejected: 0, inferred: 0, hypotheses: 0 }
  let weightSum = 0
  for (const claim of claims) {
    // NK rows are counted (valid and deduplicated) above, never here.
    if (claim.tag === "NEGATIVE_KNOWLEDGE") continue
    if (claim.status === "REJECTED" || claim.tag === "UNVERIFIED_REJECTED") counts.rejected++
    else if (claim.tag === "VERIFIED") {
      counts.verified++
      weightSum += tierWeighted ? weightFor(constitution, claim.tier) : 1
    } else if (claim.tag === "INFERRED") counts.inferred++
    else if (claim.tag === "HYPOTHESIS") counts.hypotheses++
  }
  const totalAssertions = Math.max(1, counts.verified + counts.inferred + counts.hypotheses + counts.rejected)
  const rawScore =
    (weightSum + constitution.negBonus * negKnowledge - constitution.rejectPenalty * counts.rejected) / totalAssertions
  const score = Math.max(0, Math.min(1, Math.round(rawScore * 1000) / 1000))
  return {
    score,
    breakdown: {
      totalClaimsAudited: counts.verified + counts.rejected,
      verifiedPassed: counts.verified,
      unverifiedRejected: counts.rejected,
      negativeKnowledgeCount: negKnowledge,
      inferredCount: counts.inferred,
      hypothesisCount: counts.hypotheses,
      verifiedWeight: weightSum,
      totalAssertions,
      rawScore,
    },
  }
}
