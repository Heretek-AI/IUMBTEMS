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
import { normalizeNegativeKnowledge } from "./claim.ts"

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
  readonly source?: { readonly sha256?: string | undefined; readonly url?: string | undefined } | undefined
  readonly parents?: readonly string[] | undefined
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
 * REJECTED when any pack rule fires under this constitution (parent
 * unresolved, missing mandatory tag, banned domain), or when the retraction
 * policy is zero_tolerance and its source was retracted or its status is
 * STALE/SUSPECT (downgrade regardless of quote match or score).
 */
export function claimVerdict(claim: ConstitutionClaim, options: ClaimVerdictOptions = {}): ClaimVerdict {
  const constitution = options.constitution ?? LEGACY_CONSTITUTION
  const reasons: string[] = []
  const known = options.knownIds ?? new Set([claim.id])
  for (const parent of claim.parents ?? [])
    if (!known.has(parent)) reasons.push(`PARENT_UNRESOLVED: parent_claims '${parent}' not in dossier set`)
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

  const nk = normalizeNegativeKnowledge(
    claims
      .filter((claim) => claim.tag === "NEGATIVE_KNOWLEDGE")
      .map((claim) => claim as { query?: unknown; finding?: unknown }),
  )
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
    (weightSum + constitution.negBonus * nk.valid.length - constitution.rejectPenalty * counts.rejected) /
    totalAssertions
  const score = Math.max(0, Math.min(1, Math.round(rawScore * 1000) / 1000))
  return {
    score,
    breakdown: {
      totalClaimsAudited: counts.verified + counts.rejected,
      verifiedPassed: counts.verified,
      unverifiedRejected: counts.rejected,
      negativeKnowledgeCount: nk.valid.length,
      inferredCount: counts.inferred,
      hypothesisCount: counts.hypotheses,
      verifiedWeight: weightSum,
      totalAssertions,
      rawScore,
    },
  }
}
