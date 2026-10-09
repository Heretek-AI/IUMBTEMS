// #112: deterministic dossier renders (Markdown + self-contained HTML) and
// the research-run render helper. Source text is hostile: the XSS corpus
// must come out inert.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type DossierRenderInput,
  renderDossierHtml,
  renderDossierMarkdown,
  renderResearchRun,
} from "../src/claims/render.ts"
import { factoryLayout } from "../src/layout.ts"
import type { SourceMeta } from "../src/research/cache.ts"
import type { Claim } from "../src/schema/claims.ts"

const sha = (ch: string) => ch.repeat(64)

const sealedMeta = (overrides: Partial<SourceMeta> = {}): SourceMeta => ({
  sha256: sha("a"),
  url: "https://example.test/greeting",
  title: "Greeting docs",
  retrieved: "2026-10-01T00:00:00.000Z",
  provider: "fetch",
  bytes: 64,
  seal: sha("b"),
  ...overrides,
})

const unsealedMeta = (): SourceMeta => ({
  sha256: sha("c"),
  url: "https://example.test/other",
  retrieved: "2026-10-02T00:00:00.000Z",
  provider: "searxng",
  bytes: 32,
})

const claims: Claim[] = [
  {
    id: sha("1"),
    tag: "VERIFIED",
    statement: "Greet functions take a name.",
    status: "LIVE",
    source: { sha256: sha("a"), quote: "greet(name) renders a greeting" },
  },
  {
    id: sha("2"),
    tag: "INFERRED",
    statement: "One binary covers both commands.",
    status: "LIVE",
    parents: [sha("1")],
    reasoning: "the docs list both under one install",
  },
  {
    id: sha("3"),
    tag: "VERIFIED",
    statement: "Old API had two steps.",
    status: "STALE",
    source: { sha256: sha("c"), quote: "call init, then greet" },
  },
  {
    id: sha("4"),
    tag: "NEGATIVE_KNOWLEDGE",
    statement: "No Windows ARM notes found.",
    status: "LIVE",
    query: "greet windows arm",
    finding: "nothing",
  },
]

const input: DossierRenderInput = {
  objective: "Which greet library?",
  report: "# Findings\n\nGreet libraries expose one function.",
  claims,
  sources: [
    { meta: sealedMeta(), text: "The docs say greet(name) renders a greeting for any name." },
    { meta: unsealedMeta(), text: "Old notes: call init, then greet." },
  ],
  evidenceHash: sha("e"),
}

describe("dossier renders", () => {
  test("markdown shows tag, status, quote, source and seal for every claim", () => {
    const md = renderDossierMarkdown(input)
    expect(md).toContain("# Research dossier: Which greet library?")
    expect(md).toContain(sha("e"))
    expect(md).toContain("Greet libraries expose one function.")
    for (const claim of claims) {
      expect(md).toContain(claim.id.slice(0, 12))
      expect(md).toContain(claim.tag)
      expect(md).toContain(claim.status)
    }
    expect(md).toContain("greet(name) renders a greeting")
    expect(md).toContain("https://example.test/greeting")
    expect(md).toContain("sealed")
    expect(md).toContain("unsealed")
    expect(md).toMatchSnapshot()
  })

  test("html is self-contained with expandable quotes and no external resources", () => {
    const html = renderDossierHtml(input)
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("<style>")
    expect(html).not.toContain("<script")
    expect(html).not.toMatch(/src=|href="http(?!s:\/\/example\.test)/)
    expect(html).toContain("<details>")
    expect(html).toContain(sha("e"))
    for (const claim of claims) {
      expect(html).toContain(claim.tag)
      expect(html).toContain(claim.status)
    }
    expect(html).toContain("greet(name) renders a greeting")
    expect(html).toMatchSnapshot()
  })

  test("renders are deterministic: same inputs, byte-identical outputs", () => {
    expect(renderDossierMarkdown(input)).toBe(renderDossierMarkdown(input))
    expect(renderDossierHtml(input)).toBe(renderDossierHtml(input))
    expect(renderDossierMarkdown({ ...input, claims: [...claims].reverse() })).toBe(renderDossierMarkdown(input))
  })
})

describe("xss corpus", () => {
  const hostile = {
    meta: sealedMeta({ url: 'https://example.test/"onmouseover="x', title: "<img src=x onerror=evil()>" }),
    text: '</details><script>alert("pwned")</script><a href="javascript:steal()">click</a>',
  }
  const hostileInput: DossierRenderInput = {
    ...input,
    claims: [
      {
        id: sha("9"),
        tag: "VERIFIED",
        statement: '<script>alert("stmt")</script>',
        status: "LIVE",
        source: { sha256: sha("a"), quote: '<img src=x onerror=evil()> "quoted"' },
      },
    ],
    sources: [hostile],
  }

  test("hostile text and urls are inert in html", () => {
    const html = renderDossierHtml(hostileInput)
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain("href='javascript:")
    // Attribute payloads survive only as escaped, visible text.
    expect(html).toContain("&lt;img src=x onerror=evil()&gt;")
    // The quoted-attribute URL is shown as text, never linkified.
    expect(html).not.toContain('<a href="https://example.test/')
    // The hostile content is still visible, escaped.
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&lt;img")
    expect(html).toContain("javascript:steal()")
  })

  test("hostile text is literal in markdown", () => {
    const md = renderDossierMarkdown(hostileInput)
    expect(md).toContain('<script>alert("stmt")</script>')
    expect(md).not.toContain("[click](javascript:")
  })
})

describe("renderResearchRun", () => {
  test("reads the run (report, dossier, retractions, cache) in either mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-render-"))
    try {
      const { SourceCache, researchSourcesDir } = await import("../src/research/cache.ts")
      const { buildDossier, writeDossier } = await import("../src/claims/dossier.ts")
      const { normalizeClaim } = await import("../src/claims/claim.ts")
      const cache = new SourceCache(researchSourcesDir(dir), undefined)
      const source = await cache.put({
        url: "https://example.test/q",
        text: "Queues decouple workers from producers durably.",
        provider: "fetch",
      })
      const claim = normalizeClaim({
        tag: "VERIFIED",
        statement: "Queues decouple workers.",
        source: { sha256: source.meta.sha256, quote: "decouple workers from producers" },
      })
      await mkdir(path.join(dir, ".factory/research"), { recursive: true })
      await writeFile(path.join(dir, ".factory/research/REPORT.md"), "# R\n\nQueues win.\n")
      await writeDossier(
        factoryLayout(dir).researchDossier,
        buildDossier({ mode: "research", subject: "queues?", claims: [claim] }),
        { cache },
      )
      const md = await renderResearchRun(dir, { format: "md" })
      expect(md).toContain("Queues win.")
      expect(md).toContain("Queues decouple workers.")
      expect(md).toContain(source.meta.sha256.slice(0, 12))
      const html = await renderResearchRun(dir, { format: "html" })
      expect(html).toContain("<!doctype html>")
      expect(html).toContain("Queues decouple workers.")
      // A source pruned after the dossier was written is shown, never hidden.
      const { SourceCache: Cache, researchSourcesDir: sourcesDir } = await import("../src/research/cache.ts")
      await new Cache(sourcesDir(dir), undefined).prune(new Set())
      expect(await renderResearchRun(dir, { format: "md" })).toContain("not in the cache")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("missing report or dossier is a readable error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-render-empty-"))
    try {
      await expect(renderResearchRun(dir, { format: "md" })).rejects.toThrow(/No research report/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
