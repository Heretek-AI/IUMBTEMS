// Web reference pin: single MIT snapshot + transform-group registry
// (phase queereye-02, port of d66328c:runner/queereye/webref.py).
//
// - The pin target is shadcn-style prop-driven markup: variant/size props
//   over generic markup are the ideal spec pin [VERIFIED: dc656fd4], with
//   the cva variant/size matrix variant
//   default/outline/ghost/destructive/secondary/link x size
//   default/xs/sm/lg/icon [VERIFIED: c24a9c9c].
// - The snapshot is vendored content-addressed (sha256 + SPDX) and is NEVER
//   a live URL: a rot probe mutating any URL-shaped string must leave the
//   snapshot hash unchanged (snapshot immune by construction).
// - The transform-group registry mirrors the Style-Dictionary config model
//   (named groups of transforms: css-vars / scss / android-style), carrying
//   attribution instead of vendored upstream bytes beyond the clean-room
//   snapshot.
// - License gate: permissive-only depend/vendor (MIT/Apache-2.0/BSD-3-Clause/
//   ISC enforced); GPL/AGPL are clean-room-only (spec-rebuild, never bytes).
//
// Pure data + deterministic helpers: no file I/O, no network. The
// write/check tool wiring lives outside this module; `files` and `today`
// are accepted as arguments, as legacy did.

import { sha256 } from "../util/hash.ts"

/** Zero-width set `String.prototype.trim` misses (ZWSP/WJ/BOM family). */
const ZERO_WIDTH_CHARS = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u200e", "\u200f", "\u00ad"]

// d66328c:runner/queereye/webref.py (_strip_hardened)
/** Strip whitespace + zero-width chars (ZWSP/WJ/BOM family). */
export function stripHardened(value: unknown): unknown {
  if (typeof value !== "string") return value
  let cleaned = value
  for (const char of ZERO_WIDTH_CHARS) cleaned = cleaned.replaceAll(char, "")
  return cleaned.trim()
}

/** Hardened strip over strings; non-strings count as blank. */
const hardenedString = (value: unknown): string => {
  const stripped = stripHardened(value)
  return typeof stripped === "string" ? stripped : ""
}

/** Python-style `repr()` for a string in an error message. */
const repr = (value: string): string => `'${value}'`

/** Python-style `repr()` for an arbitrary value (None for null/undefined). */
const reprAny = (value: unknown): string => {
  if (typeof value === "string") return `'${value}'`
  if (value === null || value === undefined) return "None"
  return String(value)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// d66328c:runner/queereye/webref.py (_NOTE_ALLOWLIST)
/** Domain vocabulary for rebuild-proof notes (mirrors the tui allowlist). */
export const NOTE_ALLOWLIST: ReadonlySet<string> = new Set([
  "button",
  "dialog",
  "input",
  "form",
  "trigger",
  "overlay",
  "content",
  "title",
  "description",
  "close",
  "label",
  "field",
  "hint",
  "error",
  "icon",
  "spinner",
  "root",
  "portal",
  "empty",
  "loading",
  "disabled",
  "downgrade",
  "row",
  "applicable",
  "aria",
  "announcement",
  "focus",
  "keyboard",
  "event",
  "loop",
  "region",
  "border",
  "motion",
  "blur",
  "hover",
  "slot",
  "component",
  "spec",
  "state",
  "web",
  "tui",
  "rebuild",
  "rebuilt",
  "behavior",
  "behaviour",
  "clean",
  "room",
  "upstream",
  "bytes",
  "vendored",
  "snapshot",
  "hash",
  "spdx",
  "license",
  "mit",
  "gpl",
  "agpl",
  "vendor",
  "depend",
  "skip",
  "no",
  "not",
  "single",
  "explicit",
  "status",
  "text",
  "plain",
  "keybinding",
  "modal",
  "trap",
  "pointer",
  "screen",
  "reader",
  "reduced",
  "proof",
  "note",
  "spec-rebuild",
  "never",
])

// d66328c:runner/queereye/webref.py (_note_has_semantic_phrase)
/** True when a rebuild-proof note carries a semantic phrase. */
export function noteHasSemanticPhrase(note: unknown): boolean {
  if (typeof note !== "string") return false
  const stripped = hardenedString(note)
  if (stripped.length < 20) return false
  const words = stripped.match(/[A-Za-z]{2,}/g) ?? []
  if (words.length < 3) return false
  const distinct = new Set(words.map((word) => word.toLowerCase()))
  if (distinct.size < 3) return false
  const good = [...distinct].filter((word) => new Set(word).size >= 3 && word.length >= 3)
  if ([...distinct].filter((word) => NOTE_ALLOWLIST.has(word)).length >= 2 && good.length >= 2 && distinct.size >= 3)
    return true
  return distinct.size >= 4 && good.length >= 3
}

// d66328c:runner/queereye/webref.py (LICENSE_WHITELIST)
/** Permissive whitelist for depend/vendor (GPL/AGPL are clean-room-only and
 * rejected here as vendor inputs). */
export const LICENSE_WHITELIST: ReadonlySet<string> = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"])

/** Upper-cased view for case-insensitive SPDX matching (mit == MIT). */
const WHITELIST_UPPER: ReadonlySet<string> = new Set([...LICENSE_WHITELIST].map((id) => id.toUpperCase()))

// d66328c:runner/queereye/webref.py (COPYLEFT_IDS)
/** Copyleft ids that may only enter as clean-room behavior specs, never bytes. */
export const COPYLEFT_IDS: ReadonlySet<string> = new Set([
  "GPL-2.0-only",
  "GPL-3.0-only",
  "AGPL-3.0-only",
  "GPL",
  "AGPL",
])

/** Upper-cased copyleft view for case-insensitive matching. */
const COPYLEFT_UPPER: ReadonlySet<string> = new Set([...COPYLEFT_IDS].map((id) => id.toUpperCase()))

// d66328c:runner/queereye/webref.py (WEBREF_PINNED_ON)
/** Snapshot pin date (ISO). Freshness gate compares `today - pinned_on`. */
export const WEBREF_PINNED_ON = "2026-10-05"

// d66328c:runner/queereye/webref.py (WEBREF_MAX_AGE_DAYS)
/** Freshness budget in days (snapshot older than this fails `--strict`). */
export const WEBREF_MAX_AGE_DAYS = 180

// d66328c:runner/queereye/webref.py (WEBREF_NAME)
/** Snapshot display name (shadcn-style, prop-driven [VERIFIED: dc656fd4]). */
export const WEBREF_NAME = "queereye-webref-button"

// d66328c:runner/queereye/webref.py (_LIVE_URL_RE)
/** Live-URL pattern: the snapshot must never contain one (vendored bytes
 * only; upstream cited by name + SPDX, not by URL fetch). Case-insensitive
 * (HTTPS:// bypass refused) plus protocol-relative (//evil bypass refused);
 * the `//` alternative requires a non-space tail so `// comment` lines with
 * a space after `//` do not false-positive. */
export const LIVE_URL_RE = /(?:https?:\/\/|\/\/)[^\s"'<>]+/i

// d66328c:runner/queereye/webref.py (SNAPSHOT_FILES)
/** Clean-room snapshot files: a minimal prop-driven button (variant/size
 * props over generic markup [VERIFIED: dc656fd4]) rebuilt from the cva
 * matrix [VERIFIED: c24a9c9c]. Upstream behavior cited, bytes authored here. */
export const SNAPSHOT_FILES: Record<string, string> = {
  "button-variants.js":
    "// SPDX-License-Identifier: MIT\n" +
    "// Clean-room prop-driven variant map (cva matrix [VERIFIED: c24a9c9c]).\n" +
    "// Upstream behavior: shadcn-style buttonVariants [VERIFIED: dc656fd4].\n" +
    "export const buttonVariants = {\n" +
    '  variant: ["default","outline","ghost","destructive","secondary","link"],\n' +
    '  size: ["default","xs","sm","lg","icon"],\n' +
    '  defaultVariant: "default",\n' +
    '  defaultSize: "default",\n' +
    "};\n",
  "button.html":
    "<!-- SPDX-License-Identifier: MIT -->\n" +
    '<button class="btn" data-variant="default" data-size="default">Save</button>\n',
}

/** One transform group in the Style-Dictionary-shaped registry. */
export interface TransformGroup {
  readonly platform: string
  readonly transforms: readonly string[]
  readonly attribution: string
}

// d66328c:runner/queereye/webref.py (TRANSFORM_GROUPS)
/** Transform-group registry mirroring the Style-Dictionary config model:
 * named groups of ordered transforms with platform + attribution. No
 * upstream config bytes vendored; group names + transform lists rebuilt
 * clean-room from the documented model. */
export const TRANSFORM_GROUPS: Readonly<Record<string, TransformGroup>> = {
  "css-vars": {
    platform: "css",
    transforms: ["attribute/cti", "name/kebab", "color/css", "size/px"],
    attribution: "Style-Dictionary transform-group model (config-shape reference)",
  },
  scss: {
    platform: "scss",
    transforms: ["attribute/cti", "name/snake", "color/css", "size/px"],
    attribution: "Style-Dictionary transform-group model (config-shape reference)",
  },
  "android-style": {
    platform: "android",
    transforms: ["attribute/cti", "name/snake", "color/hex8", "size/dp"],
    attribution: "Style-Dictionary transform-group model (config-shape reference)",
  },
}

// d66328c:runner/queereye/webref.py (snapshot_bytes)
/** Deterministic snapshot bytes: sorted `name + \n + content` join. */
export function snapshotBytes(files: Record<string, unknown> | null = SNAPSHOT_FILES): Uint8Array {
  const source = files ?? SNAPSHOT_FILES
  if (!isRecord(source)) throw new TypeError("webref snapshot files must be an object (non-dict refused)")
  const chunks: string[] = []
  for (const name of Object.keys(source).sort()) {
    const content = source[name]
    if (typeof content !== "string")
      throw new TypeError(`webref ${reprAny(name)} snapshot content must be a string (non-string refused; type-guard)`)
    chunks.push(`=== ${name} ===\n`)
    chunks.push(content)
    if (!content.endsWith("\n")) chunks.push("\n")
  }
  return new TextEncoder().encode(chunks.join(""))
}

// d66328c:runner/queereye/webref.py (snapshot_hash)
/** SHA-256 hex of the canonical snapshot bytes (content address). */
export function snapshotHash(files: Record<string, unknown> | null = SNAPSHOT_FILES): string {
  return sha256(snapshotBytes(files))
}

// d66328c:runner/queereye/webref.py (spdx_block)
/** SPDX attribution block for the vendored snapshot (MIT). */
export function spdxBlock(): string {
  return (
    "SPDX-License-Identifier: MIT\n" +
    `Snapshot: ${WEBREF_NAME}\n` +
    `Content-SHA256: ${snapshotHash()}\n` +
    `Pinned-On: ${WEBREF_PINNED_ON}\n` +
    "Upstream-Behavior: shadcn-style prop-driven variants [VERIFIED: dc656fd4]\n" +
    "Distribution: copy-own snapshot (vendored bytes, never a live URL)\n"
  )
}

/** Machine manifest for the webref pin (hash + SPDX). */
export interface WebrefManifest {
  readonly name: string
  readonly license: string
  readonly spdx: string
  readonly snapshot_hash: string
  readonly pinned_on: string
  readonly max_age_days: number
  readonly files: string[]
  readonly transform_groups: string[]
  readonly distribution: string
  readonly evidence: { readonly shadcn_pin: string; readonly cva_matrix: string }
}

// d66328c:runner/queereye/webref.py (webref_manifest)
/** Machine manifest for `.queereye/webref.json` (hash + SPDX). */
export function webrefManifest(files: Record<string, unknown> | null = SNAPSHOT_FILES): WebrefManifest {
  const source = files ?? SNAPSHOT_FILES
  return {
    name: WEBREF_NAME,
    license: "MIT",
    spdx: "MIT",
    snapshot_hash: snapshotHash(source),
    pinned_on: WEBREF_PINNED_ON,
    max_age_days: WEBREF_MAX_AGE_DAYS,
    files: Object.keys(source).sort(),
    transform_groups: Object.keys(TRANSFORM_GROUPS).sort(),
    distribution: "copy-own snapshot (never a live URL)",
    evidence: { shadcn_pin: "dc656fd4", cva_matrix: "c24a9c9c" },
  }
}

// d66328c:runner/queereye/webref.py (license_gate)
/** License gate for one (license, action) pair. Returns error list.
 *
 * `vendor`/`depend` require the permissive whitelist (case-insensitive:
 * `mit` == `MIT`); GPL/AGPL are clean-room-only so `vendor`/`depend`/`skip`
 * refuse them; unknown SPDX ids (e.g. `EVIL`) are refused for ALL actions
 * including `clean-room`/`skip` (known SPDX required); `clean-room` passes
 * for known ids with a spec-rebuild note (when a `note` is supplied it must
 * carry a semantic phrase (>=20 chars + allowlist/distinct words; 'xxxx
 * xxxxx' gibberish refused). Empty and `PROPRIETARY` as `clean-room`/`skip`
 * is refused (rebuild proof required, never silent).
 */
export function licenseGate(licenseId: unknown, action: unknown, note?: unknown): string[] {
  const lic = hardenedString(licenseId === undefined || licenseId === null ? "" : String(licenseId))
  const act = hardenedString(action === undefined || action === null ? "" : String(action)).toLowerCase()
  if (!lic) return [`license gate: empty license refused for ${reprAny(act || action)}`]
  if (lic.toUpperCase() === "PROPRIETARY" && (act === "clean-room" || act === "skip"))
    return [`license gate: ${repr(lic)} is never clean-room/skip (proprietary bytes require rebuild proof; refused)`]
  const licUpper = lic.toUpperCase()
  const isAllowlisted = WHITELIST_UPPER.has(licUpper)
  const isCopyleft = COPYLEFT_UPPER.has(licUpper) || licUpper.startsWith("GPL") || licUpper.startsWith("AGPL")
  const isKnown = isAllowlisted || isCopyleft
  if (act === "clean-room") {
    if (!isKnown)
      return [
        `license gate: unknown license ${repr(lic)} refused for clean-room (known SPDX required; rebuild proof refused)`,
      ]
    if (note !== undefined && note !== null) {
      if (typeof note !== "string" || !hardenedString(note))
        return [
          `license gate: clean-room ${repr(lic)} requires rebuild proof note (blank/zero-width refused; waivers carry conditions)`,
        ]
      if (!noteHasSemanticPhrase(note))
        return [
          `license gate: clean-room ${repr(lic)} requires rebuild proof note (>=20 chars + semantic phrase; 'xxxx xxxxx' gibberish refused; waivers carry conditions)`,
        ]
    }
    return []
  }
  if (act === "vendor" || act === "depend") {
    if (isAllowlisted) return []
    if (isCopyleft)
      return [
        `license gate: ${repr(lic)} is clean-room-only; ${act} refused (permissive-only: [${[...LICENSE_WHITELIST].sort().map(repr).join(", ")}])`,
      ]
    return [`license gate: unknown license ${repr(lic)} refused for ${act}`]
  }
  if (act === "skip") {
    if (isAllowlisted) return []
    if (isCopyleft)
      return [`license gate: ${repr(lic)} is clean-room-only; skip refused (use clean-room with rebuild proof)`]
    return [`license gate: unknown license ${repr(lic)} refused for skip`]
  }
  return [`license gate: unknown action ${reprAny(action)}`]
}

/** True when two string arrays match once both are sorted. */
const sameStrings = (left: readonly unknown[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].map(String).sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

// d66328c:runner/queereye/webref.py (verify_snapshot)
/** Verify a webref manifest against local bytes. Returns error list.
 *
 * Checks: snapshot files object with string contents (type-guard:
 * non-string values are structured errors, never a crash), hash matches
 * recomputed snapshot, SPDX MIT, file list matches, no live URL inside
 * snapshot bytes (rot-immune by construction).
 */
export function verifySnapshot(manifest: unknown, files?: Record<string, unknown> | null): string[] {
  const errors: string[] = []
  if (!isRecord(manifest)) return ["webref manifest must be an object"]
  const snapshotFiles: Record<string, unknown> = files ?? SNAPSHOT_FILES
  if (!isRecord(snapshotFiles)) return ["webref snapshot files must be an object (non-dict refused)"]
  // Type-guard snapshot values before hashing (non-string -> structured
  // error, never a crash from .endsWith/.search).
  const typedFiles: Record<string, string> = {}
  let hasNonString = false
  for (const [name, content] of Object.entries(snapshotFiles)) {
    if (!name.trim() || !hardenedString(name))
      errors.push(`webref snapshot file name ${reprAny(name)} must be a stripped non-empty string`)
    if (typeof content !== "string") {
      hasNonString = true
      errors.push(`webref ${reprAny(name)} snapshot content must be a string (non-string refused; type-guard)`)
    } else typedFiles[name] = content
  }
  if (hasNonString) {
    // Still surface SPDX/file-list gates alongside the type error, but skip
    // hash/live-URL compares that would crash on non-strings.
    if (manifest.spdx !== "MIT" || manifest.license !== "MIT")
      errors.push("webref must carry SPDX MIT (spdx + license fields)")
    const manifestFiles = Array.isArray(manifest.files) ? manifest.files : null
    if (manifestFiles === null || !sameStrings(manifestFiles, Object.keys(snapshotFiles)))
      errors.push("webref file list differs from vendored snapshot")
    return errors
  }
  const expected = snapshotHash(typedFiles)
  if (manifest.snapshot_hash !== expected)
    errors.push(
      `webref snapshot_hash mismatch: manifest ${reprAny(manifest.snapshot_hash)} != recomputed ${repr(expected)}`,
    )
  if (manifest.spdx !== "MIT" || manifest.license !== "MIT")
    errors.push("webref must carry SPDX MIT (spdx + license fields)")
  if (!sameStrings(Array.isArray(manifest.files) ? manifest.files : [], Object.keys(typedFiles)))
    errors.push("webref file list differs from vendored snapshot")
  for (const [name, content] of Object.entries(typedFiles))
    if (LIVE_URL_RE.test(content)) errors.push(`webref ${name} contains a live URL (snapshot must be bytes-only)`)
  return errors
}

/** Calendar date-only parsing (`YYYY-MM-DD`), as Python date.fromisoformat. */
const parseDateOnly = (value: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) throw new RangeError(`invalid ISO date: ${JSON.stringify(value)}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const time = Date.UTC(year, month - 1, day)
  const check = new Date(time)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
    throw new RangeError(`invalid calendar date: ${JSON.stringify(value)}`)
  return time
}

/** Epoch-day number of a date-only value; Date instances read local parts
 * (Python `date.today()` semantics). */
const epochDay = (value: string | Date): number => {
  if (value instanceof Date)
    return Math.floor(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000)
  return parseDateOnly(value) / 86_400_000
}

// d66328c:runner/queereye/webref.py (snapshot_age_days)
/** Age of the pin in days (`today` ISO or Date; default today). */
export function snapshotAgeDays(today?: string | Date | null, pinnedOn?: string | null): number {
  const pinned = pinnedOn === undefined || pinnedOn === null ? WEBREF_PINNED_ON : String(pinnedOn)
  const todayValue = today === undefined || today === null ? new Date() : today
  return epochDay(todayValue) - epochDay(pinned)
}

// d66328c:runner/queereye/webref.py (is_fresh)
/** True when the pin age is within budget (freshness gate).
 *
 * The budget is capped to `WEBREF_MAX_AGE_DAYS`: a forged
 * `maxAgeDays=99999` is capped to the pin (stale stays stale).
 */
export function isWebrefFresh(today?: string | Date | null, maxAgeDays?: number | string | null): boolean {
  let limit = WEBREF_MAX_AGE_DAYS
  if (maxAgeDays !== undefined && maxAgeDays !== null) {
    const numeric = typeof maxAgeDays === "number" ? maxAgeDays : Number(maxAgeDays)
    if (Number.isFinite(numeric)) limit = Math.min(Math.trunc(numeric), WEBREF_MAX_AGE_DAYS)
  }
  const age = snapshotAgeDays(today)
  return age >= 0 && age <= limit
}
