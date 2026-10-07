// Research report → claims: each epistemic tag on an audited claim line
// becomes one claim, so the research stage emits the same dossier shape the
// code audit and scout will. VERIFIED tags citing a URL resolve to the full
// sha256 of the cached snapshot the audit verified against.
import type { AuditReport, Tag } from "../research/auditor.ts"
import type { SourceCache } from "../research/cache.ts"
import type { Claim } from "../schema/claims.ts"
import { normalizeClaim } from "./claim.ts"

const TAG_OPEN = /\[(VERIFIED|INFERRED|HYPOTHESIS|NEGATIVE_KNOWLEDGE):/g

/** The claim text without its tags or list marker. */
export function stripTags(line: string): string {
  let out = ""
  let i = 0
  for (const match of line.matchAll(TAG_OPEN)) {
    if (match.index < i) continue
    let depth = 0
    let close = -1
    for (let k = match.index; k < line.length; k++) {
      if (line[k] === "[") depth++
      else if (line[k] === "]" && --depth === 0) {
        close = k
        break
      }
    }
    if (close < 0) break
    out += line.slice(i, match.index)
    i = close + 1
  }
  out += line.slice(i)
  return out
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
}

async function claimFor(statement: string, tag: Tag, cache: SourceCache): Promise<Claim> {
  switch (tag.kind) {
    case "VERIFIED": {
      const source = /^[0-9a-f]{64}$/.test(tag.source ?? "")
        ? await cache.get(tag.source!)
        : await cache.byUrl(tag.source ?? "")
      return normalizeClaim({
        tag: "VERIFIED",
        statement,
        ...(source && tag.quote
          ? {
              source: {
                sha256: source.meta.sha256,
                quote: tag.quote,
                ...(source.meta.url ? { url: source.meta.url } : {}),
              },
            }
          : {}),
      })
    }
    case "INFERRED":
      return normalizeClaim({ tag: "INFERRED", statement, reasoning: tag.body })
    case "HYPOTHESIS":
      return normalizeClaim({ tag: "HYPOTHESIS", statement, falsification: tag.body })
    case "NEGATIVE_KNOWLEDGE":
      return normalizeClaim({ kind: "negative_knowledge", statement, query: tag.body, finding: statement || tag.body })
  }
}

/** Claims from the grounded lines of an audit (call it on a passing audit). */
export async function claimsFromAudit(audit: AuditReport, cache: SourceCache): Promise<Claim[]> {
  const claims: Claim[] = []
  for (const line of audit.claims) {
    if (line.status !== "grounded") continue
    const text = stripTags(line.text)
    for (const tag of line.tags) claims.push(await claimFor(text || tag.body, tag, cache))
  }
  return [...new Map(claims.map((claim) => [claim.id, claim])).values()]
}
