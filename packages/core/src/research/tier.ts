// Deterministic source-tier classification (#113): which shelf a cached
// source sits on (preprint, peer-reviewed, docs, press), so domain packs can
// weight verified claims by source quality. Rules are host-based and
// auditable; unknown hosts stay tierless and fall back to `__default__`.
// Packs may add a `tierDomains` override, which wins over the built-ins.
import { DOC_DOMAINS } from "./url.ts"

const PREPRINT = ["arxiv.org", "biorxiv.org", "medrxiv.org", "ssrn.com"] as const
const PEER_REVIEWED = [
  "doi.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "nature.com",
  "science.org",
  "sciencedirect.com",
  "springer.com",
  "wiley.com",
  "nejm.org",
  "thelancet.com",
  "plos.org",
  "frontiersin.org",
  "bmj.com",
  "jamanetwork.com",
] as const

const hostOf = (url: string): string | undefined => {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase()
    return host ? host.replace(/\.$/, "") : undefined
  } catch {
    return undefined
  }
}

const matches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

/**
 * Classify a source URL into a tier, or undefined when no rule fires.
 * `overrides` (a pack's `tierDomains`) is checked first and wins.
 */
export function classifySourceTier(
  url: string,
  overrides?: Readonly<Record<string, readonly string[]>>,
): string | undefined {
  const host = hostOf(url)
  if (!host) return undefined
  if (overrides)
    for (const [tier, domains] of Object.entries(overrides))
      if (domains.some((domain) => matches(host, domain.toLowerCase()))) return tier
  if (PREPRINT.some((domain) => matches(host, domain))) return "PREPRINT"
  if (PEER_REVIEWED.some((domain) => matches(host, domain))) return "PEER_REVIEWED"
  if (
    (DOC_DOMAINS as readonly string[]).some((domain) => matches(host, domain)) ||
    host.startsWith("docs.") ||
    host.startsWith("developer.")
  )
    return "TECHNICAL_DOCUMENTATION"
  if (host.endsWith(".gov")) return "PRIMARY_PRESS"
  return undefined
}
