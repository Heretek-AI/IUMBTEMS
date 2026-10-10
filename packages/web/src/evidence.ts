// Evidence explorer UI (#133, clean-room): claim/source graph, tag/status
// filters, inspector with range-highlighted quotes, and renderer exports.
// Source text is hostile: it flows through text nodes only, segmented by
// verified ranges into <mark> elements — the component never parses source
// HTML (probed in evidence.test.ts). Read-only: the only requests are the
// evidence.* reads plus a blob download of rendered exports.
import { createSignal } from "solid-js"
import type {
  EvidenceClaimDetail,
  EvidenceClaimSummary,
  EvidenceExport,
  EvidenceFilter,
  EvidenceSource,
  Tag,
} from "./api.ts"
import { h, svgEl } from "./dom.ts"

export type { Tag }

const TAG_COLOUR: Record<string, string> = {
  VERIFIED: "#2f9e6e",
  INFERRED: "#3d7a8c",
  HYPOTHESIS: "#c07c14",
  NEGATIVE_KNOWLEDGE: "#64748b",
}

const TAGS = ["VERIFIED", "INFERRED", "HYPOTHESIS", "NEGATIVE_KNOWLEDGE"] as const
const STATUSES = ["LIVE", "STALE", "SUSPECT", "REJECTED"] as const

export interface EvidenceNode {
  readonly id: string
  readonly kind: "claim" | "source"
  readonly label: string
  readonly sub: string
  readonly colour: string
  readonly x: number
  readonly y: number
}

export interface EvidenceLayout {
  readonly nodes: readonly EvidenceNode[]
  readonly edges: ReadonlyArray<{ from: string; to: string }>
  readonly width: number
  readonly height: number
}

const CLAIM_X = 16
const SOURCE_X = 400
const ROW_DY = 88
const PAD = 16

/**
 * Two columns: claims left, cited sources right, edges for citations.
 * Extra source shas (cited by claims outside the current filter) still
 * draw so edges never dangle.
 */
export function layoutEvidence(
  claims: readonly Pick<EvidenceClaimSummary, "id" | "tag" | "status" | "statement" | "sourceSha">[],
  extraSources: readonly string[] = [],
): EvidenceLayout {
  if (claims.length === 0 && extraSources.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }
  const shas = [...new Set([...claims.map((claim) => claim.sourceSha).filter((sha) => sha !== null), ...extraSources])]
  const nodes: EvidenceNode[] = [
    ...claims.map((claim, index) => ({
      id: claim.id,
      kind: "claim" as const,
      label: `${claim.id.slice(0, 12)}… — ${claim.tag}`,
      sub: `${claim.status} · ${claim.statement.slice(0, 30)}`,
      colour: TAG_COLOUR[claim.tag] ?? "#8a8a8a",
      x: CLAIM_X,
      y: PAD + index * ROW_DY,
    })),
    ...shas.map((sha, index) => ({
      id: sha,
      kind: "source" as const,
      label: `source ${sha.slice(0, 12)}…`,
      sub: `${claims.filter((claim) => claim.sourceSha === sha).length} citation(s)`,
      colour: "#7c6aa8",
      x: SOURCE_X,
      y: PAD + index * ROW_DY,
    })),
  ]
  const edges = claims
    .filter((claim) => claim.sourceSha !== null)
    .map((claim) => ({ from: claim.id, to: claim.sourceSha as string }))
  const rows = Math.max(nodes.length, 1)
  return { nodes, edges, width: SOURCE_X + 200, height: PAD * 2 + rows * ROW_DY }
}

const graphEl = (claims: readonly EvidenceClaimSummary[]): Element => {
  const graph = layoutEvidence(claims)
  if (graph.nodes.length === 0) return h("p", null, "No claims yet.")
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  return svgEl(
    "svg",
    { width: graph.width, height: graph.height, role: "img", "aria-label": "Claim and source graph" },
    ...graph.edges.map((edge) => {
      const from = byId.get(edge.from)!
      const to = byId.get(edge.to)!
      return svgEl("line", {
        class: "ev-edge",
        x1: from.x + 220,
        y1: from.y + 30,
        x2: to.x,
        y2: to.y + 30,
        stroke: "#94a3b8",
        "stroke-width": 2,
      })
    }),
    ...graph.nodes.map((node) =>
      svgEl(
        "g",
        { class: node.kind === "claim" ? "ev-claim" : "ev-source", transform: `translate(${node.x},${node.y})` },
        svgEl("title", null, `${node.label}: ${node.sub}`),
        svgEl("rect", {
          width: 220,
          height: 60,
          rx: 8,
          fill: node.colour,
          "fill-opacity": 0.18,
          stroke: node.colour,
          "stroke-width": 2,
          ...(node.kind === "claim" && node.sub.startsWith("LIVE") ? {} : { "stroke-dasharray": "6 3" }),
        }),
        svgEl("text", { x: 10, y: 22, "font-size": 12, "font-weight": "bold" }, node.label),
        svgEl("text", { x: 10, y: 42, "font-size": 11 }, node.sub.slice(0, 34)),
      ),
    ),
  ) as unknown as Element
}

/** Split hostile text by verified ranges into plain and marked spans. */
const segmentsOf = (
  text: string,
  ranges: readonly { start: number; end: number }[],
): Array<{ mark: boolean; text: string }> => {
  const spans = ranges
    .filter((range) => range.start < range.end)
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, text.length)),
      end: Math.max(0, Math.min(range.end, text.length)),
    }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start)
  const out: Array<{ mark: boolean; text: string }> = []
  let at = 0
  for (const span of spans) {
    if (span.start < at) continue
    if (span.start > at) out.push({ mark: false, text: text.slice(at, span.start) })
    out.push({ mark: true, text: text.slice(span.start, span.end) })
    at = Math.max(at, span.end)
  }
  if (at < text.length) out.push({ mark: false, text: text.slice(at) })
  return out
}

const viewerEl = (source: EvidenceSource, ranges: readonly { start: number; end: number }[]): Element =>
  h(
    "section",
    null,
    h("h3", null, "Source"),
    h(
      "p",
      null,
      source.meta.url ? h("span", null, source.meta.url) : h("span", null, "(no recorded URL)"),
      ` · seal: ${source.seal}`,
      source.meta.tier ? ` · tier ${source.meta.tier}` : "",
      source.truncated ? " · text capped" : "",
    ),
    h(
      "pre",
      { class: "source-text" },
      ...segmentsOf(source.text, ranges).map((segment) =>
        segment.mark ? h("mark", { class: "quote-mark" }, segment.text) : segment.text,
      ),
    ),
  )

export interface EvidencePageProps {
  readonly runId: string
  readonly loadClaims: (filter: EvidenceFilter) => Promise<{ claims: EvidenceClaimSummary[]; truncated: boolean }>
  readonly loadClaim: (id: string) => Promise<EvidenceClaimDetail>
  readonly loadSource: (sha: string) => Promise<EvidenceSource>
  readonly exportDoc: (format: "markdown" | "html") => Promise<EvidenceExport>
  readonly download?: (name: string, text: string, type: string) => void
}

const saveBlob = (name: string, text: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export function EvidencePage(props: EvidencePageProps): Element {
  const download = props.download ?? saveBlob
  const [filter, setFilter] = createSignal<EvidenceFilter>({})
  const [claims, setClaims] = createSignal<EvidenceClaimSummary[]>([])
  const [tiers, setTiers] = createSignal<string[]>([])
  const [truncated, setTruncated] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined)
  const [detail, setDetail] = createSignal<EvidenceClaimDetail | undefined>(undefined)
  const [source, setSource] = createSignal<
    { sha: string; view: EvidenceSource; ranges: { start: number; end: number }[] } | undefined
  >(undefined)
  const [busy, setBusy] = createSignal(false)

  const reload = async (next: EvidenceFilter): Promise<void> => {
    setFilter(next)
    setError(undefined)
    try {
      const seen = await props.loadClaims(next)
      setClaims(seen.claims)
      setTruncated(seen.truncated)
      setTiers([...new Set(seen.claims.map((claim) => claim.tier).filter((tier) => tier !== undefined))])
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const select = async (id: string): Promise<void> => {
    setSelectedId(id)
    setSource(undefined)
    try {
      setDetail(await props.loadClaim(id))
      setError(undefined)
    } catch (failure) {
      setDetail(undefined)
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const showQuote = async (sha: string, ranges: { start: number; end: number }[]): Promise<void> => {
    try {
      setSource({ sha, view: await props.loadSource(sha), ranges })
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const exportAs = async (format: "markdown" | "html"): Promise<void> => {
    setBusy(true)
    try {
      const rendered = await props.exportDoc(format)
      download(
        `dossier-${props.runId}.${format === "html" ? "html" : "md"}`,
        rendered.body,
        format === "html" ? "text/html" : "text/markdown",
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  void reload({})

  const chip = (group: "tag" | "status" | "tier", value: string): Element => {
    const active = (filter()[group] ?? "") === value
    return h(
      "button",
      {
        type: "button",
        "aria-pressed": String(active),
        onclick: () => void reload({ ...filter(), [group]: active ? undefined : value }),
      },
      `${active ? "✓ " : ""}${value}`,
    )
  }

  const detailEl = (seen: EvidenceClaimDetail): Element =>
    h(
      "section",
      null,
      h("h2", { title: seen.claim.id }, `${seen.claim.id.slice(0, 12)}… — ${seen.claim.tag}`),
      h("p", null, seen.claim.statement),
      h("p", null, `Status ${seen.claim.status} · ${seen.rankExplanation}`),
      seen.retractions.length
        ? h(
            "section",
            null,
            h("h3", null, "Retractions"),
            h(
              "ul",
              null,
              ...seen.retractions.map((retraction) =>
                h("li", null, `${retraction.event} by ${retraction.by}: ${retraction.note || "(no note)"}`),
              ),
            ),
          )
        : "",
      seen.events.length
        ? h(
            "section",
            null,
            h("h3", null, "History"),
            h("ul", null, ...seen.events.map((event) => h("li", null, `${event.from} → ${event.to}: ${event.reason}`))),
          )
        : "",
      h(
        "section",
        null,
        h("h3", null, "Quotes"),
        ...seen.quotes.map((quote, index) =>
          h(
            "div",
            null,
            h("p", null, h("code", null, quote.quote)),
            h(
              "p",
              null,
              quote.verified
                ? `Verified in source (${quote.ranges.length} range(s)). `
                : "Not currently verifiable in source. ",
              seen.claim.sourceSha
                ? h(
                    "button",
                    {
                      type: "button",
                      onclick: () => void showQuote(seen.claim.sourceSha as string, [...quote.ranges]),
                    },
                    `show in source #${index + 1}`,
                  )
                : "",
            ),
          ),
        ),
      ),
    )

  return h(
    "main",
    null,
    h("h1", null, `Evidence for ${props.runId}`),
    () => (error() !== undefined ? h("p", { role: "alert" }, error()!) : ""),
    h(
      "section",
      null,
      h("h2", null, "Filters"),
      h("div", null, ...TAGS.map((tag) => chip("tag", tag))),
      h("div", null, ...STATUSES.map((status) => chip("status", status))),
      () => {
        const present = tiers()
        return present.length === 0 ? "" : h("div", null, ...present.map((tier) => chip("tier", tier)))
      },
    ),
    h(
      "section",
      null,
      h("h2", null, "Claims"),
      () => (truncated() ? h("p", null, "List capped — narrow the filters.") : ""),
      () => {
        const list = claims()
        if (list.length === 0) return h("p", null, "No claims yet.")
        return h(
          "ul",
          null,
          ...list.map((claim) =>
            h(
              "li",
              null,
              h(
                "button",
                { type: "button", title: claim.id, onclick: () => void select(claim.id) },
                `${claim.id.slice(0, 12)}… — ${claim.tag} — ${claim.status}: ${claim.statement}`,
              ),
            ),
          ),
        )
      },
    ),
    () => graphEl(claims()),
    () => {
      const seen = detail()
      if (selectedId() === undefined) return ""
      return seen ? detailEl(seen) : h("p", null, "Loading the claim…")
    },
    () => {
      const shown = source()
      return shown ? viewerEl(shown.view, shown.ranges) : ""
    },
    h(
      "section",
      null,
      h("h2", null, "Export"),
      h(
        "p",
        null,
        h("button", { type: "button", onclick: () => void exportAs("markdown") }, "Markdown"),
        " ",
        h("button", { type: "button", onclick: () => void exportAs("html") }, "HTML"),
        () => (busy() ? " Rendering…" : ""),
      ),
    ),
  )
}
