// Proof-Carrying Research Brief, ported from legacy runner/pcrb.py and
// runner/pcrb_verify.py: the research report, its claims (ranked, each with a
// fresh witness) and the cached sources they quote, bound by a manifest of
// member hashes and an HMAC from the user-global signing key. The verifier
// runs the legacy four checks — source identity, manifest integrity,
// signature, quotes — and fixes three legacy holes:
//   B3: a member deleted from the bundle went unnoticed (the manifest now lists
//       every member key), and alg:"none" was accepted even with a key (the
//       schema accepts only hmac-sha256);
//   B7: a prefix-hash citation bundled its source under the prefix (sources
//       are keyed by the full hash only);
//   B8: export and verify read keys in opposite precedence (one key: the
//       state-dir key the approvals use).
import { readFile } from "node:fs/promises"
import { hasSigningKey, signingKeyId, signRecord, verifyRecordMac } from "../approval/keystore.ts"
import { factoryLayout, stateDir } from "../layout.ts"
import { researchSourcesDir, SourceCache } from "../research/cache.ts"
import { verifyQuote } from "../research/quote.ts"
import { type Brief, BriefSchema, type Claim } from "../schema/claims.ts"
import { atomicWrite, readJson } from "../util/fs.ts"
import { hashJson, sha256 } from "../util/hash.ts"
import { claimId } from "./claim.ts"
import { rankClaims } from "./rank.ts"
import { ClaimStore } from "./store.ts"
import { witnessClaim } from "./witness.ts"

export interface ExportBriefOptions {
  readonly stateDir?: string
  /** Where to write the brief (default .factory/research/brief.pcrb.json). */
  readonly out?: string
  readonly now?: () => Date
}

const signedBody = (brief: Pick<Brief, "pcrbVersion" | "objective" | "exportedAt" | "manifest">) => ({
  pcrbVersion: brief.pcrbVersion,
  objective: brief.objective,
  exportedAt: brief.exportedAt,
  manifest: brief.manifest,
})

const membersOf = (brief: Pick<Brief, "claims" | "sources">) =>
  [
    "synthesis",
    ...brief.claims.map((claim) => `claim:${claim.id}`),
    ...Object.keys(brief.sources).map((hash) => `source:${hash}`),
  ].sort()

export async function exportBrief(
  root: string,
  options: ExportBriefOptions = {},
): Promise<{ file: string; brief: Brief }> {
  const layout = factoryLayout(root)
  const synthesis = await readFile(layout.researchReport, "utf8").catch(() => {
    throw new Error("No research report yet (.factory/research/REPORT.md).")
  })
  const store = await ClaimStore.load(root)
  const research = store.dossiers.find((item) => item.dossier.mode === "research")
  if (!research) throw new Error("No research dossier yet: es_research_complete writes .factory/research/dossier.json.")
  const cache = new SourceCache(researchSourcesDir(root))
  const now = options.now ?? (() => new Date())
  const known = new Set(research.dossier.claims.map((claim) => claim.id))
  const witnesses = new Map(
    await Promise.all(
      research.dossier.claims.map(
        async (claim) => [claim.id, await witnessClaim(claim, { cache, known, now })] as const,
      ),
    ),
  )
  const ranked = rankClaims(research.dossier.claims, { witnesses, lookup: (id) => store.get(id) })
  const claims = ranked.map((item) => ({ ...item.claim, witness: witnesses.get(item.claim.id)! }))
  const sources: Brief["sources"] = {}
  for (const claim of claims) {
    if (!claim.source || !claim.witness.ok || sources[claim.source.sha256]) continue
    const cached = await cache.get(claim.source.sha256)
    if (cached)
      sources[cached.meta.sha256] = {
        url: cached.meta.url,
        ...(cached.meta.title ? { title: cached.meta.title } : {}),
        retrieved: cached.meta.retrieved,
        content: cached.text,
      }
  }
  const frontier = await readJson<{ idea?: string }>(layout.frontier).catch(() => undefined)
  const unsigned = {
    pcrbVersion: "1.1" as const,
    objective: frontier?.idea ?? research.dossier.subject,
    exportedAt: now().toISOString(),
    synthesis,
    claims,
    sources,
    manifest: {
      synthesis: sha256(synthesis),
      claims: Object.fromEntries(claims.map((claim) => [claim.id, hashJson(claim)])),
      sources: Object.fromEntries(Object.entries(sources).map(([hash, source]) => [hash, sha256(source.content)])),
      members: membersOf({ claims, sources }),
    },
  }
  const dir = options.stateDir ?? stateDir()
  const brief = BriefSchema.parse({
    ...unsigned,
    signature: {
      alg: "hmac-sha256",
      keyId: await signingKeyId(dir),
      mac: await signRecord(signedBody(unsigned), dir),
    },
  })
  const file = options.out ?? layout.researchBrief
  await atomicWrite(file, `${JSON.stringify(brief, null, 2)}\n`)
  return { file, brief }
}

export type BriefCheck = "schema" | "source-identity" | "manifest" | "signature" | "quotes"

export interface BriefVerification {
  readonly ok: boolean
  readonly failures: ReadonlyArray<{ check: BriefCheck; member?: string; message: string }>
  readonly checks: {
    readonly sourceIdentity: "pass" | "fail"
    readonly manifest: "pass" | "fail"
    /** valid: this machine's key signed it. unverifiable: signed by a key this machine does not hold. */
    readonly signature: "valid" | "invalid" | "unverifiable"
    readonly quotes: "pass" | "fail"
  }
  readonly stats: {
    readonly claims: number
    readonly sources: number
    readonly quotesVerified: number
    readonly quotesFailed: number
  }
}

export async function verifyBrief(
  raw: unknown,
  options: { stateDir?: string; allowUnverifiable?: boolean } = {},
): Promise<BriefVerification> {
  const parsed = BriefSchema.safeParse(raw)
  if (!parsed.success)
    return {
      ok: false,
      failures: parsed.error.issues.map((issue) => ({
        check: "schema" as const,
        message: `${issue.path.join(".") || "brief"}: ${issue.message}`,
      })),
      checks: { sourceIdentity: "fail", manifest: "fail", signature: "invalid", quotes: "fail" },
      stats: { claims: 0, sources: 0, quotesVerified: 0, quotesFailed: 0 },
    }
  const brief = parsed.data
  const failures: Array<{ check: BriefCheck; member?: string; message: string }> = []
  const fail = (check: BriefCheck, message: string, member?: string) =>
    failures.push({ check, message, ...(member ? { member } : {}) })

  // 1. Source identity: a cached source is named by the hash of its content.
  for (const [hash, source] of Object.entries(brief.sources))
    if (sha256(source.content) !== hash) fail("source-identity", "content does not hash to its key", `source:${hash}`)

  // 2. Manifest integrity: every member hashes as recorded, and nothing was added or removed.
  if (sha256(brief.synthesis) !== brief.manifest.synthesis) fail("manifest", "synthesis changed", "synthesis")
  for (const claim of brief.claims) {
    const { id: _id, status: _status, witness: _witness, ...content } = claim
    if (claimId(content) !== claim.id) fail("manifest", "claim content does not match its id", `claim:${claim.id}`)
    if (brief.manifest.claims[claim.id] !== hashJson(claim)) fail("manifest", "claim changed", `claim:${claim.id}`)
  }
  for (const [hash, source] of Object.entries(brief.sources))
    if (brief.manifest.sources[hash] !== sha256(source.content)) fail("manifest", "source changed", `source:${hash}`)
  const present = new Set(membersOf(brief))
  const listed = new Set(brief.manifest.members)
  for (const member of listed) if (!present.has(member)) fail("manifest", "member was removed from the bundle", member)
  for (const member of present) if (!listed.has(member)) fail("manifest", "member is not in the manifest", member)
  for (const id of Object.keys(brief.manifest.claims))
    if (!present.has(`claim:${id}`)) fail("manifest", "member was removed from the bundle", `claim:${id}`)
  for (const hash of Object.keys(brief.manifest.sources))
    if (!present.has(`source:${hash}`)) fail("manifest", "member was removed from the bundle", `source:${hash}`)

  // 3. Signature: only a key this machine holds can vouch for the manifest.
  const dir = options.stateDir ?? stateDir()
  let signature: BriefVerification["checks"]["signature"] = "unverifiable"
  if ((await hasSigningKey(dir)) && (await signingKeyId(dir)) === brief.signature.keyId)
    signature = (await verifyRecordMac({ ...signedBody(brief), mac: brief.signature.mac }, dir)) ? "valid" : "invalid"
  if (signature === "invalid") fail("signature", "the manifest signature does not match")
  if (signature === "unverifiable" && !options.allowUnverifiable)
    fail(
      "signature",
      `signed by key ${brief.signature.keyId}, which this machine does not hold; only integrity can be checked (allow unverifiable to accept that)`,
    )

  // 4. Quotes: every claim the brief calls witnessed must quote its bundled source verbatim.
  let quotesVerified = 0
  let quotesFailed = 0
  for (const claim of brief.claims as Claim[]) {
    if (!claim.source) continue
    if (!claim.witness?.ok) {
      quotesFailed++
      continue
    }
    const source = brief.sources[claim.source.sha256]
    const check = source ? verifyQuote(source.content, claim.source.quote) : { ok: false, reason: "source not bundled" }
    if (check.ok) quotesVerified++
    else {
      quotesFailed++
      fail("quotes", `quote ${check.reason}`, `claim:${claim.id}`)
    }
  }

  const failed = (check: BriefCheck) => failures.some((item) => item.check === check)
  return {
    ok: failures.length === 0,
    failures,
    checks: {
      sourceIdentity: failed("source-identity") ? "fail" : "pass",
      manifest: failed("manifest") ? "fail" : "pass",
      signature,
      quotes: failed("quotes") ? "fail" : "pass",
    },
    stats: { claims: brief.claims.length, sources: Object.keys(brief.sources).length, quotesVerified, quotesFailed },
  }
}
