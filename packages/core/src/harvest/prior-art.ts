// The record of prior-art searches: what es_harvest_prior_art actually found.
// It lives under .factory/runtime (a control dir no agent may write), so a
// brainstorm can only cite prior art that a search returned.
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import { readJson, writeJson } from "../util/fs.ts"

export interface PriorArtSearch {
  readonly idea: string
  readonly query: string
  readonly status: "ok" | "failed"
  readonly results: ReadonlyArray<{ readonly title: string; readonly url: string }>
  readonly searchedAt: string
}

const recordFile = (root: string) => path.join(factoryLayout(root).runtime, "harvest", "prior-art.json")

export async function readPriorArt(root: string): Promise<PriorArtSearch[]> {
  return (await readJson<PriorArtSearch[]>(recordFile(root)).catch(() => undefined)) ?? []
}

/** Add searches to the record (latest search per idea wins). */
export async function recordPriorArt(root: string, searches: readonly PriorArtSearch[]): Promise<void> {
  const ideas = new Set(searches.map((search) => search.idea))
  const kept = (await readPriorArt(root)).filter((search) => !ideas.has(search.idea))
  await writeJson(recordFile(root), [...kept, ...searches])
}

/** URLs any recorded, successful search returned. */
export async function priorArtUrls(root: string): Promise<Set<string>> {
  return new Set(
    (await readPriorArt(root))
      .filter((search) => search.status === "ok")
      .flatMap((search) => search.results.map((result) => result.url)),
  )
}
