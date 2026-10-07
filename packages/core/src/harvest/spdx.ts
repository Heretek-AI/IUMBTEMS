// Deterministic SPDX license detection over local bytes, fail-closed.
//
// - A permissive or public-domain result needs an exact full-text match of a
//   bundled SPDX template (templates.ts): extra or changed terms — a rider like
//   the Commons Clause, the JSON licence's "Good, not Evil" — mean "unknown".
// - Copyleft and source-available licences are recognised by their title and
//   date lines (GPL-3.0 is not mistaken for AGPL because §13 mentions it).
// - Every licence file in the root counts (LICENSE*, COPYING*, UNLICENSE…);
//   the most restrictive wins, and several permissive ones combine with AND.
// - `SPDX-License-Identifier` headers are declarations by single files: they
//   add restrictions (a GPL header in an MIT repo makes it GPL) but never
//   verify a licence on their own.
// - Manifest fields are self-reported claims (verified: false).
// Unknown or non-whitelisted licences end up clean-room in the policy.
import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"
import type { LicenseFinding } from "../schema/harvest.ts"
import { readRegularFile } from "../util/fs.ts"
import { LICENSE_TEMPLATES, matchLicenseTemplate } from "./templates.ts"

type Family = LicenseFinding["family"]

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const FAMILIES: Readonly<Record<string, Family>> = {
  MIT: "permissive",
  "Apache-2.0": "permissive",
  "BSD-2-Clause": "permissive",
  "BSD-3-Clause": "permissive",
  "BSD-4-Clause": "permissive",
  ISC: "permissive",
  "0BSD": "permissive",
  Unlicense: "public-domain",
  "CC0-1.0": "public-domain",
  "MPL-1.1": "weak-copyleft",
  "MPL-2.0": "weak-copyleft",
  "LGPL-2.0": "weak-copyleft",
  "LGPL-2.1": "weak-copyleft",
  "LGPL-3.0": "weak-copyleft",
  "EPL-1.0": "weak-copyleft",
  "EPL-2.0": "weak-copyleft",
  "CDDL-1.0": "weak-copyleft",
  "GPL-1.0": "copyleft",
  "GPL-2.0": "copyleft",
  "GPL-3.0": "copyleft",
  "AGPL-1.0": "copyleft",
  "AGPL-3.0": "copyleft",
  "EUPL-1.2": "copyleft",
  "SSPL-1.0": "copyleft",
}

const CANONICAL: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.keys(FAMILIES).map((id) => [id.toLowerCase(), id])),
  "gpl-2.0-only": "GPL-2.0",
  "gpl-2.0-or-later": "GPL-2.0",
  "gpl-3.0-only": "GPL-3.0",
  "gpl-3.0-or-later": "GPL-3.0",
  "agpl-3.0-only": "AGPL-3.0",
  "agpl-3.0-or-later": "AGPL-3.0",
  "lgpl-2.1-only": "LGPL-2.1",
  "lgpl-2.1-or-later": "LGPL-2.1",
  "lgpl-3.0-only": "LGPL-3.0",
  "lgpl-3.0-or-later": "LGPL-3.0",
}

/** Restrictiveness for aggregation: the most restrictive family wins. */
const RANK: Readonly<Record<Family, number>> = {
  "public-domain": 0,
  permissive: 1,
  unknown: 2,
  "weak-copyleft": 3,
  copyleft: 4,
}

/** The licence family for an SPDX id or an AND/OR expression of ids (unknown ids stay unknown). */
export function familyOf(spdx: string): Family {
  const ids = spdxIds(spdx)
  if (ids.length > 1)
    return ids.map(familyOf).reduce((worst, family) => (RANK[family] > RANK[worst] ? family : worst), "public-domain")
  const id = normalizeLicenseId(spdx)
  const known = FAMILIES[id]
  if (known) return known
  const lower = id.toLowerCase()
  if (lower.startsWith("agpl") || lower.startsWith("gpl")) return "copyleft"
  if (lower.startsWith("lgpl") || lower.startsWith("mpl") || lower.startsWith("epl") || lower.startsWith("cddl"))
    return "weak-copyleft"
  return "unknown"
}

export function normalizeLicenseId(id: string): string {
  let trimmed = id.trim()
  while (trimmed.endsWith("`") || trimmed.endsWith(";")) trimmed = trimmed.slice(0, -1)
  return CANONICAL[trimmed.toLowerCase()] ?? trimmed
}

/**
 * The ids in an SPDX expression. AND and OR are both kept (OR is treated
 * conservatively, as if every id applied); `WITH <exception>` is dropped, since
 * exceptions only add permissions.
 */
export function spdxIds(expression: string): string[] {
  const tokens = expression.replace(/[()]/g, " ").split(/\s+/).filter(Boolean)
  const ids: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (/^(and|or)$/i.test(token)) continue
    if (/^with$/i.test(token)) {
      i++
      continue
    }
    ids.push(normalizeLicenseId(token))
  }
  return [...new Set(ids)]
}

/** Lowercase, straighten typography and collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -​  　]/g, " ")
    .replace(/\blicenc(e|es|ed)\b/g, "licens$1")
    .replace(/\s+/g, " ")
    .trim()
}

export interface IdentifiedLicense {
  readonly spdx: string
  readonly family: Family
  /** True when the licence is established from its text (template match, or a copyleft title). */
  readonly verified: boolean
  readonly method: "template" | "title" | "resemblance"
  readonly note?: string
}

interface Rule {
  readonly test: (head: string, body: string) => string | undefined
  readonly note?: string
}

// Titles are checked in the first lines only: the GPL-2.0 preamble mentions the
// Lesser GPL and GPL-3.0 §13 the Affero GPL. Date lines catch texts that sit
// under a project notice.
const has = (text: string, ...phrases: string[]) => phrases.every((phrase) => text.includes(phrase))
const title = (phrase: string, spdx: string | ((head: string) => string), note?: string): Rule => ({
  test: (head) => (head.includes(phrase) ? (typeof spdx === "string" ? spdx : spdx(head)) : undefined),
  ...(note ? { note } : {}),
})
const SOURCE_AVAILABLE = "source-available, not open source"
const RESTRICTIVE: readonly Rule[] = [
  {
    test: (_, body) => (body.includes("commons clause") ? "LicenseRef-Commons-Clause" : undefined),
    note: "a Commons Clause rider withholds the right to sell; not an open-source licence",
  },
  // 1. Titles (the first lines).
  title("gnu affero general public license", "AGPL-3.0"),
  title("gnu lesser general public license", (head) => (head.includes("version 2.1") ? "LGPL-2.1" : "LGPL-3.0")),
  title("gnu library general public license", "LGPL-2.0"),
  title("gnu general public license", (head) =>
    head.includes("version 3") ? "GPL-3.0" : head.includes("version 1,") ? "GPL-1.0" : "GPL-2.0",
  ),
  title("mozilla public license", (head) => (/version 2\.0|v\. 2\.0/.test(head) ? "MPL-2.0" : "MPL-1.1")),
  title("eclipse public license", (head) => (/v(ersion)? 2\.0/.test(head) ? "EPL-2.0" : "EPL-1.0")),
  title("common development and distribution license", "CDDL-1.0"),
  title("european union public license", "EUPL-1.2"),
  title("server side public license", "SSPL-1.0"),
  title("business source license", "BUSL-1.1", SOURCE_AVAILABLE),
  title("elastic license", "Elastic-2.0", SOURCE_AVAILABLE),
  // 2. Texts under a project notice: their distinctive date lines.
  { test: (_, body) => (has(body, "gnu affero general public license", "19 november 2007") ? "AGPL-3.0" : undefined) },
  { test: (_, body) => (has(body, "gnu lesser general public license", "february 1999") ? "LGPL-2.1" : undefined) },
  { test: (_, body) => (has(body, "gnu lesser general public license", "29 june 2007") ? "LGPL-3.0" : undefined) },
  { test: (_, body) => (has(body, "gnu general public license", "29 june 2007") ? "GPL-3.0" : undefined) },
  { test: (_, body) => (has(body, "gnu general public license", "june 1991") ? "GPL-2.0" : undefined) },
  { test: (_, body) => (has(body, "mozilla public license", "version 2.0") ? "MPL-2.0" : undefined) },
  { test: (_, body) => (body.includes("server side public license") ? "SSPL-1.0" : undefined) },
  {
    test: (_, body) => (body.includes("business source license") ? "BUSL-1.1" : undefined),
    note: SOURCE_AVAILABLE,
  },
  {
    test: (_, body) =>
      body.includes("all advertising materials mentioning features or use of this software must display")
        ? "BSD-4-Clause"
        : undefined,
    note: "the advertising clause is an obligation the whitelist does not cover",
  },
]

/** Permissive texts that are close to a template but did not match it exactly. */
const LOOKALIKES: ReadonlyArray<readonly [string, string]> = [
  ["MIT", "permission is hereby granted, free of charge"],
  ["ISC/0BSD", "permission to use, copy, modify, and/or distribute this software for any purpose"],
  ["ISC/0BSD", "permission to use, copy, modify, and distribute this software for any purpose"],
  ["BSD", "redistribution and use in source and binary forms"],
  ["Apache-2.0", "apache license"],
  ["Unlicense", "free and unencumbered software released into the public domain"],
  ["CC0-1.0", "cc0 1.0 universal"],
]

/** Identify one licence text. Undefined when nothing licence-like is recognised. */
export function identifyLicenseText(text: string): IdentifiedLicense | undefined {
  const exact = matchLicenseTemplate(text)
  if (exact) return { spdx: exact, family: familyOf(exact), verified: true, method: "template" }
  const body = normalizeText(text)
  const head = body.slice(0, 160)
  for (const rule of RESTRICTIVE) {
    const spdx = rule.test(head, body)
    if (!spdx) continue
    const family = familyOf(spdx)
    // Copyleft is established by its title (and fails closed anyway); a
    // permissive or source-available match without a template is not.
    const verified = family === "copyleft" || family === "weak-copyleft"
    return { spdx, family, verified, method: "title", ...(rule.note ? { note: rule.note } : {}) }
  }
  const lookalike = LOOKALIKES.find(([, phrase]) => body.includes(phrase))
  if (lookalike)
    return {
      spdx: "unknown",
      family: "unknown",
      verified: false,
      method: "resemblance",
      note: `resembles ${lookalike[0]} but does not match its SPDX template (changed or extra terms)`,
    }
  return undefined
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

export interface LicenseScanEntry {
  readonly name: string
  readonly directory: boolean
}

export interface LicenseScanIO {
  readonly readdir?: (dir: string) => Promise<LicenseScanEntry[]>
  readonly readFile?: (file: string) => Promise<string>
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([-._][\w.-]+)?$/i

interface FileVerdict extends IdentifiedLicense {
  readonly file: string
  readonly sha256: string
}

/** Detect the license of a project directory from its bytes. */
export async function detectLicense(
  dir: string,
  options: { maxHeaderFiles?: number; io?: LicenseScanIO } = {},
): Promise<LicenseFinding> {
  // Harvested content is untrusted: list only regular files and real
  // directories, and read only regular files (a symlinked LICENSE could point
  // anywhere on the machine).
  const readdirImpl =
    options.io?.readdir ??
    (async (target: string) =>
      (await readdir(target, { withFileTypes: true }))
        .filter((entry) => entry.isFile() || entry.isDirectory())
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() })))
  const readFileImpl =
    options.io?.readFile ??
    (async (file: string) => {
      const text = await readRegularFile(file)
      if (text === undefined) throw new Error(`not a regular file: ${file}`)
      return text
    })

  // 1. Every licence file in the root.
  const entries = await readdirImpl(dir).catch(() => [] as LicenseScanEntry[])
  const files: FileVerdict[] = []
  for (const entry of entries
    .filter((item) => !item.directory && LICENSE_FILE.test(item.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const text = await readFileImpl(path.join(dir, entry.name)).catch(() => undefined)
    if (text === undefined) continue
    const identified = identifyLicenseText(text) ?? {
      spdx: "unknown",
      family: "unknown" as const,
      verified: false,
      method: "resemblance" as const,
      note: "no recognisable licence text",
    }
    files.push({ ...identified, file: entry.name, sha256: sha256(text) })
  }

  // 2. SPDX headers: declarations by single files.
  const headers = await spdxHeaders(dir, options.maxHeaderFiles ?? 200, { readdirImpl, readFileImpl })

  if (files.length) return combine(files, headers)
  if (headers.length) {
    const ids = [...new Set(headers.flatMap((header) => spdxIds(header.spdx)))].sort(byText)
    const spdx = ids.join(" AND ")
    return {
      spdx,
      family: familyOf(spdx),
      source: "spdx-header",
      file: headers[0]!.file,
      sha256: sha256(headers[0]!.text),
      confidence: "medium",
      verified: false,
      note: `declared only by SPDX headers (${headers.length} file(s)); no licence text found`,
    }
  }

  // 3. Manifest fields: self-reported claims, never enough to depend on.
  const manifest = await manifestLicense(dir, readFileImpl)
  if (manifest)
    return {
      spdx: normalizeLicenseId(manifest.spdx),
      family: familyOf(manifest.spdx),
      source: "manifest",
      file: manifest.file,
      confidence: "medium",
      verified: false,
      note: "self-reported in a manifest; no license text found",
    }

  return {
    spdx: "unknown",
    family: "unknown",
    source: "manifest",
    confidence: "low",
    verified: false,
    note: "no license file, header or manifest field found",
  }
}

/** Combine licence files (and headers) into one finding, most restrictive first. */
function combine(files: readonly FileVerdict[], headers: readonly SpdxHeader[]): LicenseFinding {
  const worst = files.reduce((a, b) => (RANK[b.family] > RANK[a.family] ? b : a))
  const notes = files.filter((file) => file.note).map((file) => `${file.file}: ${file.note}`)
  const fileIds = new Set(files.flatMap((file) => spdxIds(file.spdx)))
  const extra = [...new Set(headers.flatMap((header) => spdxIds(header.spdx)))].filter((id) => !fileIds.has(id))
  if (extra.length) notes.push(`source files also declare SPDX headers: ${extra.join(", ")}`)
  const base = {
    source: "license-file" as const,
    file: files.length === 1 ? worst.file : files.map((file) => file.file).join(", "),
    sha256: worst.sha256,
    ...(notes.length ? { note: notes.join("; ") } : {}),
  }
  // One unrecognised licence file makes the whole project unknown.
  if (worst.spdx === "unknown")
    return { ...base, spdx: "unknown", family: "unknown", confidence: "low", verified: false }
  const restrictive = RANK[worst.family] >= RANK.unknown
  const spdx = [...new Set(restrictive ? [worst.spdx, ...extra] : [...fileIds, ...extra])].sort(byText).join(" AND ")
  const family = familyOf(spdx)
  return {
    ...base,
    spdx,
    family,
    confidence: files.every((file) => file.verified) ? "high" : "medium",
    // Verified only when every licence file was established from its text and
    // no header added an unrecognised id.
    verified: files.every((file) => file.verified) && extra.every((id) => id in FAMILIES),
  }
}

interface SpdxHeader {
  readonly spdx: string
  readonly file: string
  readonly text: string
}

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|cs|c|cc|cpp|h|hpp|swift|kt)$/i
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "vendor", "target"])

async function spdxHeaders(
  dir: string,
  maxFiles: number,
  io: {
    readdirImpl: (dir: string) => Promise<LicenseScanEntry[]>
    readFileImpl: (file: string) => Promise<string>
  },
): Promise<SpdxHeader[]> {
  const found: SpdxHeader[] = []
  let count = 0
  const walk = async (relative: string): Promise<void> => {
    const entries = await io.readdirImpl(path.join(dir, relative)).catch(() => [] as LicenseScanEntry[])
    for (const entry of entries) {
      if (count >= maxFiles) return
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.directory) await walk(child)
      else if (SOURCE_FILE.test(entry.name)) {
        count += 1
        const text = await io.readFileImpl(path.join(dir, child)).catch(() => undefined)
        const match = text ? /spdx-license-identifier:[ \t]*([^\n*]+)/i.exec(text.slice(0, 4_000)) : undefined
        // Keep the expression itself (ids, AND/OR/WITH, parentheses), not a trailing comment closer.
        const expression = match
          ? (/^[\w.+\-() ]+/.exec(match[1]!)?.[0] ?? "")
              .split(/\s+/)
              .filter((token) => /[A-Za-z0-9]/.test(token))
              .join(" ")
          : undefined
        if (text && expression) found.push({ spdx: expression, file: child, text })
      }
    }
  }
  await walk("")
  return found
}

type ReadImpl = (file: string) => Promise<string>

async function manifestLicense(dir: string, read: ReadImpl): Promise<{ spdx: string; file: string } | undefined> {
  const packageJson = await read(path.join(dir, "package.json")).catch(() => undefined)
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as { license?: unknown }
      const value = typeof pkg.license === "string" ? pkg.license : (pkg.license as { type?: string })?.type
      if (typeof value === "string" && value.trim()) return { spdx: value.trim(), file: "package.json" }
    } catch {}
  }
  for (const file of ["pyproject.toml", "Cargo.toml"]) {
    const text = await read(path.join(dir, file)).catch(() => undefined)
    const value = text ? tomlString(text, "license") : undefined
    if (value) return { spdx: value, file }
  }
  return undefined
}

/** The first `key = "value"` (or 'value') line of a TOML manifest, without a regex. */
function tomlString(text: string, key: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line.startsWith(key)) continue
    const rest = line.slice(key.length).trimStart()
    if (!rest.startsWith("=")) continue
    const value = rest.slice(1).trimStart()
    const quote = value[0]
    if (quote !== '"' && quote !== "'") continue
    const end = value.indexOf(quote, 1)
    if (end > 1) return value.slice(1, end)
  }
  return undefined
}

/** SPDX ids the bundled templates can verify (the default whitelist draws from these). */
export const TEMPLATE_IDS: readonly string[] = Object.keys(LICENSE_TEMPLATES)
