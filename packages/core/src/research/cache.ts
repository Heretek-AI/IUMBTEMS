// Content-addressed source cache: <dir>/<sha256>.md holds the exact text a
// claim may quote; <sha256>.json holds where it came from. Identical content
// shares one entry; the URL index maps URLs to their latest snapshot.
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import { atomicWrite, readJson } from "../util/fs.ts"
import { sha256 } from "../util/hash.ts"

export interface SourceMeta {
  readonly sha256: string
  readonly url: string
  readonly title?: string
  readonly retrieved: string
  /** Search provider or "fetch". */
  readonly provider: string
  readonly query?: string
  readonly bytes: number
}

export interface CachedSource {
  readonly meta: SourceMeta
  readonly text: string
  readonly path: string
}

/** Default cache dir for a project: tracked next to the research report, so citations stay verifiable in review. */
export const researchSourcesDir = (root: string) => path.join(factoryLayout(root).research, "sources")

/** Normalise line endings and trailing whitespace so hashing is stable across platforms. */
export const normalizeSourceText = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

const MAX_SOURCE_BYTES = 400_000

export class SourceCache {
  constructor(readonly dir: string) {}

  async put(input: {
    url: string
    text: string
    title?: string
    provider: string
    query?: string
  }): Promise<CachedSource> {
    let text = normalizeSourceText(input.text)
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES)
      text = `${Buffer.from(text).subarray(0, MAX_SOURCE_BYTES).toString("utf8")}\n\n[truncated by epistemic-swarm at ${MAX_SOURCE_BYTES} bytes]`
    const hash = sha256(text)
    const meta: SourceMeta = {
      sha256: hash,
      url: input.url,
      ...(input.title ? { title: input.title } : {}),
      retrieved: new Date().toISOString(),
      provider: input.provider,
      ...(input.query ? { query: input.query } : {}),
      bytes: Buffer.byteLength(text),
    }
    const file = path.join(this.dir, `${hash}.md`)
    await atomicWrite(file, text)
    await atomicWrite(path.join(this.dir, `${hash}.json`), `${JSON.stringify(meta, null, 2)}\n`)
    const index = (await readJson<Record<string, string>>(path.join(this.dir, "index.json"))) ?? {}
    index[input.url] = hash
    await atomicWrite(path.join(this.dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`)
    return { meta, text, path: file }
  }

  async get(hash: string): Promise<CachedSource | undefined> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined
    const file = path.join(this.dir, `${hash}.md`)
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) return undefined
    const meta = (await readJson<SourceMeta>(path.join(this.dir, `${hash}.json`))) ?? {
      sha256: hash,
      url: "",
      retrieved: "",
      provider: "unknown",
      bytes: text.length,
    }
    // A source whose bytes no longer hash to its name was tampered with: refuse it.
    if (sha256(text) !== hash) return undefined
    return { meta, text, path: file }
  }

  async byUrl(url: string): Promise<CachedSource | undefined> {
    const index = (await readJson<Record<string, string>>(path.join(this.dir, "index.json"))) ?? {}
    const hash = index[url]
    return hash ? this.get(hash) : undefined
  }

  async list(): Promise<string[]> {
    return (await readdir(this.dir).catch(() => [] as string[]))
      .filter((name) => /^[0-9a-f]{64}\.md$/.test(name))
      .map((name) => name.slice(0, 64))
  }

  /** Remove sources nobody cites (keeps the cache, and the PR, small). */
  async prune(keep: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = []
    for (const hash of await this.list())
      if (!keep.has(hash)) {
        await rm(path.join(this.dir, `${hash}.md`), { force: true })
        await rm(path.join(this.dir, `${hash}.json`), { force: true })
        removed.push(hash)
      }
    if (removed.length) {
      const index = (await readJson<Record<string, string>>(path.join(this.dir, "index.json"))) ?? {}
      for (const [url, hash] of Object.entries(index)) if (removed.includes(hash)) delete index[url]
      await atomicWrite(path.join(this.dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`)
    }
    return removed
  }
}
