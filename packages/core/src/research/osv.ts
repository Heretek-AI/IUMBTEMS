// Security advisories from OSV.dev (https://api.osv.dev, no API key): the
// scout's CVE red-team. The response is cached in the research source cache
// (provider "osv"), so an advisory claim cites a sha256 like any other fact.
import type { SourceCache } from "./cache.ts"

/** OSV ecosystem names for the package registries harvest and the scout understand. */
export const OSV_ECOSYSTEMS = { npm: "npm", pypi: "PyPI", crates: "crates.io", go: "Go" } as const
export type OsvEcosystem = (typeof OSV_ECOSYSTEMS)[keyof typeof OSV_ECOSYSTEMS]

export interface OsvAdvisory {
  readonly id: string
  readonly summary: string
  readonly aliases: readonly string[]
  /** GHSA-style database severity when present: CRITICAL, HIGH, MODERATE, LOW. */
  readonly severity?: string
  /** Versions that fix it, across the affected ranges (empty: no fix released). */
  readonly fixed: readonly string[]
}

/** The advisories in an OSV /v1/query response, sorted by id. */
export function parseOsv(body: unknown): OsvAdvisory[] {
  const vulns = (body as { vulns?: unknown[] } | undefined)?.vulns
  if (!Array.isArray(vulns)) return []
  return vulns
    .map((raw) => {
      const vuln = raw as Record<string, any>
      const fixed = new Set<string>()
      for (const affected of Array.isArray(vuln.affected) ? vuln.affected : [])
        for (const range of Array.isArray(affected?.ranges) ? affected.ranges : [])
          for (const event of Array.isArray(range?.events) ? range.events : [])
            if (typeof event?.fixed === "string") fixed.add(event.fixed)
      const severity =
        vuln.database_specific?.severity ??
        (Array.isArray(vuln.affected)
          ? vuln.affected.find((item: any) => item?.database_specific?.severity)
          : undefined
        )?.database_specific?.severity
      return {
        id: String(vuln.id ?? "unknown"),
        summary: String(vuln.summary ?? vuln.details ?? "")
          .split("\n")[0]!
          .slice(0, 300),
        aliases: Array.isArray(vuln.aliases) ? vuln.aliases.map(String).sort() : [],
        ...(typeof severity === "string" ? { severity: severity.toUpperCase() } : {}),
        fixed: [...fixed].sort(),
      }
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** High or critical advisories (MODERATE and LOW are listed but not flagged). */
export const isSevere = (advisory: OsvAdvisory) => advisory.severity === "HIGH" || advisory.severity === "CRITICAL"

export interface OsvQuery {
  readonly ecosystem: OsvEcosystem
  readonly name: string
  readonly version?: string
}

/** Query OSV and cache the advisories as a citable source. */
export async function queryOsv(
  query: OsvQuery,
  cache: SourceCache,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ advisories: OsvAdvisory[]; sha256: string; url: string }> {
  const response = await (options.fetch ?? fetch)("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "epistemic-swarm" },
    body: JSON.stringify({
      package: { name: query.name, ecosystem: query.ecosystem },
      ...(query.version ? { version: query.version } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from api.osv.dev`)
  const advisories = parseOsv(await response.json())
  const url = `https://osv.dev/list?ecosystem=${encodeURIComponent(query.ecosystem)}&q=${encodeURIComponent(query.name)}${query.version ? `&version=${encodeURIComponent(query.version)}` : ""}`
  const text = [
    `OSV advisories for ${query.ecosystem} package ${query.name}${query.version ? ` version ${query.version}` : ""}: ${advisories.length}.`,
    ...advisories.map(
      (advisory) =>
        `${advisory.id}${advisory.aliases.length ? ` (${advisory.aliases.join(", ")})` : ""} severity ${advisory.severity ?? "unrated"}; fixed in ${advisory.fixed.length ? advisory.fixed.join(", ") : "no released version"}: ${advisory.summary}`,
    ),
  ].join("\n")
  const cached = await cache.put({ url, text, title: `OSV: ${query.name}`, provider: "osv" })
  return { advisories, sha256: cached.meta.sha256, url }
}
