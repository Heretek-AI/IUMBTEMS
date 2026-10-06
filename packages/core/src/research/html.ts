// Dependency-free HTML → readable markdown-ish text for cached sources.
// Drops scripts, styles and chrome; keeps headings, paragraphs, lists, links,
// code and table cells. Good enough for quoting, not a renderer.

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

export function htmlToText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(body)?.[2]
  if (main && main.length > 500) body = main
  let text = body
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
      (_, code: string) => `\n\n\`\`\`\n${code.replace(/<[^>]+>/g, "")}\n\`\`\`\n\n`,
    )
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code: string) => `\`${code.replace(/<[^>]+>/g, "")}\``)
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, level: string, inner: string) =>
        `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`,
    )
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim()
      return label && /^https?:/.test(href) ? `[${label}](${href})` : label
    })
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|li|ul|ol|table|tr|blockquote|dd|dt)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
  text = decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return { ...(title ? { title: decodeEntities(title.trim()) } : {}), text }
}
