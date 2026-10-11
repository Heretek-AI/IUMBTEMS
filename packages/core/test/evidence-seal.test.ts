// #251.2: the URL index is sealed with the engine key. A sealed cache
// writes an `index.seal` sidecar (HMAC over the canonical index); `byUrl`
// refuses a tampered index instead of following it. A missing sidecar stays
// readable (caches written before sealing keep working); an unsealed cache
// writes no sidecar.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SourceCache } from "../src/research/cache.ts"

const put2 = async (cache: SourceCache) => {
  const a = await cache.put({
    url: "https://a.test/page",
    text: "Alpha source text with enough length.",
    provider: "fetch",
  })
  const b = await cache.put({
    url: "https://b.test/page",
    text: "Beta source text with enough length here.",
    provider: "fetch",
  })
  return { a, b }
}

describe("sealed URL index (#251.2)", () => {
  test("a sealed cache writes an HMAC sidecar next to index.json", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-index-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-index-state-"))
    try {
      const sealed = new SourceCache(path.join(dir, "sealed"), state)
      await put2(sealed)
      const seal = await Bun.file(path.join(dir, "sealed", "index.seal")).text()
      expect(seal.trim()).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("byUrl refuses a tampered index instead of serving the remapped entry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-index-tamper-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-index-tamper-state-"))
    try {
      const cache = new SourceCache(path.join(dir, "sources"), state)
      const { a, b } = await put2(cache)
      expect((await cache.byUrl("https://a.test/page"))?.meta.sha256).toBe(a.meta.sha256)
      // Remap a.test to b's bytes without re-sealing the index.
      const indexFile = path.join(dir, "sources", "index.json")
      const index = JSON.parse(await Bun.file(indexFile).text()) as Record<string, string>
      index["https://a.test/page"] = b.meta.sha256
      await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`)
      expect(await cache.byUrl("https://a.test/page")).toBeUndefined()
      // Direct reads by hash are unaffected.
      expect((await cache.get(b.meta.sha256))?.text).toContain("Beta source")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  test("an index written before sealing (no sidecar) stays readable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-index-legacy-"))
    const state = await mkdtemp(path.join(tmpdir(), "es-index-legacy-state-"))
    try {
      const cache = new SourceCache(path.join(dir, "sources"), state)
      const entry = await cache.put({
        url: "https://old.test/page",
        text: "Old source text with enough length here.",
        provider: "fetch",
      })
      // An index from before sidecars existed carries sealed entries but no
      // sidecar: the sealed reader keeps serving it by URL.
      await rm(path.join(dir, "sources", "index.seal"), { force: true })
      expect((await cache.byUrl("https://old.test/page"))?.meta.sha256).toBe(entry.meta.sha256)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })
})
