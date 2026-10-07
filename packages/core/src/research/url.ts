// Cache keys and freshness for fetched pages, ported from legacy
// skills/epistemic_search/scripts/webcache.py (canonical_url, ttl_days,
// is_fresh). canonicalUrl reproduces Python's urlsplit + parse_qsl +
// urlencode rather than WHATWG URL, whose normalisation differs; the test
// fixture is generated from the legacy function itself.

const DEFAULT_TTL_DAYS = 7
const DOC_DOMAIN_TTL_DAYS = 30
/** Documentation hosts whose pages change slowly (legacy DOC_DOMAINS). */
export const DOC_DOMAINS = [
  "code.claude.com",
  "docs.anthropic.com",
  "platform.claude.com",
  "docs.python.org",
  "developer.mozilla.org",
] as const

const utf8 = new TextEncoder()
const decoder = new TextDecoder("utf-8")

/** Python's unquote(errors="replace"): %XX bytes, then UTF-8 with U+FFFD for bad sequences. */
function unquote(text: string): string {
  const bytes: number[] = []
  for (let i = 0; i < text.length; ) {
    if (text[i] === "%" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16))
      i += 3
      continue
    }
    const point = text.codePointAt(i)!
    const char = String.fromCodePoint(point)
    bytes.push(...utf8.encode(char))
    i += char.length
  }
  return decoder.decode(new Uint8Array(bytes))
}

/** Python's quote_plus(safe=""): alphanumerics and _.-~ stay, space → "+", the rest %XX. */
function quotePlus(text: string): string {
  let out = ""
  for (const byte of utf8.encode(text)) {
    const char = String.fromCharCode(byte)
    if (/[A-Za-z0-9_.\-~]/.test(char)) out += char
    else if (byte === 0x20) out += "+"
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  }
  return out
}

/** Python's parse_qsl(keep_blank_values=True) (separator "&"). */
function parseQsl(query: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const piece of query.split("&")) {
    if (!piece) continue
    const eq = piece.indexOf("=")
    const [name, value] = eq < 0 ? [piece, ""] : [piece.slice(0, eq), piece.slice(eq + 1)]
    pairs.push([unquote(name.replaceAll("+", " ")), unquote(value.replaceAll("+", " "))])
  }
  return pairs
}

const byCodePoint = (a: string, b: string) => {
  const left = [...a].map((char) => char.codePointAt(0)!)
  const right = [...b].map((char) => char.codePointAt(0)!)
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!
  return left.length - right.length
}

/**
 * The cache key for a URL: lowercase host, default ports dropped, fragment
 * dropped, query pairs sorted, empty path "/". Undefined when there is no host.
 */
export function canonicalUrl(raw: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/s.exec(raw.trim())
  if (!match) return undefined
  const scheme = match[1]!.toLowerCase()
  const hostinfo = match[2]!.slice(match[2]!.lastIndexOf("@") + 1)
  let host: string
  let port: string
  if (hostinfo.includes("[")) {
    const bracketed = hostinfo.slice(hostinfo.indexOf("[") + 1)
    const close = bracketed.indexOf("]")
    host = close < 0 ? bracketed : bracketed.slice(0, close)
    const rest = close < 0 ? "" : bracketed.slice(close + 1)
    port = rest.includes(":") ? rest.slice(rest.indexOf(":") + 1) : ""
  } else {
    const colon = hostinfo.indexOf(":")
    host = colon < 0 ? hostinfo : hostinfo.slice(0, colon)
    port = colon < 0 ? "" : hostinfo.slice(colon + 1)
  }
  host = host.toLowerCase()
  if (!host) return undefined
  let portNumber: number | undefined
  if (port) {
    if (!/^[0-9]+$/.test(port)) return undefined
    portNumber = Number(port)
    if (portNumber > 65535) return undefined
  }
  if ((scheme === "http" && portNumber === 80) || (scheme === "https" && portNumber === 443)) portNumber = undefined
  const netloc = portNumber !== undefined ? `${host}:${portNumber}` : host
  const query = parseQsl(match[4] ?? "")
    .sort(([ak, av], [bk, bv]) => byCodePoint(ak, bk) || byCodePoint(av, bv))
    .map(([name, value]) => `${quotePlus(name)}=${quotePlus(value)}`)
    .join("&")
  return `${scheme}://${netloc}${match[3] || "/"}${query ? `?${query}` : ""}`
}

/** Days a cached page stays fresh: an explicit override, else 30 for documentation hosts, else 7. */
export function ttlDays(url: string, override?: number): number {
  if (override !== undefined) return Math.max(0, Math.floor(override))
  const host = canonicalUrl(url)?.split("/")[2]?.split(":")[0] ?? ""
  return DOC_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
    ? DOC_DOMAIN_TTL_DAYS
    : DEFAULT_TTL_DAYS
}

/** Whether a snapshot retrieved at `retrieved` (ISO) is still fresh for `url`. */
export function isFresh(retrieved: string, url: string, options: { ttlDays?: number; now?: Date } = {}): boolean {
  const at = Date.parse(retrieved)
  if (Number.isNaN(at)) return false
  const ageDays = ((options.now ?? new Date()).getTime() - at) / 86_400_000
  return ageDays <= ttlDays(url, options.ttlDays)
}
