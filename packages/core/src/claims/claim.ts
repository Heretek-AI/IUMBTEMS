// Claim normalisation, ported from legacy runner/claim_witness.py
// (normalize_claim, normalize_negative_knowledge_rows). Differences on purpose:
// ids are content hashes, never "UNKNOWN" (legacy bug B2: every NK row
// collided), and an empty or unknown tag is an error instead of a value a
// later check has to catch.
import { type Claim, type ClaimLocation, ClaimSchema, type ClaimTag, ClaimTagSchema } from "../schema/claims.ts"
import { hashJson } from "../util/hash.ts"

export type ClaimKind = "claim" | "inference" | "hypothesis" | "negative_knowledge"

export interface ClaimInput {
  readonly kind?: ClaimKind
  readonly tag?: string | null
  readonly statement?: string
  readonly source?: { readonly sha256: string; readonly quote: string }
  readonly location?: ClaimLocation
  readonly parents?: string | readonly string[]
  readonly reasoning?: string
  readonly falsification?: string
  readonly query?: string
  readonly finding?: string
  readonly severity?: Claim["severity"]
}

/** The claim is malformed; the message says why (model- and human-facing). */
export class ClaimError extends Error {}

const KIND_TAG: Record<ClaimKind, ClaimTag> = {
  claim: "VERIFIED",
  inference: "INFERRED",
  hypothesis: "HYPOTHESIS",
  negative_knowledge: "NEGATIVE_KNOWLEDGE",
}

/** Legacy NK_MAX_FIELD_LEN, counted in code points as Python's len() does. */
export const NK_MAX_FIELD = 2000

const cleanNk = (text: string | undefined) => (text ?? "").replace(/\p{Cf}/gu, "").trim()
const cap = (text: string, max = NK_MAX_FIELD) => {
  const points = [...text]
  return points.length > max ? points.slice(0, max).join("") : text
}

/** Content fields only: status and witness change over time, the claim does not. */
export function claimId(claim: Omit<Claim, "id" | "status" | "witness">): string {
  const { tag, statement, source, location, parents, reasoning, falsification, query, finding, severity } = claim
  return hashJson({
    tag,
    statement,
    source,
    location,
    parents: parents ? [...parents].sort() : undefined,
    reasoning,
    falsification,
    query,
    finding,
    severity,
  })
}

function tagOf(raw: ClaimInput): ClaimTag {
  const kind = raw.kind ?? "claim"
  // An NK row is NK whatever tag it claims (legacy: tag spoofing loses to kind).
  if (kind === "negative_knowledge") return "NEGATIVE_KNOWLEDGE"
  if (raw.tag === undefined || raw.tag === null) return KIND_TAG[kind]
  const parsed = ClaimTagSchema.safeParse(String(raw.tag).trim().toUpperCase())
  if (!parsed.success)
    throw new ClaimError(
      raw.tag.trim()
        ? `unknown epistemic tag "${raw.tag}" (VERIFIED, INFERRED, HYPOTHESIS or NEGATIVE_KNOWLEDGE)`
        : "the claim has no epistemic tag",
    )
  return parsed.data
}

const parentsOf = (parents: ClaimInput["parents"]): string[] | undefined => {
  if (parents === undefined) return undefined
  const list = typeof parents === "string" ? [parents] : [...parents].map(String)
  return list.length ? [...new Set(list)] : undefined
}

export function normalizeClaim(raw: ClaimInput): Claim {
  const tag = tagOf(raw)
  let { query, finding } = raw
  let statement = (raw.statement ?? "").trim()
  if (tag === "NEGATIVE_KNOWLEDGE") {
    query = cap(cleanNk(query))
    finding = cap(cleanNk(finding))
    if (!query || !finding)
      throw new ClaimError("NEGATIVE_KNOWLEDGE needs both what was searched (query) and what was found (finding)")
    statement = cap(cleanNk(statement) || finding)
  }
  if (!statement) throw new ClaimError("the claim has no statement")
  const content = {
    tag,
    statement,
    ...(raw.source ? { source: { sha256: raw.source.sha256, quote: raw.source.quote } } : {}),
    ...(raw.location ? { location: raw.location } : {}),
    ...(parentsOf(raw.parents) ? { parents: parentsOf(raw.parents)! } : {}),
    ...(raw.reasoning?.trim() ? { reasoning: raw.reasoning.trim() } : {}),
    ...(raw.falsification?.trim() ? { falsification: raw.falsification.trim() } : {}),
    ...(tag === "NEGATIVE_KNOWLEDGE" ? { query, finding } : {}),
    ...(raw.severity ? { severity: raw.severity } : {}),
  }
  const parsed = ClaimSchema.safeParse({ id: claimId(content), status: "LIVE", ...content })
  if (!parsed.success)
    throw new ClaimError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "claim"}: ${issue.message}`).join("; "),
    )
  return parsed.data
}

/**
 * Valid NK claims from raw rows, deduplicated on the full cleaned
 * (query, finding) pair before truncation, as legacy did. `dropped` counts
 * malformed rows (missing, non-string or invisible-only sides, non-objects)
 * and duplicates.
 */
export function normalizeNegativeKnowledge(rows: unknown): { valid: Claim[]; dropped: number } {
  if (rows === undefined || rows === null) return { valid: [], dropped: 0 }
  const list = Array.isArray(rows) ? rows : typeof rows === "object" ? [rows] : undefined
  if (!list) return { valid: [], dropped: 1 }
  const seen = new Set<string>()
  const valid: Claim[] = []
  let dropped = 0
  for (const row of list) {
    if (!row || typeof row !== "object") {
      dropped++
      continue
    }
    const { query, finding, statement } = row as Record<string, unknown>
    if (typeof query !== "string" || typeof finding !== "string") {
      dropped++
      continue
    }
    const key = JSON.stringify([cleanNk(query), cleanNk(finding)])
    try {
      const claim = normalizeClaim({
        kind: "negative_knowledge",
        query,
        finding,
        ...(typeof statement === "string" ? { statement } : {}),
      })
      if (seen.has(key)) {
        dropped++
        continue
      }
      seen.add(key)
      valid.push(claim)
    } catch {
      dropped++
    }
  }
  return { valid, dropped }
}
