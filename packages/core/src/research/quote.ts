// Pure verbatim-quote verification. A quote matches when, after normalising
// whitespace and typographic punctuation (curly quotes, dashes, NBSP), it
// appears in the source exactly. An ellipsis ("..." or "…") splits a prose
// quote into fragments that must appear in order, and each fragment must be
// evidence on its own (MIN_QUOTE characters). Code excerpts are one contiguous
// span (verifySpan): "..." there is code, not an ellipsis. No fuzzy matching:
// a quote is either in the source or it is not.

/** Shortest quote, and shortest ellipsis fragment, that counts as evidence (normalised characters). */
export const MIN_QUOTE = 12

const TYPOGRAPHY: Array<[RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, "-"],
  [/[  -​  　]/g, " "],
]

export function normalizeForQuote(text: string): string {
  let out = text.normalize("NFKC")
  for (const [pattern, replacement] of TYPOGRAPHY) out = out.replace(pattern, replacement)
  // Markdown emphasis and link syntax should not break a quote of the rendered text.
  out = stripMarkdownLinks(out).replaceAll(/\*\*|__|`/g, "")
  return out.replaceAll(/\s+/g, " ").trim()
}

/** `[label](target)` → `label`, scanning left to right (the label has no "]", the target no ")"). */
function stripMarkdownLinks(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const open = text.indexOf("[", i)
    if (open < 0) break
    const close = text.indexOf("]", open + 1)
    const end = close >= 0 && text[close + 1] === "(" ? text.indexOf(")", close + 2) : -1
    if (end < 0) {
      out += text.slice(i, open + 1)
      i = open + 1
      continue
    }
    out += text.slice(i, open) + text.slice(open + 1, close)
    i = end + 1
  }
  return out + text.slice(i)
}

export interface QuoteCheck {
  readonly ok: boolean
  /** Character offset of the first fragment in the normalised source. */
  readonly index?: number
  readonly reason?: string
}

/** Split a prose quote on ellipses; each fragment must stand as evidence. */
function quoteFragments(quote: string): string[] {
  return normalizeForQuote(quote)
    .split(/\.\.\.|…/)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
}

export function verifyQuote(source: string, quote: string): QuoteCheck {
  const fragments = quoteFragments(quote)
  if (fragments.length === 0) return { ok: false, reason: "empty quote" }
  if (fragments.length === 1 && fragments[0]!.length < MIN_QUOTE)
    return { ok: false, reason: `quote too short to be evidence (need at least ${MIN_QUOTE} characters)` }
  const short = fragments.find((fragment) => fragment.length < MIN_QUOTE)
  if (short !== undefined)
    return {
      ok: false,
      reason: `quote fragment too short to be evidence: "${short.slice(0, 40)}" (each fragment between ellipses needs at least ${MIN_QUOTE} characters)`,
    }
  const haystack = normalizeForQuote(source)
  let from = 0
  let first: number | undefined
  for (const fragment of fragments) {
    const at = haystack.indexOf(fragment, from)
    if (at < 0) return { ok: false, reason: `not found verbatim: "${fragment.slice(0, 80)}"` }
    first ??= at
    from = at + fragment.length
  }
  return { ok: true, index: first! }
}

/** One contiguous verbatim span (code excerpts): no ellipsis splitting, at least MIN_QUOTE characters. */
export function verifySpan(source: string, span: string): QuoteCheck {
  const needle = normalizeForQuote(span)
  if (needle.length < MIN_QUOTE)
    return { ok: false, reason: `too short to be evidence (need at least ${MIN_QUOTE} characters)` }
  const at = normalizeForQuote(source).indexOf(needle)
  return at < 0 ? { ok: false, reason: `not found verbatim: "${needle.slice(0, 80)}"` } : { ok: true, index: at }
}

export interface NormalizedMap {
  /** Exactly what `normalizeForQuote` returns for the same input. */
  readonly text: string
  /** Original offset of each normalised character (non-decreasing). */
  readonly map: readonly number[]
}

interface CharSlot {
  ch: string
  src: number
}

const typographyOf = (() => {
  // Non-global copies: `test` on a /g pattern would carry lastIndex state.
  const folds = TYPOGRAPHY.map(([pattern, replacement]) => [new RegExp(pattern.source), replacement] as const)
  return (ch: string): string => {
    for (const [pattern, replacement] of folds) if (pattern.test(ch)) return replacement
    return ch
  }
})()

/**
 * `normalizeForQuote` with an index map, step for step: per-character NFKC
 * (whole-string NFKC differs only for exotic compositions), typography
 * folds, markdown-link stripping, emphasis removal, whitespace collapsing
 * and trimming. The contract is `normalizeWithMap(x).text ===
 * normalizeForQuote(x)` (tested); `locateQuote` additionally self-checks
 * every range it derives, so a divergence degrades to "no highlight",
 * never to a wrong highlight.
 */
export function normalizeWithMap(text: string): NormalizedMap {
  let slots: CharSlot[] = []
  for (let i = 0; i < text.length; i++) {
    const normalized = text[i]!.normalize("NFKC")
    for (const ch of normalized) slots.push({ ch, src: i })
  }
  slots = slots.map((slot) => ({ ch: typographyOf(slot.ch), src: slot.src }))
  // stripMarkdownLinks, carrying offsets.
  const kept: CharSlot[] = []
  {
    let i = 0
    const chars = slots.map((slot) => slot.ch).join("")
    while (i < slots.length) {
      const open = chars.indexOf("[", i)
      if (open < 0) break
      const close = chars.indexOf("]", open + 1)
      const end = close >= 0 && chars[close + 1] === "(" ? chars.indexOf(")", close + 2) : -1
      if (end < 0) {
        kept.push(slots[open]!)
        i = open + 1
        continue
      }
      for (let k = i; k < open; k++) kept.push(slots[k]!)
      for (let k = open + 1; k < close; k++) kept.push(slots[k]!)
      i = end + 1
    }
    for (let k = i; k < slots.length; k++) kept.push(slots[k]!)
  }
  slots = kept.filter((slot) => slot.ch !== "*" && slot.ch !== "_" && slot.ch !== "`")
  // Whitespace runs collapse to one space, kept at the run's first offset.
  const collapsed: CharSlot[] = []
  for (const slot of slots) {
    if (/\s/.test(slot.ch)) {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1]!.ch !== " ")
        collapsed.push({ ch: " ", src: slot.src })
    } else collapsed.push(slot)
  }
  while (collapsed.length > 0 && collapsed[0]!.ch === " ") collapsed.shift()
  while (collapsed.length > 0 && collapsed[collapsed.length - 1]!.ch === " ") collapsed.pop()
  return { text: collapsed.map((slot) => slot.ch).join(""), map: collapsed.map((slot) => slot.src) }
}

export interface QuoteRange {
  /** Original-text offsets: `source.slice(start, end)` is the fragment. */
  readonly start: number
  readonly end: number
}

/**
 * Where each ellipsis fragment of `quote` sits in the original `source`.
 * `verifyQuote` stays the decision authority: anything it refuses is
 * `undefined` here. Normalisation drops characters (link targets,
 * emphasis marks), so one fragment can become several ranges — split
 * wherever the index map jumps over non-whitespace. Whitespace-only gaps
 * (collapsed runs) are absorbed into the range. Every result is
 * self-checked (the ranges must normalise back to the fragment modulo
 * whitespace); a divergence returns `undefined` instead of a wrong
 * highlight.
 */
export function locateQuote(source: string, quote: string): QuoteRange[] | undefined {
  if (!verifyQuote(source, quote).ok) return undefined
  const { text: haystack, map } = normalizeWithMap(source)
  const ranges: QuoteRange[] = []
  let from = 0
  for (const fragment of quoteFragments(quote)) {
    const at = haystack.indexOf(fragment, from)
    if (at < 0) return undefined
    const before = ranges.length
    let start = map[at]!
    let end = start + 1
    for (let j = at + 1; j < at + fragment.length; j++) {
      const offset = map[j]!
      if (offset <= end) {
        end = Math.max(end, offset + 1)
      } else if (/^\s*$/.test(source.slice(end, offset))) {
        end = offset + 1
      } else {
        ranges.push({ start, end })
        start = offset
        end = offset + 1
      }
    }
    ranges.push({ start, end })
    const back = ranges
      .slice(before)
      .map((range) => normalizeForQuote(source.slice(range.start, range.end)))
      .join("")
    if (back.replace(/\s+/g, "") !== fragment.replace(/\s+/g, "")) return undefined
    from = at + fragment.length
  }
  return ranges
}
