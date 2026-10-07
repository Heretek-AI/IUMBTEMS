// WCAG contrast gate for queereye. Colors are authored from the desired
// contrast ratio with the WCAG minimum as the starting point: every text
// pair ships a computed ratio of at least 4.5:1 for body text (3:1 for
// large text). The 7:1 AAA enhanced level is reported, never required.
export const WCAG_AA_NORMAL = 4.5
export const WCAG_AA_LARGE = 3.0
export const WCAG_AAA_ENHANCED = 7.0

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export class ContrastError extends Error {}

export type Rgb = readonly [number, number, number]

/** Parse `#rgb` / `#rrggbb` into an (r, g, b) 0-255 tuple. */
export function parseHex(value: unknown): Rgb {
  if (typeof value !== "string" || !HEX_RE.test(value.trim()))
    throw new ContrastError(`not a hex color: ${JSON.stringify(value)}`)
  let text = value.trim().slice(1)
  if (text.length === 3) text = [...text].map((char) => char + char).join("")
  return [
    Number.parseInt(text.slice(0, 2), 16),
    Number.parseInt(text.slice(2, 4), 16),
    Number.parseInt(text.slice(4, 6), 16),
  ]
}

const linearize = (channel: number) => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of an (r, g, b) tuple. */
export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

/** WCAG contrast ratio of two hex colors (1.0 - 21.0). */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const fg = relativeLuminance(parseHex(fgHex))
  const bg = relativeLuminance(parseHex(bgHex))
  const lighter = Math.max(fg, bg)
  const darker = Math.min(fg, bg)
  return (lighter + 0.05) / (darker + 0.05)
}

/** AA threshold for the text class. */
export const requiredRatio = (largeText = false) => (largeText ? WCAG_AA_LARGE : WCAG_AA_NORMAL)

export interface PairCheck {
  readonly ratio: number
  readonly required: number
  readonly errors: readonly string[]
}

/**
 * Gate one text color pair. A pair claimed as merely decorative is still
 * rejected when it fails the threshold: the decorative exemption never
 * excuses a text pair, so decorative-but-inaccessible is a compile error.
 */
export function validatePair(
  fgHex: string,
  bgHex: string,
  options: { largeText?: boolean; decorative?: boolean } = {},
): PairCheck {
  const ratio = contrastRatio(fgHex, bgHex)
  const threshold = requiredRatio(options.largeText ?? false)
  const errors: string[] = []
  if (ratio < threshold) {
    const kind = options.largeText ? "large text" : "body text"
    errors.push(`${fgHex} on ${bgHex}: ${ratio.toFixed(2)}:1 below AA ${kind} minimum ${threshold}:1`)
    if (options.decorative) errors.push("decorative exemption refused for a text pair")
  }
  return { ratio, required: threshold, errors }
}

const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`

/**
 * Ratio-first generation: nudge `fg` toward black or white (whichever
 * reaches the target with the smaller move) until it holds. Returns the
 * original (lowercased) when it already passes.
 */
export function ensureRatio(fgHex: string, bgHex: string, target = WCAG_AA_NORMAL): string {
  if (contrastRatio(fgHex, bgHex) >= target) return fgHex.toLowerCase()
  const fg = parseHex(fgHex)
  let best: { move: number; hex: string } | undefined
  for (const anchor of [
    [0, 0, 0],
    [255, 255, 255],
  ] as Rgb[]) {
    let lo = 0
    let hi = 1
    let candidate: { move: number; hex: string } | undefined
    for (let step = 0; step < 24; step++) {
      const mid = (lo + hi) / 2
      const mixed: Rgb = [0, 1, 2].map((index) =>
        Math.round(fg[index]! + (anchor[index]! - fg[index]!) * mid),
      ) as unknown as Rgb
      const hexed = toHex(mixed)
      if (contrastRatio(hexed, bgHex) >= target) {
        candidate = { move: mid, hex: hexed }
        hi = mid
      } else lo = mid
    }
    if (candidate && (!best || candidate.move < best.move)) best = candidate
  }
  if (!best) throw new ContrastError(`no mix of ${fgHex} on ${bgHex} reaches ${target}:1`)
  return best.hex
}

export interface ProbePair {
  readonly name: string
  readonly fg: string
  readonly bg: string
  readonly large?: boolean
}

/** Probe table rows (pure data for the guide renderer). */
export function probeReport(pairs: readonly ProbePair[]) {
  return pairs.map((pair) => {
    const check = validatePair(pair.fg, pair.bg, { largeText: pair.large ?? false })
    return {
      name: pair.name,
      fg: pair.fg,
      bg: pair.bg,
      large_text: pair.large ?? false,
      ratio: Number(check.ratio.toFixed(2)),
      aa_threshold: check.required,
      aaa_enhanced: WCAG_AAA_ENHANCED,
      aaa_pass: check.ratio >= WCAG_AAA_ENHANCED,
      pass: check.errors.length === 0,
      errors: [...check.errors],
    }
  })
}

/** Fail-fast gate over probe rows: returns failing rows (empty = green). */
export const gatePairs = (pairs: readonly ProbePair[]) => probeReport(pairs).filter((row) => !row.pass)
