// Evidence explorer UI (#133): claim graph, filters, inspector with
// range-highlighted quotes, and exports. Source text is hostile: it is
// rendered through text nodes only, split by verified ranges into <mark>
// elements — never HTML parsing (probed below).
import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type {
  EvidenceClaimDetail,
  EvidenceClaimSummary,
  EvidenceExport,
  EvidenceFilter,
  EvidenceSource,
} from "./api.ts"
import { EvidencePage, layoutEvidence } from "./evidence.ts"
import { installDom } from "./test-dom.ts"

const setup = () => void installDom()

const claims: EvidenceClaimSummary[] = [
  {
    id: "c1",
    tag: "VERIFIED",
    status: "LIVE",
    statement: "Bun starts fast.",
    sourceSha: "aa".repeat(32),
    tier: "quant",
  },
  { id: "c2", tag: "HYPOTHESIS", status: "STALE", statement: "Speed wins.", sourceSha: null },
]

const detail: EvidenceClaimDetail = {
  claim: { id: "c1", tag: "VERIFIED", status: "LIVE", statement: "Bun starts fast.", sourceSha: "aa".repeat(32) },
  quotes: [{ quote: "Bun starts fast indeed", verified: true, ranges: [{ start: 0, end: 21 }] }],
  retractions: [],
  events: [],
  rankExplanation: "#1 VERIFIED LIVE — Bun starts fast.",
  files: ["research/dossier.json"],
}

const source: EvidenceSource = {
  meta: { sha256: "aa".repeat(32), url: "https://example.com/x", retrieved: "", provider: "fetch", bytes: 100 },
  seal: "sealed",
  text: "Bun starts fast indeed, says the benchmark.",
  truncated: false,
}

interface Harness {
  filters: EvidenceFilter[]
  exports: string[]
  downloads: Array<{ name: string; text: string; type: string }>
}

const show = (harness: Harness, overrides: Partial<Parameters<typeof EvidencePage>[0]> = {}) => {
  render(
    () =>
      EvidencePage({
        runId: "run1",
        loadClaims: async (filter) => {
          harness.filters.push(filter)
          return { claims, truncated: false }
        },
        loadClaim: async () => detail,
        loadSource: async () => source,
        exportDoc: async (format): Promise<EvidenceExport> => {
          harness.exports.push(format)
          return { format, body: `# export ${format}`, truncated: false }
        },
        download: (name, text, type) => void harness.downloads.push({ name, text, type }),
        ...overrides,
      }) as unknown as Node,
    document.body,
  )
}

const harness = (): Harness => ({ filters: [], exports: [], downloads: [] })

describe("evidence layout", () => {
  test("claims and cited sources become nodes, citations become edges", () => {
    const graph = layoutEvidence(claims, ["aa".repeat(32)])
    expect(graph.nodes.filter((node) => node.kind === "claim")).toHaveLength(2)
    expect(graph.nodes.filter((node) => node.kind === "source")).toHaveLength(1)
    expect(graph.edges).toEqual([{ from: "c1", to: "aa".repeat(32) }])
    expect(graph.nodes.find((node) => node.id === "c1")!.colour).not.toBe(
      graph.nodes.find((node) => node.id === "c2")!.colour,
    )
  })

  test("empty input lays out to nothing", () => {
    expect(layoutEvidence([], [])).toEqual({ nodes: [], edges: [], width: 0, height: 0 })
  })
})

describe("evidence page", () => {
  test("it renders the graph, the claim list and the tier chips from data", async () => {
    setup()
    const seen = harness()
    show(seen)
    await Bun.sleep(0)
    expect(document.body.querySelectorAll("svg .ev-claim")).toHaveLength(2)
    expect(document.body.querySelectorAll("svg .ev-source")).toHaveLength(1)
    expect(document.body.textContent).toContain("Bun starts fast.")
    // Tier chips exist because a claim carries a tier.
    expect(document.body.textContent).toContain("quant")
  })

  test("tag chips filter the list through the loader", async () => {
    setup()
    const seen = harness()
    show(seen)
    await Bun.sleep(0)
    const chip = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === "VERIFIED")!
    chip.click()
    await Bun.sleep(0)
    expect(seen.filters.at(-1)).toMatchObject({ tag: "VERIFIED" })
  })

  test("selecting a claim shows its inspector, rank and retractions", async () => {
    setup()
    const seen = harness()
    show(seen, {
      loadClaim: async () => ({
        ...detail,
        claim: { ...detail.claim, status: "STALE" },
        retractions: [{ source: "aa".repeat(32), event: "RETRACTED", at: "", note: "withdrawn", by: "human:x" }],
      }),
    })
    await Bun.sleep(0)
    const button = [...document.body.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Bun starts fast."),
    )!
    button.click()
    await Bun.sleep(0)
    expect(document.body.textContent).toContain("#1 VERIFIED LIVE")
    expect(document.body.textContent).toContain("withdrawn")
    expect(document.body.textContent).toContain("STALE")
  })

  test("quotes highlight by range; hostile source text stays inert", async () => {
    setup()
    const seen = harness()
    const evil: EvidenceSource = {
      meta: { sha256: "bb".repeat(32), url: "", retrieved: "", provider: "fetch", bytes: 10 },
      seal: "unsealed",
      text: `Prefix <script>alert(1)</script> <img src=x onerror=alert(1)> suffix.`,
      truncated: false,
    }
    show(seen, {
      loadClaim: async () => ({
        ...detail,
        quotes: [
          {
            quote: "Prefix suffix",
            verified: true,
            ranges: [
              { start: 0, end: 7 },
              { start: 58, end: 66 },
            ],
          },
        ],
      }),
      loadSource: async () => evil,
    })
    await Bun.sleep(0)
    const claimButton = [...document.body.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Bun starts fast."),
    )!
    claimButton.click()
    await Bun.sleep(0)
    const quoteButton = [...document.body.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("show in source"),
    )!
    quoteButton.click()
    await Bun.sleep(0)
    expect(document.body.querySelector("script")).toBeNull()
    expect(document.body.querySelectorAll("img")).toHaveLength(0)
    const marks = document.body.querySelectorAll("mark.quote-mark")
    expect(marks.length).toBe(2)
    expect(document.body.textContent).toContain("<script>alert(1)</script>")
    expect(seen.filters.length).toBeGreaterThan(0)
  })

  test("export buttons download both formats", async () => {
    setup()
    const seen = harness()
    show(seen)
    await Bun.sleep(0)
    const md = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === "Markdown")!
    md.click()
    await Bun.sleep(0)
    const html = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === "HTML")!
    html.click()
    await Bun.sleep(0)
    expect(seen.exports).toEqual(["markdown", "html"])
    expect(seen.downloads.map((entry) => entry.name)).toEqual(["dossier-run1.md", "dossier-run1.html"])
    expect(seen.downloads[0]!.text).toContain("# export markdown")
  })
})
