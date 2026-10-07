// Style-Dictionary-compat CSS-var compile and the pure STYLE_GUIDE render.
// The guide is a pure function of tokens.json + probe output, so drift is
// impossible by construction (byte-match + `--check` gate).

import type { ProbeRow } from "../schema/queereye.ts"
import { aliasReuseRatio, DTCG_SNAPSHOT, findOneOffs, isAliasValue, isToken, iterTokens } from "./tokens.ts"

const ALIAS_RE = /\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}/

/** `("color","primitive","brand-500")` → `--color-primitive-brand-500`. */
export const varName = (path: readonly string[]) => `--${path.join("-")}`

/**
 * Rewrite a pure `{dotted.ref}` as `var(--dotted-ref)`. Mixed raw + alias
 * values are refused with a structured error, never silently
 * prefix-preserving shipped.
 */
export function aliasToVarRef(value: unknown): string {
  if (typeof value !== "string") throw new Error(`alias value must be a string, got ${typeof value}`)
  if (!isAliasValue(value)) {
    if (ALIAS_RE.test(value))
      throw new Error(`mixed raw + alias value refused: ${JSON.stringify(value)}; must be a pure '{dotted.ref}' alias`)
    throw new Error(`not a pure alias value: ${JSON.stringify(value)}; must be '{dotted.ref}'`)
  }
  const match = ALIAS_RE.exec(value.trim())!
  return `var(--${match[1]!.replaceAll(".", "-")})`
}

/** Format a raw (non-alias) `$value` as CSS. */
export function formatRawValue(value: unknown): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (Object.keys(record).length === 2 && "value" in record && "unit" in record)
      return `${record.value}${record.unit}`
  }
  return String(value)
}

export interface Declaration {
  readonly name: string
  readonly css: string
  readonly path: readonly string[]
  readonly alias: boolean
}

/** Declarations sorted by var name; mixed raw + alias values throw. */
export function iterDeclarations(tree: unknown, prefix: readonly string[] = []): Declaration[] {
  const rows: Declaration[] = []
  const walk = (node: unknown, path: readonly string[]) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      if (key.startsWith("$")) continue
      const child = record[key]
      const childPath = [...path, key]
      if (isToken(child)) {
        const raw = (child as Record<string, unknown>).$value
        if (typeof raw === "string" && ALIAS_RE.test(raw)) {
          try {
            rows.push({ name: varName(childPath), css: aliasToVarRef(raw), path: childPath, alias: true })
          } catch (error) {
            throw new Error(`${childPath.join(".")}: ${error instanceof Error ? error.message : String(error)}`)
          }
        } else rows.push({ name: varName(childPath), css: formatRawValue(raw), path: childPath, alias: false })
      } else if (typeof child === "object" && child !== null) walk(child, childPath)
    }
  }
  walk(tree, prefix)
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

/** Compile a token tree to `:root` CSS custom properties (deterministic). */
export function compileToCssVars(tree: unknown, snapshot = DTCG_SNAPSHOT): string {
  const lines = [
    "/* Queereye tokens — Style-Dictionary-compat CSS vars */",
    `/* DTCG snapshot pin: ${snapshot} (shape pin; clean-room schema, no vendored DTCG JSON) */`,
    ":root {",
  ]
  for (const declaration of iterDeclarations(tree)) lines.push(`  ${declaration.name}: ${declaration.css};`)
  lines.push("}", "")
  return lines.join("\n")
}

/** Text color pairs derived from token color primitives (gate input). */
export function pairsFromTokens(tree: unknown): Array<{ name: string; fg: string; bg: string; large?: boolean }> {
  const prim = (tree as any)?.color?.primitive
  if (!prim) return []
  const pairs: Array<{ name: string; fg: string; bg: string; large?: boolean }> = []
  try {
    pairs.push({ name: "body on paper", fg: prim["neutral-500"].$value, bg: prim.paper.$value })
    pairs.push({ name: "brand on paper", fg: prim["brand-500"].$value, bg: prim.paper.$value })
    pairs.push({ name: "body on dark", fg: prim["dark-ink"].$value, bg: prim["dark-surface"].$value })
    if (prim["accent-500"])
      pairs.push({ name: "accent large on paper", fg: prim["accent-500"].$value, bg: prim.paper.$value, large: true })
  } catch {
    return []
  }
  return pairs
}

/** Pure render of STYLE_GUIDE.md from tokens + probe output (deterministic). */
export function renderGuide(tree: unknown, probeRows: readonly ProbeRow[], snapshot = DTCG_SNAPSHOT): string {
  const reuse = aliasReuseRatio(tree)
  const oneOffs = findOneOffs(tree)
  const lines: string[] = []
  lines.push("# STYLE_GUIDE — Queereye tokens")
  lines.push("")
  lines.push(
    `_Generated from \`.factory/design/tokens.json\` (DTCG snapshot pin \`${snapshot}\`) + contrast-probe output. ` +
      "Do not hand-edit: run the renderer. The W3C Design Tokens Community Group defines design tokens as a " +
      "platform-agnostic methodology for expressing design decisions; Style Dictionary generates style definitions " +
      "across platforms from a single source._",
  )
  lines.push("")
  lines.push("## Provenance")
  lines.push("")
  lines.push(`- DTCG snapshot pin: \`${snapshot}\``)
  lines.push(`- Tokens: ${reuse.total} total, ${reuse.aliased} aliased, reuse ratio ${reuse.ratio.toFixed(2)}`)
  lines.push(`- One-off raw tokens outside primitive: ${oneOffs.length}`)
  for (const oneOff of [...oneOffs].sort((a, b) => a.path.localeCompare(b.path)))
    lines.push(`  - \`${oneOff.path}\`: ${oneOff.reason}`)
  lines.push(
    "- WCAG 2.2 SC 1.4.3 Contrast (Minimum): body text >= 4.5:1, large >= 3:1; colors are authored from the desired " +
      "contrast ratio with the WCAG minimum as the starting point.",
  )
  lines.push("- AAA enhanced (7:1) is reported, never required (gate: AA).")
  lines.push("")
  lines.push("## Tokens")
  lines.push("")
  for (const { path, node, resolvedType } of [...iterTokens(tree)].sort((a, b) =>
    a.path.join(".").localeCompare(b.path.join(".")),
  )) {
    const dotted = path.join(".")
    const raw = (node as Record<string, unknown>).$value
    const rawText = typeof raw === "object" && raw !== null ? JSON.stringify(sortKeys(raw)) : String(raw)
    const description = (node as Record<string, unknown>).$description
    lines.push(`- \`${dotted}\` (\`${resolvedType}\`) = \`${rawText}\`${description ? ` — ${description}` : ""}`)
  }
  lines.push("")
  lines.push("## Contrast probes")
  lines.push("")
  lines.push("| pair | fg on bg | ratio | AA | AAA 7:1 | result |")
  lines.push("| --- | --- | --- | --- | --- | --- |")
  for (const row of probeRows)
    lines.push(
      `| ${row.name} | ${row.fg} on ${row.bg} | ${row.ratio.toFixed(2)}:1 | ${row.aa_threshold}:1 | ${row.aaa_pass ? "yes" : "no"} | ${row.pass ? "PASS" : "FAIL"} |`,
    )
  lines.push("")
  lines.push("## CSS vars (Style-Dictionary-compat compile)")
  lines.push("")
  lines.push("```css")
  lines.push(compileToCssVars(tree, snapshot).replace(/\n$/, ""))
  lines.push("```")
  lines.push("")
  lines.push("<!-- thresholds: AA-normal=4.5 AA-large=3 AAA=7 -->")
  lines.push("")
  return lines.join("\n")
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortKeys(item)]),
    )
  return value
}
