// Dependency-free HTML → readable markdown-ish text for cached sources.
// A small linear tokenizer (no backtracking regexes, no tag-stripping regex)
// drops scripts, styles and chrome and keeps headings, paragraphs, lists,
// links, code and table cells. Good enough for quoting, not a renderer.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value =
        code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : match
    }
    return ENTITIES[code.toLowerCase()] ?? match
  })
}

/** Elements whose content is dropped entirely. */
const DROP = new Set(["script", "style", "noscript", "svg", "nav", "footer", "header", "form", "iframe", "template"])
/** Closing elements that end a line. */
const BLOCK_END = new Set(["p", "div", "section", "li", "ul", "ol", "table", "tr", "blockquote", "dd", "dt"])
/** Void elements that never have a closing tag. */
const VOID = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "area",
  "base",
  "col",
  "embed",
  "source",
  "track",
  "wbr",
])

interface Token {
  readonly tag: boolean
  readonly name: string
  readonly closing: boolean
  readonly selfClosing: boolean
  readonly attrs: string
  readonly text: string
}

/** Split HTML into text and tag tokens in one linear pass (never backtracks). */
function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  const text = (value: string) =>
    tokens.push({ tag: false, name: "", closing: false, selfClosing: false, attrs: "", text: value })
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt < 0) {
      text(html.slice(i))
      break
    }
    if (lt > i) text(html.slice(i, lt))
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    const gt = html.indexOf(">", lt)
    if (gt < 0) {
      text(html.slice(lt))
      break
    }
    const raw = html.slice(lt + 1, gt).trim()
    const closing = raw.startsWith("/")
    const body = closing ? raw.slice(1) : raw
    const name = (/^[a-zA-Z][a-zA-Z0-9-]*/.exec(body)?.[0] ?? "").toLowerCase()
    tokens.push({
      tag: true,
      name,
      closing,
      selfClosing: raw.endsWith("/") || VOID.has(name),
      attrs: body.slice(name.length),
      text: "",
    })
    i = gt + 1
  }
  return tokens
}

/** `href` value from a tag's attribute string (fixed, linear patterns). */
function hrefOf(attrs: string): string | undefined {
  const double = /href[ \t]*=[ \t]*"([^"]*)"/i.exec(attrs)
  if (double) return double[1]
  const single = /href[ \t]*=[ \t]*'([^']*)'/i.exec(attrs)
  return single?.[1]
}

interface Capture {
  readonly kind: "pre" | "code" | "heading" | "anchor"
  readonly level?: number
  readonly href?: string
  readonly inner: string[]
}

export function htmlToText(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  const title = titleMatch?.[1] !== undefined ? decodeEntities(titleMatch[1].trim()) : undefined

  // Prefer <body>, then <main>/<article> when it holds the bulk of the page.
  let body = html
  const bodyOpen = /<body[^>]*>/i.exec(html)
  if (bodyOpen) {
    const start = bodyOpen.index + bodyOpen[0].length
    const end = html.lastIndexOf("</body>")
    body = end > start ? html.slice(start, end) : html.slice(start)
  }
  const mainOpen = /<(?:main|article)[^>]*>/i.exec(body)
  if (mainOpen) {
    const name = /^<(?:main|article)/i.exec(mainOpen[0])![0].slice(1).toLowerCase()
    const start = mainOpen.index + mainOpen[0].length
    const end = body.lastIndexOf(`</${name}>`)
    const inner = end > start ? body.slice(start, end) : body.slice(start)
    if (inner.length > 500) body = inner
  }

  const out: string[] = []
  let dropDepth = 0
  let capture: Capture | undefined
  const append = (value: string) => {
    if (dropDepth > 0) return
    if (capture) capture.inner.push(value)
    else out.push(value)
  }

  const finish = (name: string, cap: Capture): boolean => {
    if (cap.kind === "pre" && name === "pre") {
      out.push(`\n\n\`\`\`\n${cap.inner.join("")}\n\`\`\`\n\n`)
      return true
    }
    if (cap.kind === "code" && name === "code") {
      out.push(`\`${cap.inner.join("")}\``)
      return true
    }
    if (cap.kind === "heading" && name === `h${cap.level}`) {
      out.push(`\n\n${"#".repeat(cap.level!)} ${cap.inner.join("").trim()}\n\n`)
      return true
    }
    if (cap.kind === "anchor" && name === "a") {
      const label = cap.inner.join("").trim()
      out.push(label && cap.href && /^https?:/.test(cap.href) ? `[${label}](${cap.href})` : label)
      return true
    }
    return false
  }

  for (const token of tokenize(body)) {
    if (!token.tag) {
      append(token.text)
      continue
    }
    if (token.name === "") continue
    if (DROP.has(token.name)) {
      if (!token.selfClosing) {
        dropDepth += token.closing ? -1 : 1
        if (dropDepth < 0) dropDepth = 0
      }
      continue
    }
    if (dropDepth > 0) continue
    if (token.closing) {
      if (capture && finish(token.name, capture)) capture = undefined
      else if (BLOCK_END.has(token.name)) out.push("\n")
      else if (token.name === "td" || token.name === "th") out.push(" | ")
      continue
    }
    if (capture) continue // nested markup inside a capture contributes only its text
    if (token.name === "pre") capture = { kind: "pre", inner: [] }
    else if (token.name === "code") capture = { kind: "code", inner: [] }
    else if (/^h[1-6]$/.test(token.name)) capture = { kind: "heading", level: Number(token.name[1]), inner: [] }
    else if (token.name === "a") capture = { kind: "anchor", href: hrefOf(token.attrs), inner: [] }
    else if (token.name === "li") out.push("\n- ")
    else if (token.name === "br" || token.name === "hr") out.push("\n")
  }

  const text = decodeEntities(out.join(""))
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return { ...(title ? { title } : {}), text }
}
