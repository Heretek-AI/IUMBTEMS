// The claim witness, ported from legacy runner/claim_witness.py witness_check.
// A claim is re-checked against evidence the agent cannot have fabricated:
//   - a VERIFIED source quote against the content-addressed cache (tamper-
//     refusing get + the one quote law, research/quote.ts);
//   - a code location against the file on disk: inside the target root, the
//     line range within the file and at most MAX_LOCATION_LINES long, the
//     excerpt one contiguous verbatim span of those lines.
// Legacy never checked code locations at all (its "hallucinated line" check
// was the generic quote check), so the location rule is new in 1.1.
import path from "node:path"
import type { SourceCache } from "../research/cache.ts"
import { verifyQuote, verifySpan } from "../research/quote.ts"
import type { Claim, ClaimLocation, Witness } from "../schema/claims.ts"
import { canonicalPath, relativeTo } from "../trust/paths.ts"
import { readRegularFile } from "../util/fs.ts"

export interface WitnessOptions {
  readonly cache: SourceCache
  /** Root that code locations are relative to (the audited checkout). */
  readonly root?: string
  /** Claim ids that INFERRED parents may name (the rest of the dossier or store). */
  readonly known?: ReadonlySet<string>
  readonly now?: () => Date
}

/** A code location names the code it means, not a whole file: at most this many lines. */
export const MAX_LOCATION_LINES = 60

type Check = { readonly ok: true } | { readonly ok: false; readonly reason: string }
const pass: Check = { ok: true }
const fail = (reason: string): Check => ({ ok: false, reason })

/** Read the excerpt's lines from `root/location.file`, refusing anything outside root. */
export async function checkLocation(root: string, location: ClaimLocation): Promise<Check> {
  const base = canonicalPath(root)
  const real = canonicalPath(location.file, base)
  const relative = relativeTo(base, real)
  if (relative === undefined || relative === ".") return fail(`${location.file} is outside the audited tree`)
  const text = await readRegularFile(path.join(base, relative))
  if (text === undefined) return fail(`${location.file} does not exist (or is not a regular file under 2 MB)`)
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  const [start, end] = location.lines
  if (end - start + 1 > MAX_LOCATION_LINES)
    return fail(
      `${location.file}#L${start}-L${end} spans ${end - start + 1} lines; cite at most ${MAX_LOCATION_LINES} lines around the code you mean`,
    )
  if (end > lines.length)
    return fail(`${location.file}#L${start}-L${end} is past the end of the file (${lines.length} lines)`)
  const quoted = verifySpan(lines.slice(start - 1, end).join("\n"), location.excerpt)
  if (!quoted.ok) return fail(`${location.file}#L${start}-L${end}: excerpt ${quoted.reason}`)
  return pass
}

async function check(claim: Claim, options: WitnessOptions): Promise<Check> {
  switch (claim.tag) {
    case "VERIFIED": {
      if (!claim.source && !claim.location)
        return fail("VERIFIED needs evidence: a cached source quote or a code location")
      if (claim.source) {
        const source = await options.cache.get(claim.source.sha256)
        if (!source)
          return fail(`source ${claim.source.sha256.slice(0, 16)} is not in the cache (or was tampered with)`)
        const quoted = verifyQuote(source.text, claim.source.quote)
        if (!quoted.ok) return fail(`quote ${quoted.reason}`)
      }
      if (claim.location) {
        if (!options.root) return fail("a code location needs the audited tree's root")
        const located = await checkLocation(options.root, claim.location)
        if (!located.ok) return located
      }
      return pass
    }
    case "INFERRED": {
      const unknown = (claim.parents ?? []).filter((parent) => options.known && !options.known.has(parent))
      if (unknown.length) return fail(`unknown parent claim(s): ${unknown.map((id) => id.slice(0, 12)).join(", ")}`)
      // Legacy INFERRED_REQUIRES_LOGIC: the reasoning is the claim's evidence;
      // the statement is not a substitute for it.
      if (!claim.reasoning?.trim()) return fail("INFERRED needs its reasoning (deductive logic)")
      return pass
    }
    case "HYPOTHESIS":
      // Legacy HYPOTHESIS_REQUIRES_FALSIFICATION.
      return claim.falsification?.trim() ? pass : fail("HYPOTHESIS needs its falsification (how to test it)")
    case "NEGATIVE_KNOWLEDGE":
      return claim.query && claim.finding ? pass : fail("NEGATIVE_KNOWLEDGE needs a query and a finding")
  }
}

export async function witnessClaim(claim: Claim, options: WitnessOptions): Promise<Witness> {
  const result = await check(claim, options)
  const checkedAt = (options.now ?? (() => new Date()))().toISOString()
  return result.ok ? { ok: true, checkedAt } : { ok: false, checkedAt, reason: result.reason }
}
