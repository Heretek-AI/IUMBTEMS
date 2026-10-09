// Deterministic dossier renders (#112): Markdown and one self-contained HTML
// file from a dossier, its report and its sources. Rendering signs nothing,
// so it is agent-safe; the signed PCRB brief stays human-only.
//
// Source text is untrusted: the HTML escapes everything, links only http(s)
// URLs (with rel=noopener), and loads no external resources, fonts, images or
// scripts. Both formats are byte-deterministic for snapshot tests.
import { readFile } from "node:fs/promises"
import { stateDir as defaultStateDir, factoryLayout } from "../layout.ts"
import type { SourceMeta } from "../research/cache.ts"
import { researchCache } from "../research/ops.ts"
import { readEngineKey, verifyMetaSeal } from "../research/seal.ts"
import type { Claim } from "../schema/claims.ts"
import { applyDegradation, readRetractions } from "./degrade.ts"
import { readDossier } from "./dossier.ts"

export interface RenderSource {
  readonly meta: SourceMeta
  readonly text: string
}

export interface DossierRenderInput {
  readonly objective: string
  /** REPORT.md text. */
  readonly report: string
  /** Claims after applyDegradation (statuses already resolved). */
  readonly claims: readonly Claim[]
  readonly sources: readonly RenderSource[]
  readonly evidenceHash: string
  /** Cited sources absent from the cache (shown, never hidden). */
  readonly missingSources?: readonly string[]
}

/** Escape text for HTML element content and double-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

const shortId = (sha: string) => sha.slice(0, 12)

/** Only these URLs become links: http(s) with no whitespace, quotes or angle brackets. */
export function safeUrl(url: string): string | undefined {
  const trimmed = url.trim()
  return /^https?:\/\/[^\s<>"']+$/i.test(trimmed) ? trimmed : undefined
}

const sortedClaims = (claims: readonly Claim[]) => [...claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const sortedSources = (sources: readonly RenderSource[]) =>
  [...sources].sort((a, b) => (a.meta.sha256 < b.meta.sha256 ? -1 : a.meta.sha256 > b.meta.sha256 ? 1 : 0))

const statusCounts = (claims: readonly Claim[]) => {
  const counts = new Map<string, number>()
  for (const claim of claims) counts.set(claim.status, (counts.get(claim.status) ?? 0) + 1)
  return [...counts].map(([status, count]) => `${count} ${status.toLowerCase()}`).join(", ")
}

const sealStatus = (meta: SourceMeta): "sealed" | "unsealed" => (meta.seal ? "sealed" : "unsealed")

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const mdCell = (text: string) => oneLine(text).replaceAll("|", "\\|").slice(0, 400)

/** Minimal inline Markdown for report bodies: code, bold, and http(s) links only. Input must already be escaped. */
function mdInline(escaped: string): string {
  return escaped
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, url) => {
      const safe = safeUrl(url)
      return safe ? `<a href="${safe}" rel="noopener noreferrer">${text}</a>` : match
    })
}

/** Minimal block Markdown for report bodies. Input must already be escaped. */
function mdBlocks(escaped: string): string {
  const lines = escaped.split("\n")
  const out: string[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((item) => `<li>${mdInline(item)}</li>`).join("")}</ul>`)
    list = []
  }
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1]!.length
      out.push(`<h${level}>${mdInline(heading[2]!)}</h${level}>`)
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      list.push(bullet[1]!)
      continue
    }
    flush()
    if (line.trim()) out.push(`<p>${mdInline(line)}</p>`)
  }
  flush()
  return out.join("\n")
}

export function renderDossierMarkdown(input: DossierRenderInput): string {
  const claims = sortedClaims(input.claims)
  const sources = sortedSources(input.sources)
  const missing = [...(input.missingSources ?? [])].sort()
  const lines = [
    `# Research dossier: ${input.objective}`,
    "",
    `Evidence \`${input.evidenceHash}\` · ${claims.length} claim(s)${claims.length ? ` (${statusCounts(claims)})` : ""} · ${sources.length} source(s).`,
    "",
    "## Report",
    "",
    input.report.trim(),
    "",
    "## Claims",
    "",
    "| id | tag | status | claim | evidence |",
    "| --- | --- | --- | --- | --- |",
  ]
  for (const claim of claims) {
    const evidence = claim.source
      ? `"${mdCell(claim.source.quote)}" — [${shortId(claim.source.sha256)}](#source-${shortId(claim.source.sha256)})`
      : claim.parents?.length
        ? `inferred from ${claim.parents.map(shortId).join(", ")}`
        : (claim.query ?? claim.reasoning ?? claim.falsification ?? "—")
    lines.push(
      `| ${shortId(claim.id)} | ${claim.tag} | ${claim.status} | ${mdCell(claim.statement)} | ${mdCell(evidence)} |`,
    )
  }
  lines.push("", "## Sources", "")
  for (const source of sources) {
    const meta = source.meta
    lines.push(
      `<a id="source-${shortId(meta.sha256)}"></a>### \`${shortId(meta.sha256)}\` — ${meta.url}`,
      "",
      `- retrieved ${meta.retrieved} · provider ${meta.provider} · ${sealStatus(meta)}${meta.title ? ` · ${oneLine(meta.title)}` : ""}`,
      "",
      `> ${mdCell(source.text.slice(0, 300))}`,
      "",
    )
  }
  for (const sha of missing) lines.push(`- \`${shortId(sha)}\` (${sha}): cited but not in the cache.`, "")
  return `${lines.join("\n").trim()}\n`
}

const CSS = [
  "body{font-family:system-ui,sans-serif;max-width:72ch;margin:2rem auto;padding:0 1rem;color:#1a1a1a}",
  ".badge{display:inline-block;padding:0 .5em;border-radius:1em;font-size:.85em;font-weight:600}",
  ".tag-VERIFIED{background:#d9ead3}.tag-INFERRED{background:#fff2cc}.tag-HYPOTHESIS{background:#fce5cd}.tag-NEGATIVE_KNOWLEDGE{background:#d0e0e3}",
  ".status-LIVE{background:#d9ead3}.status-STALE{background:#f4cccc}.status-SUSPECT{background:#fce5cd}.status-REJECTED{background:#434343;color:#fff}",
  "table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.4em;text-align:left;vertical-align:top}",
  "pre{background:#f4f4f4;padding:1em;overflow-x:auto;white-space:pre-wrap}",
  "details{margin:.5em 0}summary{cursor:pointer;font-weight:600}",
].join("")

export function renderDossierHtml(input: DossierRenderInput): string {
  const claims = sortedClaims(input.claims)
  const sources = sortedSources(input.sources)
  const missing = [...(input.missingSources ?? [])].sort()
  const sourceById = new Map(sources.map((source) => [source.meta.sha256, source]))
  const claimRows = claims
    .map((claim) => {
      const evidence = claim.source
        ? (() => {
            const source = sourceById.get(claim.source!.sha256)
            const safe = source ? safeUrl(source.meta.url) : undefined
            const link = safe
              ? `<a href="${escapeHtml(safe)}" rel="noopener noreferrer">${escapeHtml(shortId(claim.source!.sha256))}</a>`
              : escapeHtml(shortId(claim.source!.sha256))
            return `<details><summary>quote from ${link}</summary><blockquote>${escapeHtml(claim.source!.quote)}</blockquote></details>`
          })()
        : escapeHtml(
            claim.parents?.length
              ? `inferred from ${claim.parents.map(shortId).join(", ")}`
              : (claim.query ?? claim.reasoning ?? claim.falsification ?? "—"),
          )
      return [
        "<tr>",
        `<td><code>${escapeHtml(shortId(claim.id))}</code></td>`,
        `<td><span class="badge tag-${claim.tag}">${claim.tag}</span></td>`,
        `<td><span class="badge status-${claim.status}">${claim.status}</span></td>`,
        `<td>${escapeHtml(claim.statement)}</td>`,
        `<td>${evidence}</td>`,
        "</tr>",
      ].join("")
    })
    .join("\n")
  const sourceBlocks = sources
    .map((source) => {
      const meta = source.meta
      return [
        "<details>",
        `<summary><code>${escapeHtml(shortId(meta.sha256))}</code> — ${escapeHtml(meta.url)}</summary>`,
        "<ul>",
        `<li>retrieved ${escapeHtml(meta.retrieved)} · provider ${escapeHtml(meta.provider)} · ${sealStatus(meta)}${meta.title ? ` · ${escapeHtml(meta.title)}` : ""}</li>`,
        `<li>sha256 <code>${escapeHtml(meta.sha256)}</code></li>`,
        "</ul>",
        `<pre>${escapeHtml(source.text)}</pre>`,
        "</details>",
      ].join("\n")
    })
    .join("\n")
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(`Research dossier: ${input.objective}`)}</title>`,
    `<style>${CSS}</style>`,
    "</head>",
    "<body>",
    `<h1>${escapeHtml(`Research dossier: ${input.objective}`)}</h1>`,
    `<p>Evidence <code>${escapeHtml(input.evidenceHash)}</code> · ${claims.length} claim(s)${claims.length ? ` (${escapeHtml(statusCounts(claims))})` : ""} · ${sources.length} source(s).</p>`,
    "<h2>Report</h2>",
    mdBlocks(escapeHtml(input.report)),
    "<h2>Claims</h2>",
    "<table><thead><tr><th>id</th><th>tag</th><th>status</th><th>claim</th><th>evidence</th></tr></thead><tbody>",
    claimRows,
    "</tbody></table>",
    "<h2>Sources</h2>",
    sourceBlocks,
    missing
      .map((sha) => `<p><code>${escapeHtml(shortId(sha))}</code> (${escapeHtml(sha)}): cited but not in the cache.</p>`)
      .join("\n"),
    "</body>",
    "</html>",
    "",
  ].join("\n")
}

/** Read the current run (factory or research mode) and render it. Missing pieces are readable errors. */
export async function renderResearchRun(
  root: string,
  options: { format: "md" | "html"; stateDir?: string },
): Promise<string> {
  const layout = factoryLayout(root)
  const report = await readFile(layout.researchReport, "utf8").catch(() => undefined)
  if (report === undefined) throw new Error("No research report yet (.factory/research/REPORT.md).")
  const dossier = await readDossier(layout.researchDossier).catch(() => undefined)
  if (!dossier) throw new Error("No research dossier yet: es_research_complete writes .factory/research/dossier.json.")
  const { claims } = applyDegradation(dossier.claims, await readRetractions(root))
  const stateDir = options.stateDir ?? defaultStateDir()
  const cache = researchCache(root, stateDir)
  const key = await readEngineKey(stateDir).catch(() => undefined)
  const shas = [...new Set(claims.flatMap((claim) => (claim.source ? [claim.source.sha256] : [])))].sort()
  const sources: RenderSource[] = []
  const missing: string[] = []
  for (const sha of shas) {
    const cached = await cache.get(sha)
    if (!cached) {
      missing.push(sha)
      continue
    }
    const meta: SourceMeta =
      cached.meta.seal && key && verifyMetaSeal(cached.meta as unknown as Record<string, unknown>, key)
        ? cached.meta
        : { ...cached.meta, seal: undefined }
    sources.push({ meta, text: cached.text })
  }
  const input: DossierRenderInput = {
    objective: dossier.subject,
    report,
    claims,
    sources,
    evidenceHash: dossier.evidenceHash,
    ...(missing.length ? { missingSources: missing } : {}),
  }
  return options.format === "html" ? renderDossierHtml(input) : renderDossierMarkdown(input)
}
