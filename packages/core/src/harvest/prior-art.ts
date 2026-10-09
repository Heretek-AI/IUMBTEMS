// The record of prior-art searches: what es_harvest_prior_art actually found.
// It lives under .factory/runtime (a control dir no agent may write), so a
// brainstorm can only cite prior art that a search returned. Records validate
// on write and on read (#109): a corrupt record is refused, never trusted.
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import { type PriorArtSearch, PriorArtSearchSchema } from "../schema/harvest.ts"
import { readJson, writeJson } from "../util/fs.ts"

export type { PriorArtSearch }

const recordFile = (root: string) => path.join(factoryLayout(root).runtime, "harvest", "prior-art.json")

export async function readPriorArt(root: string): Promise<PriorArtSearch[]> {
  const raw = (await readJson<unknown[]>(recordFile(root)).catch(() => undefined)) ?? []
  // Corrupt entries are dropped, never trusted; writers are refused outright.
  return raw.flatMap((entry) => {
    const parsed = PriorArtSearchSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/** Add searches to the record (latest search per run+idea wins). */
export async function recordPriorArt(root: string, searches: readonly PriorArtSearch[]): Promise<void> {
  for (const search of searches) {
    const parsed = PriorArtSearchSchema.safeParse(search)
    if (!parsed.success) throw new Error(`invalid prior-art search: ${parsed.error.message}`)
  }
  const keys = new Set(searches.map((search) => `${search.run ?? ""}::${search.idea}`))
  const kept = (await readPriorArt(root)).filter((search) => !keys.has(`${search.run ?? ""}::${search.idea}`))
  await writeJson(recordFile(root), [...kept, ...searches])
}

/**
 * URLs any recorded, successful search returned. A brainstorm run sees its
 * own searches plus legacy global records (written before runs); other runs'
 * searches do not satisfy it.
 */
export async function priorArtUrls(root: string, run?: string): Promise<Set<string>> {
  return new Set(
    (await readPriorArt(root))
      .filter((search) => search.status === "ok" && (search.run === undefined || search.run === run))
      .flatMap((search) => search.results.map((result) => result.url)),
  )
}
