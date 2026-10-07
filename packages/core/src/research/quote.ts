// Pure verbatim-quote verification. A quote matches when, after normalising
// whitespace and typographic punctuation (curly quotes, dashes, NBSP), it
// appears in the source exactly. An ellipsis ("..." or "…") splits a quote into
// fragments that must appear in order. No fuzzy matching: a quote is either in
// the source or it is not.

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

export function verifyQuote(source: string, quote: string): QuoteCheck {
  const fragments = normalizeForQuote(quote)
    .split(/\.\.\.|…/)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
  if (fragments.length === 0) return { ok: false, reason: "empty quote" }
  if (fragments.join(" ").length < 12)
    return { ok: false, reason: "quote too short to be evidence (need at least 12 characters)" }
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
