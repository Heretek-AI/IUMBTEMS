// Read-only evidence reads (#133): claims, claim detail with quote
// ranges, sources with seal status, and renderer exports. Everything here
// reads: dossiers, the retraction ledger, the content-addressed source
// files and the engine key (verification only, never created). Payloads
// are capped so one giant source cannot wedge the browser.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  type Claim,
  ClaimStore,
  explainClaimRank,
  locateQuote,
  type QuoteRange,
  type Retraction,
  rankClaims,
  readEngineKey,
  readRetractions,
  renderResearchRun,
  researchSourcesDir,
  type StatusEvent,
  verifyMetaSeal,
} from "@heretek-ai/es-core"

/** Claim list cap (the UI filters; the full ledger stays on disk). */
export const MAX_CLAIMS = 200
/** Source text cap per payload (characters). */
export const SOURCE_TEXT_CAP = 200_000
/** Export body cap (characters). */
export const EXPORT_CAP = 2_000_000

export interface EvidenceClaimFilter {
  readonly tag?: string
  readonly status?: string
  readonly tier?: string
  readonly text?: string
}

export interface EvidenceClaimSummary {
  readonly id: string
  readonly tag: string
  readonly status: string
  readonly statement: string
  readonly sourceSha: string | null
  readonly tier?: string
}

export interface EvidenceQuote {
  readonly quote: string
  readonly verified: boolean
  readonly ranges: readonly QuoteRange[]
}

export interface EvidenceClaimDetail {
  readonly claim: Claim
  readonly quotes: readonly EvidenceQuote[]
  readonly retractions: readonly Retraction[]
  readonly events: readonly StatusEvent[]
  readonly rankExplanation: string
  readonly files: readonly string[]
}

export type SealStatus = "sealed" | "unsealed" | "invalid" | "unknown"

export interface EvidenceSourceView {
  readonly meta: {
    readonly sha256: string
    readonly url: string
    readonly title?: string
    readonly retrieved: string
    readonly provider: string
    readonly bytes: number
    readonly tier?: string
  }
  readonly seal: SealStatus
  readonly text: string
  readonly truncated: boolean
}

const summaryOf = (claim: Claim): EvidenceClaimSummary => ({
  id: claim.id,
  tag: claim.tag,
  status: claim.status,
  statement: claim.statement,
  sourceSha: claim.source?.sha256 ?? null,
  ...(claim.tier ? { tier: claim.tier } : {}),
})

/** List degraded claims with optional tag/status/tier/text narrowing. */
export async function readEvidenceClaims(
  repoDir: string,
  filter: EvidenceClaimFilter,
): Promise<{ claims: EvidenceClaimSummary[]; truncated: boolean }> {
  const store = await ClaimStore.load(repoDir)
  let claims = store.all()
  if (filter.tag) claims = claims.filter((claim) => claim.tag === filter.tag)
  if (filter.status) claims = claims.filter((claim) => claim.status === filter.status)
  if (filter.tier) {
    const tier = filter.tier
    claims = claims.filter((claim) => (claim.tier ?? "__default__") === tier)
  }
  const text = filter.text?.trim()
  if (text) claims = store.search(text).filter((claim) => claims.includes(claim))
  const truncated = claims.length > MAX_CLAIMS
  return { claims: claims.slice(0, MAX_CLAIMS).map(summaryOf), truncated }
}

const sourceFile = (repoDir: string, sha: string, ext: "md" | "json"): string =>
  path.join(researchSourcesDir(repoDir), `${sha}.${ext}`)

const readSourceText = async (repoDir: string, sha: string): Promise<string | undefined> => {
  if (!/^[0-9a-f]{64}$/.test(sha)) return undefined
  const text = await readFile(sourceFile(repoDir, sha, "md"), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  // Content-addressed: bytes that no longer hash to their name were tampered with.
  if (createHash("sha256").update(text).digest("hex") !== sha) return undefined
  return text
}

const readSourceMeta = async (repoDir: string, sha: string): Promise<Record<string, unknown> | undefined> => {
  if (!/^[0-9a-f]{64}$/.test(sha)) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(sourceFile(repoDir, sha, "json"), "utf8"))
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

/** One claim with its quote ranges, retractions, events and rank. */
export async function readEvidenceClaim(repoDir: string, id: string): Promise<EvidenceClaimDetail | null> {
  const store = await ClaimStore.load(repoDir)
  const claim = store.get(id)
  if (!claim) return null
  const quotes: EvidenceQuote[] = []
  if (claim.source) {
    const text = await readSourceText(repoDir, claim.source.sha256)
    const ranges = text === undefined ? undefined : locateQuote(text, claim.source.quote)
    quotes.push({ quote: claim.source.quote, verified: ranges !== undefined, ranges: ranges ?? [] })
  }
  const sha = claim.source?.sha256
  const retractions = sha
    ? (await readRetractions(repoDir).catch(() => [] as Retraction[])).filter((entry) => entry.source === sha)
    : []
  const ranked = rankClaims(store.all()).find((item) => item.claim.id === id)
  return {
    claim,
    quotes,
    retractions,
    events: store.events.filter((event) => event.claim === id),
    rankExplanation: ranked ? explainClaimRank(ranked) : `#? ${claim.tag} — ${claim.statement.slice(0, 80)}`,
    files: [...store.files(id)],
  }
}

/** One source with its text (capped) and seal status. Reads only. */
export async function readEvidenceSource(
  repoDir: string,
  stateRoot: string,
  sha: string,
): Promise<EvidenceSourceView | null> {
  const text = await readSourceText(repoDir, sha)
  if (text === undefined) return null
  const meta = (await readSourceMeta(repoDir, sha)) ?? {}
  const key = await readEngineKey(stateRoot).catch(() => undefined)
  const seal: SealStatus =
    key === undefined
      ? "unknown"
      : typeof meta.seal !== "string"
        ? "unsealed"
        : verifyMetaSeal(meta, key)
          ? "sealed"
          : "invalid"
  const url = typeof meta.url === "string" ? meta.url : ""
  return {
    meta: {
      sha256: sha,
      url,
      ...(typeof meta.title === "string" ? { title: meta.title } : {}),
      ...(typeof meta.retrieved === "string" ? { retrieved: meta.retrieved } : { retrieved: "" }),
      ...(typeof meta.provider === "string" ? { provider: meta.provider } : { provider: "unknown" }),
      ...(typeof meta.bytes === "number" ? { bytes: meta.bytes } : { bytes: text.length }),
      ...(typeof meta.tier === "string" ? { tier: meta.tier } : {}),
    },
    seal,
    text: text.length > SOURCE_TEXT_CAP ? text.slice(0, SOURCE_TEXT_CAP) : text,
    truncated: text.length > SOURCE_TEXT_CAP,
  }
}

/** Render the run's dossier with the #112 renderers (pure read + render). */
export async function exportEvidence(
  repoDir: string,
  stateRoot: string,
  format: "markdown" | "html",
): Promise<{ format: string; body: string; truncated: boolean } | null> {
  let body: string
  try {
    body = await renderResearchRun(repoDir, { format: format === "html" ? "html" : "md", stateDir: stateRoot })
  } catch {
    return null
  }
  return {
    format,
    body: body.length > EXPORT_CAP ? body.slice(0, EXPORT_CAP) : body,
    truncated: body.length > EXPORT_CAP,
  }
}
