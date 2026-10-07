// ClaimStore: an in-memory index over the dossier files plus the retraction
// ledger. Legacy runner/claim_store.py was a SQLite FTS index that could be
// deleted and rebuilt from the same files; the files stay the source of truth
// here too, so no database is needed (the CLI must run on Node 22).
import { readdir } from "node:fs/promises"
import { factoryLayout } from "../layout.ts"
import type { SourceCache } from "../research/cache.ts"
import type { Claim, Dossier, Witness } from "../schema/claims.ts"
import { sha256 } from "../util/hash.ts"
import { applyDegradation, readRetractions, type StatusEvent } from "./degrade.ts"
import { readDossier } from "./dossier.ts"
import { witnessClaim } from "./witness.ts"

/** Dossier files the store indexes: research, every code audit, the scout. All are control files. */
export async function dossierFiles(root: string): Promise<string[]> {
  const layout = factoryLayout(root)
  const audits = (await readdir(layout.audits).catch(() => [] as string[])).sort().map((id) => layout.auditDossier(id))
  return [layout.researchDossier, ...audits, layout.scoutDossier]
}

export interface LoadedDossier {
  readonly file: string
  readonly dossier: Dossier
}

export class ClaimStore {
  private readonly byId = new Map<string, Claim>()
  private readonly where = new Map<string, string[]>()

  private constructor(
    readonly dossiers: readonly LoadedDossier[],
    readonly events: readonly StatusEvent[],
    claims: readonly Claim[],
  ) {
    for (const claim of claims) if (!this.byId.has(claim.id)) this.byId.set(claim.id, claim)
    for (const { file, dossier } of dossiers)
      for (const claim of dossier.claims) this.where.set(claim.id, [...(this.where.get(claim.id) ?? []), file])
  }

  /** Index every dossier present, with retractions applied. Corrupt files throw; missing ones are skipped. */
  static async load(root: string): Promise<ClaimStore> {
    const loaded: LoadedDossier[] = []
    for (const file of await dossierFiles(root)) {
      const dossier = await readDossier(file)
      if (dossier) loaded.push({ file, dossier })
    }
    return ClaimStore.from(loaded, await readRetractions(root))
  }

  static from(dossiers: readonly LoadedDossier[], retractions: Parameters<typeof applyDegradation>[1]): ClaimStore {
    const degraded = dossiers.map(({ file, dossier }) => {
      const result = applyDegradation(dossier.claims, retractions)
      return { file, dossier: { ...dossier, claims: result.claims }, events: result.events }
    })
    const events = [...new Map(degraded.flatMap((item) => item.events).map((event) => [event.claim, event])).values()]
    return new ClaimStore(
      degraded.map(({ file, dossier }) => ({ file, dossier })),
      events,
      degraded.flatMap((item) => item.dossier.claims),
    )
  }

  get size(): number {
    return this.byId.size
  }

  get(id: string): Claim | undefined {
    return this.byId.get(id)
  }

  all(): Claim[] {
    return [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /** Dossier files that contain the claim. */
  files(id: string): readonly string[] {
    return this.where.get(id) ?? []
  }

  citing(sourceHash: string): Claim[] {
    return this.all().filter((claim) => claim.source?.sha256 === sourceHash)
  }

  /** Case-insensitive substring search over statements (legacy fell back to LIKE when FTS missed). */
  search(text: string): Claim[] {
    const needle = text.trim().toLowerCase()
    if (!needle) return []
    return this.all().filter((claim) => claim.statement.toLowerCase().includes(needle))
  }

  /** Order-independent fingerprint of what the store knows: id, tag and (degraded) status. */
  fingerprint(): string {
    return sha256(
      this.all()
        .map((claim) => `${claim.id}:${claim.tag}:${claim.status}`)
        .join("|"),
    )
  }

  /** Re-check every claim against the cache (and code under `root`). */
  async witnessAll(cache: SourceCache, root?: string): Promise<Map<string, Witness>> {
    const known = new Set(this.byId.keys())
    const out = new Map<string, Witness>()
    for (const claim of this.all())
      out.set(claim.id, await witnessClaim(claim, { cache, known, ...(root ? { root } : {}) }))
    return out
  }
}
