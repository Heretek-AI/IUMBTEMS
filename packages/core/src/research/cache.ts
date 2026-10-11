// Content-addressed source cache: <dir>/<sha256>.md holds the exact text a
// claim may quote; <sha256>.json holds where it came from. Identical content
// shares one entry; the URL index maps canonical URLs (research/url.ts) to
// their latest snapshot.
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import { atomicWrite, readJson } from "../util/fs.ts"
import { sha256 } from "../util/hash.ts"
import { ensureEngineKey, readEngineKey, sealMeta, verifyMetaSeal } from "./seal.ts"
import { classifySourceTier } from "./tier.ts"
import { canonicalUrl } from "./url.ts"

export interface SourceMeta {
  readonly sha256: string
  readonly url: string
  readonly title?: string
  readonly retrieved: string
  /** Search provider or "fetch". */
  readonly provider: string
  readonly query?: string
  readonly bytes: number
  /** Engine HMAC seal (#52); present when written through a sealed cache. */
  readonly seal?: string
  /** Source-quality tier for domain-pack weights (#113); absent means __default__. Sealed with the rest. */
  readonly tier?: string
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
  /**
   * Entries are sealed with the engine key on write (#52) and unsealed
   * entries are refused on read. `stateDir` is required: there is no
   * legacy unsealed mode (#251) — tests that need untrusted bytes write
   * them to disk directly instead of constructing a cache without a key.
   */
  constructor(
    readonly dir: string,
    readonly stateDir: string,
  ) {}

  private async seal(meta: SourceMeta): Promise<SourceMeta> {
    const key = await ensureEngineKey(this.stateDir)
    return { ...meta, seal: sealMeta(meta as unknown as Record<string, unknown>, key) }
  }

  private async sealed(meta: SourceMeta): Promise<boolean> {
    // Never mint a key to verify: without the engine's key nothing verifies (#59).
    const key = await readEngineKey(this.stateDir)
    return key !== undefined && verifyMetaSeal(meta as unknown as Record<string, unknown>, key)
  }

  private indexFile = () => path.join(this.dir, "index.json")
  private indexSealFile = () => path.join(this.dir, "index.seal")

  /**
   * The URL index sealed with the engine key (#251.2): without integrity the
   * index could remap a URL onto another sealed entry's bytes and `byUrl`
   * would serve them. Writes store an HMAC sidecar; reads refuse a
   * present-but-forged sidecar and keep serving a missing one (caches
   * written before sidecars stay readable). Per-entry seals still apply at
   * `get`, so the sidecar only guards the mapping, never the bytes.
   */
  private async writeIndex(index: Record<string, string>): Promise<void> {
    await atomicWrite(this.indexFile(), `${JSON.stringify(index, null, 2)}\n`)
    const key = await ensureEngineKey(this.stateDir)
    await atomicWrite(this.indexSealFile(), `${sealMeta(index as unknown as Record<string, unknown>, key)}\n`)
  }

  private async readIndex(): Promise<Record<string, string>> {
    const index = (await readJson<Record<string, string>>(this.indexFile())) ?? {}
    const seal = (await readFile(this.indexSealFile(), "utf8").catch(() => undefined))?.trim()
    if (seal === undefined || seal === "") return index
    const key = await readEngineKey(this.stateDir)
    if (key === undefined) return index
    return verifyMetaSeal({ ...index, seal }, key) ? index : {}
  }

  async put(input: {
    url: string
    text: string
    title?: string
    provider: string
    query?: string
    /** Pack tierDomains override for classification; unset uses the built-in table (#113). */
    tierDomains?: Record<string, string[]>
  }): Promise<CachedSource> {
    let text = normalizeSourceText(input.text)
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES)
      text = `${Buffer.from(text).subarray(0, MAX_SOURCE_BYTES).toString("utf8")}\n\n[truncated by epistemic-swarm at ${MAX_SOURCE_BYTES} bytes]`
    const hash = sha256(text)
    const tier = classifySourceTier(input.url, input.tierDomains)
    const meta = await this.seal({
      sha256: hash,
      url: input.url,
      ...(input.title ? { title: input.title } : {}),
      retrieved: new Date().toISOString(),
      provider: input.provider,
      ...(input.query ? { query: input.query } : {}),
      bytes: Buffer.byteLength(text),
      ...(tier ? { tier } : {}),
    })
    const file = path.join(this.dir, `${hash}.md`)
    await atomicWrite(file, text)
    await atomicWrite(path.join(this.dir, `${hash}.json`), `${JSON.stringify(meta, null, 2)}\n`)
    const index = await this.readIndex()
    index[canonicalUrl(input.url) ?? input.url] = hash
    await this.writeIndex(index)
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
    // Without a valid engine seal the entry was not written by the engine
    // (planted before the factory dir existed, #52): refuse it.
    if (!(await this.sealed(meta))) return undefined
    return { meta, text, path: file }
  }

  async byUrl(url: string): Promise<CachedSource | undefined> {
    const index = await this.readIndex()
    // Canonical key first; raw keys are what 1.0 caches recorded.
    const hash = index[canonicalUrl(url) ?? url] ?? index[url]
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
      const index = await this.readIndex()
      for (const [url, hash] of Object.entries(index)) if (removed.includes(hash)) delete index[url]
      await this.writeIndex(index)
    }
    return removed
  }
}
