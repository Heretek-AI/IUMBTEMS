// The epistemic auditor for research (and harvest) artifacts.
//
// Every claim line (a bullet, numbered item or prose paragraph line) must carry
// at least one tag:
//   [VERIFIED: sha256:<hash> "verbatim quote"]   — quote must be in the cached source
//   [INFERRED: reasoning]                          — reasoning from verified facts
//   [HYPOTHESIS: how to test it]
//   [NEGATIVE_KNOWLEDGE: what was searched]
// The auditor verifies quotes against the content-addressed cache, flags
// untagged and ungrounded claims, can prune them into a "Pruned claims"
// section, and reports coverage counts (no composite score).
import type { SourceCache } from "./cache.ts"
import { verifyQuote } from "./quote.ts"

export type TagKind = "VERIFIED" | "INFERRED" | "HYPOTHESIS" | "NEGATIVE_KNOWLEDGE"

export interface Tag {
  readonly kind: TagKind
  readonly body: string
  /** VERIFIED only. */
  readonly source?: string
  readonly quote?: string
}

export type ClaimAuditStatus = "grounded" | "ungrounded" | "untagged" | "malformed"

export interface ClaimAudit {
  readonly line: number
  readonly text: string
  readonly tags: readonly Tag[]
  readonly status: ClaimAuditStatus
  readonly reason?: string
}

export interface Coverage {
  readonly claims: number
  readonly grounded: number
  readonly ungrounded: number
  readonly untagged: number
  readonly malformed: number
  readonly byTag: Readonly<Record<TagKind, number>>
  readonly sources: number
}

export interface AuditReport {
  readonly claims: readonly ClaimAudit[]
  readonly coverage: Coverage
  /** Sources cited by grounded VERIFIED tags. */
  readonly cited: readonly string[]
  readonly passed: boolean
}

const TAG_KINDS = ["VERIFIED", "INFERRED", "HYPOTHESIS", "NEGATIVE_KNOWLEDGE"] as const

export function parseTags(line: string): Tag[] {
  const tags: Tag[] = []
  let i = 0
  while (i < line.length) {
    const open = line.indexOf("[", i)
    if (open < 0) break
    const kind = TAG_KINDS.find((name) => line.startsWith(`${name}:`, open + 1))
    if (!kind) {
      i = open + 1
      continue
    }
    // The body may hold brackets of its own (a quote citing "[1]"): match depth.
    let close = -1
    for (let depth = 1, k = open + 1 + kind.length + 1; k < line.length; k++) {
      if (line[k] === "[") depth++
      else if (line[k] === "]" && --depth === 0) {
        close = k
        break
      }
    }
    if (close < 0) break
    const body = line.slice(open + 1 + kind.length + 1, close).trim()
    if (kind === "VERIFIED") {
      const verified = /^(?:sha256:)?([0-9a-f]{64}|\S+)\s+["“](.+)["”]$/s.exec(body)
      tags.push({ kind, body, ...(verified ? { source: verified[1]!, quote: verified[2]! } : {}) })
    } else tags.push({ kind, body })
    i = close + 1
  }
  return tags
}

/** Lines that state something: bullets, numbered items and prose (not headings, code, tables, quotes or blank lines). */
function claimLines(markdown: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  let fenced = false
  let pruned = false
  markdown.split("\n").forEach((raw, index) => {
    const text = raw.trim()
    if (text.startsWith("```")) {
      fenced = !fenced
      return
    }
    if (/^#{1,6}\s/.test(text)) {
      pruned = /^#{1,6}\s+(pruned claims|sources|references|method|open questions)\b/i.test(text)
      return
    }
    if (
      fenced ||
      pruned ||
      !text ||
      text.startsWith(">") ||
      text.startsWith("|") ||
      text.startsWith("<!--") ||
      /^[-*_]{3,}$/.test(text)
    )
      return
    if (/^(title|date|author|status)\s*:/i.test(text)) return
    out.push({ line: index + 1, text })
  })
  return out
}

export async function auditMarkdown(markdown: string, cache: SourceCache): Promise<AuditReport> {
  const claims: ClaimAudit[] = []
  const cited = new Set<string>()
  const byTag: Record<TagKind, number> = { VERIFIED: 0, INFERRED: 0, HYPOTHESIS: 0, NEGATIVE_KNOWLEDGE: 0 }
  for (const { line, text } of claimLines(markdown)) {
    const tags = parseTags(text)
    if (tags.length === 0) {
      claims.push({ line, text, tags, status: "untagged", reason: "no epistemic tag" })
      continue
    }
    let status: ClaimAuditStatus = "grounded"
    let reason: string | undefined
    for (const tag of tags) {
      byTag[tag.kind]++
      if (tag.kind === "VERIFIED") {
        if (!tag.source || !tag.quote) {
          status = "malformed"
          reason = 'VERIFIED needs a source and a quote: [VERIFIED: sha256:<hash> "verbatim quote"]'
          continue
        }
        const source = /^[0-9a-f]{64}$/.test(tag.source) ? await cache.get(tag.source) : await cache.byUrl(tag.source)
        if (!source) {
          status = "ungrounded"
          reason = `source ${tag.source.slice(0, 16)} is not in the cache (fetch it first)`
          continue
        }
        const check = verifyQuote(source.text, tag.quote)
        if (!check.ok) {
          status = "ungrounded"
          reason = `quote ${check.reason}`
          continue
        }
        cited.add(source.meta.sha256)
      } else if (tag.body.length < 8) {
        if (status === "grounded") {
          status = "malformed"
          reason = `${tag.kind} needs a substantive body`
        }
      }
    }
    claims.push({ line, text, tags, status, ...(reason ? { reason } : {}) })
  }
  const count = (wanted: ClaimAuditStatus) => claims.filter((claim) => claim.status === wanted).length
  const coverage: Coverage = {
    claims: claims.length,
    grounded: count("grounded"),
    ungrounded: count("ungrounded"),
    untagged: count("untagged"),
    malformed: count("malformed"),
    byTag,
    sources: cited.size,
  }
  return { claims, coverage, cited: [...cited], passed: claims.length > 0 && coverage.grounded === claims.length }
}

/** Move every claim that failed the audit into a "Pruned claims" section with its reason. */
export function pruneClaims(markdown: string, report: AuditReport): string {
  const failed = report.claims.filter((claim) => claim.status !== "grounded")
  if (!failed.length) return markdown
  const remove = new Set(failed.map((claim) => claim.line))
  const kept = markdown.split("\n").filter((_, index) => !remove.has(index + 1))
  const section = [
    "",
    "## Pruned claims",
    "",
    ...failed.map((claim) => `> ${claim.text}\n> — pruned: ${claim.reason ?? claim.status}`),
  ]
  let body = kept.join("\n")
  while (body.endsWith("\n")) body = body.slice(0, -1)
  return `${body}\n${section.join("\n")}\n`
}

export function formatCoverage(report: AuditReport): string {
  const c = report.coverage
  return [
    `${report.passed ? "Audit passed" : "Audit failed"}: ${c.grounded}/${c.claims} claims grounded; ${c.ungrounded} ungrounded, ${c.untagged} untagged, ${c.malformed} malformed.`,
    `Tags: VERIFIED ${c.byTag.VERIFIED}, INFERRED ${c.byTag.INFERRED}, HYPOTHESIS ${c.byTag.HYPOTHESIS}, NEGATIVE_KNOWLEDGE ${c.byTag.NEGATIVE_KNOWLEDGE}; ${c.sources} cached source(s) cited.`,
    ...report.claims
      .filter((claim) => claim.status !== "grounded")
      .slice(0, 25)
      .map((claim) => `  line ${claim.line} ${claim.status}: ${claim.reason ?? ""} — ${claim.text.slice(0, 100)}`),
  ].join("\n")
}
