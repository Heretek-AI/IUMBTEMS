// Dossiers: the shape every evidence-producing mode emits (research now; code
// audit and scout in M2). Ported from legacy runner/schemas.py's dossier
// contract, flattened: one claims[] with tags instead of per-section arrays.
// Writing a dossier witnesses every claim and refuses the whole dossier when
// any witness fails, so no tool can persist an unchecked VERIFIED claim.
import type { SourceCache } from "../research/cache.ts"
import { type Claim, type Dossier, type DossierMode, DossierSchema } from "../schema/claims.ts"
import { readJson, withLock, writeJson } from "../util/fs.ts"
import { hashJson } from "../util/hash.ts"
import { witnessClaim } from "./witness.ts"

export class DossierRefusal extends Error {
  constructor(readonly failures: ReadonlyArray<{ id: string; statement: string; reason: string }>) {
    super(
      `Refused: ${failures.length} claim(s) failed their witness check.\n${failures
        .slice(0, 25)
        .map((item) => `- ${item.statement.slice(0, 100)} — ${item.reason}`)
        .join("\n")}`,
    )
  }
}

/** sha256 over the sorted claim ids and the cached sources they cite. */
export function evidenceHash(claims: readonly Claim[]): string {
  const ids = [...new Set(claims.map((claim) => claim.id))].sort()
  const sources = [...new Set(claims.flatMap((claim) => (claim.source ? [claim.source.sha256] : [])))].sort()
  return hashJson({ claims: ids, sources })
}

export function buildDossier(input: {
  mode: DossierMode
  subject: string
  claims: readonly Claim[]
  verdicts?: Dossier["verdicts"]
  now?: Date
}): Dossier {
  const unique = [...new Map(input.claims.map((claim) => [claim.id, claim])).values()]
  return DossierSchema.parse({
    version: "1.1",
    mode: input.mode,
    subject: input.subject,
    createdAt: (input.now ?? new Date()).toISOString(),
    claims: unique,
    verdicts: input.verdicts ?? [],
    evidenceHash: evidenceHash(unique),
  })
}

/** Witness every claim (recording the result on it), refusing if any fails; then write atomically under a lock. */
export async function writeDossier(
  file: string,
  dossier: Dossier,
  options: { cache: SourceCache; root?: string; now?: () => Date },
): Promise<Dossier> {
  const known = new Set(dossier.claims.map((claim) => claim.id))
  const witnessed: Claim[] = []
  const failures: Array<{ id: string; statement: string; reason: string }> = []
  for (const claim of dossier.claims) {
    const witness = await witnessClaim(claim, { ...options, known })
    if (!witness.ok) failures.push({ id: claim.id, statement: claim.statement, reason: witness.reason ?? "failed" })
    witnessed.push({ ...claim, witness })
  }
  if (failures.length) throw new DossierRefusal(failures)
  const checked = DossierSchema.parse({ ...dossier, claims: witnessed })
  await withLock(file, () => writeJson(file, checked))
  return checked
}

export async function readDossier(file: string): Promise<Dossier | undefined> {
  const raw = await readJson(file)
  if (raw === undefined) return undefined
  const parsed = DossierSchema.safeParse(raw)
  // Dossiers are control files written only by core: a bad one is an error, never skipped.
  if (!parsed.success)
    throw new Error(`${file} is not a valid dossier: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`)
  return parsed.data
}
