// Queereye phase-03 skill-harvest ledger (port of d66328c:runner/queereye/harvest.py).
//
// Ledger-as-code: permissive-only harvest rows with pinned LICENSE bytes and
// SPDX blocks, the shadcn transitive-closure scan, and the deterministic
// skill-bundle renderers. GPL/AGPL and MPL-2.0 stay clean-room behavior-only;
// BSD/ISC claims need their own LICENSE bytes (no bytes, no claim). Pure data
// and functions: no network, no randomness, no file I/O.
import { createHash } from "node:crypto"
import { WCAG_AA_LARGE, WCAG_AA_NORMAL, WCAG_AAA_ENHANCED } from "./contrast.ts"
import { DTCG_SNAPSHOT } from "./tokens.ts"

// -- hardened strings --------------------------------------------------------

/** Zero-width set Python strip() misses (ZWSP/WJ/BOM family). */
const ZERO_WIDTH_CHARS = "\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u00ad"

/** Python ``str(value or "")``: falsy values collapse to "", everything else stringifies. */
const strOr = (value: unknown): string => (value ? String(value) : "")

/** Strip whitespace + zero-width chars (ZWSP/WJ/BOM family). */
const stripHardened = (value: string): string => {
  let cleaned = value
  for (const char of ZERO_WIDTH_CHARS) if (cleaned.includes(char)) cleaned = cleaned.replaceAll(char, "")
  return cleaned.trim()
}

/** Python ``_is_blank``: true unless the value is a stripped non-empty string. */
const isBlank = (value: unknown): boolean => typeof value !== "string" || stripHardened(value) === ""

/** Python-ish repr for error text (strings quoted, null/undefined as None). */
const pyRepr = (value: unknown): string => {
  if (typeof value === "string") return `'${value}'`
  if (value === null || value === undefined) return "None"
  return String(value)
}

/** Python ``sorted(...)`` list repr for error text. */
const pyList = (values: readonly string[]): string => `[${values.map((value) => `'${value}'`).join(", ")}]`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// -- the vendored MIT license bytes ------------------------------------------

/**
 * Canonical MIT license text vendored as the LICENSE bytes for every MIT row.
 * Upstream per-file copyright lines are NOT fetched (no network ingest); that
 * attribution gap is recorded as NEGATIVE_KNOWLEDGE on each row, never
 * papered over. The text is byte-identical for all MIT upstreams modulo the
 * copyright line, so one hash covers the license identity of every MIT row.
 */
export const MIT_LICENSE_TEXT = `MIT License

Copyright (c) <upstream project> (copyright lines live upstream; not fetched)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

/** SHA-256 hex of the vendored MIT license bytes (license identity). */
export const mitLicenseBytesSha256 = (): string => createHash("sha256").update(MIT_LICENSE_TEXT, "utf8").digest("hex")

// -- vocabularies and pins ---------------------------------------------------

/** Permissive whitelist for depend/vendor (GPL/AGPL are clean-room-only). */
export const LICENSE_WHITELIST: ReadonlySet<string> = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"])

const WHITELIST_UPPER: ReadonlySet<string> = new Set([...LICENSE_WHITELIST].map((id) => id.toUpperCase()))

const SORTED_LICENSE_WHITELIST = [...LICENSE_WHITELIST].sort()

/** Copyleft ids that may only enter as clean-room behavior specs, never bytes. */
const COPYLEFT_IDS: ReadonlySet<string> = new Set(["GPL-2.0-only", "GPL-3.0-only", "AGPL-3.0-only", "GPL", "AGPL"])

const COPYLEFT_UPPER: ReadonlySet<string> = new Set([...COPYLEFT_IDS].map((id) => id.toUpperCase()))

/** Machine row keys for the harvest ledger. */
export const LEDGER_REQUIRED_KEYS: readonly string[] = [
  "skill",
  "verdict",
  "license",
  "upstream",
  "upstream_license",
  "files",
  "evidence_hash",
  "evidence_kind",
  "license_bytes_sha256",
  "spdx",
  "note",
]

/** Allowed cell values. */
export const LEDGER_VERDICTS: ReadonlySet<string> = new Set(["depend", "vendor", "clean-room", "skip"])
export const LEDGER_EVIDENCE_KINDS: ReadonlySet<string> = new Set(["dossier", "license-bytes", "negative"])

/** Dossier evidence hashes this phase MUST cite (full quotes in dossier.json). */
export const DOSSIER_HASHES: readonly string[] = [
  "dbe9cbb4", // Open Props MIT custom-property tokens
  "890dc55a", // shadcn/ui MIT component-pattern catalog
  "74144f6a", // Radix Primitives MIT dialog/focus/keyboard behaviors
  "d0679fbc", // axe-core MPL-2.0 excluded harvest
  "84f80b6c", // skill frontmatter contract + validator
  "aab8ead6", // OpenCode V2 agent profile shape
  "ca41333c", // Claude commands==skills merged shape
]

/** Closed platforms: clean-room-from-docs only, no repo to scan. */
export const CLOSED_PLATFORMS: readonly string[] = ["knapsack", "supernova", "zeroheight", "backlight"]

/** Mandated shadcn sub-deps the closure scan must price (deletable closure refused). */
export const MANDATED_CLOSURE_DEPS: ReadonlySet<string> = new Set([
  "@radix-ui/react-dialog",
  "tailwindcss",
  "class-variance-authority",
  "clsx",
  "tailwind-merge",
  "lucide-react",
])

/**
 * Documented clean-room exceptions for whitelist-incompatible behavior-only
 * rebuilds: MPL-2.0 (axe-checks) + W3C-Document (aria-contracts). Every other
 * unknown SPDX id (e.g. EVIL-MADE-UP) is refused via the license gate.
 */
export const DOCUMENTED_CLEANROOM_UPSTREAMS: ReadonlySet<string> = new Set(["MPL-2.0", "W3C-DOCUMENT"])

/** 64-hex SHA-256 shape for LICENSE-byte pins (fake BSD bytes refused). */
const HEX64_RE = /^[0-9a-fA-F]{64}$/

// -- rows --------------------------------------------------------------------

export type LedgerVerdict = "depend" | "vendor" | "clean-room" | "skip"
export type LedgerEvidenceKind = "dossier" | "license-bytes" | "negative"

export interface LedgerRow {
  readonly skill: string
  readonly verdict: LedgerVerdict
  readonly license: string
  readonly upstream: string
  readonly upstream_license: string
  readonly files: readonly string[]
  readonly evidence_hash: string
  readonly evidence_kind: LedgerEvidenceKind
  readonly license_bytes_sha256: string
  readonly spdx: string
  readonly note: string
}

/**
 * SPDX attribution block for one ledger row (license + upstream + files).
 *
 * No live URLs: the upstream is cited by name + SPDX + content hash, never by
 * URL fetch (mirrors the webref never-live-URL rule). The SPDX identifier and
 * bytes hash are the ROW's license (BSD/SPDX correct), never a hardcoded MIT.
 */
export function spdxBlockFor(
  skill: string,
  upstream: string,
  upstreamLicense: string,
  files: readonly string[],
  evidenceHash: string,
  license = "MIT",
  licenseBytesSha256?: string,
): string {
  const rowLicense = stripHardened(strOr(license)) || "MIT"
  let rowBytes = licenseBytesSha256 ? stripHardened(strOr(licenseBytesSha256)) : mitLicenseBytesSha256()
  if (!rowBytes) rowBytes = mitLicenseBytesSha256()
  const fileList = files.length ? [...files].sort().join(",") : "(no vendored files)"
  return (
    `SPDX-License-Identifier: ${rowLicense}\n` +
    `Skill: ${skill}\n` +
    `Upstream: ${upstream} (claimed ${upstreamLicense})\n` +
    `Files: ${fileList}\n` +
    `License-Bytes-SHA256: ${rowBytes}\n` +
    `Evidence: ${evidenceHash}\n`
  )
}

/**
 * Build one harvest ledger row. ``license`` is the row's own vendored-bytes
 * license (MIT by default); ``upstreamLicense`` is the upstream's claimed id
 * and may be non-whitelisted for clean-room rows (MPL-2.0, W3C-Document).
 */
export function ledgerRow(
  skill: string,
  verdict: LedgerVerdict,
  upstream: string,
  upstreamLicense: string,
  files: readonly string[],
  evidenceHash: string,
  evidenceKind: LedgerEvidenceKind,
  note: string,
  license = "MIT",
): LedgerRow {
  const rowLicense = stripHardened(strOr(license)) || "MIT"
  const rowBytes = mitLicenseBytesSha256()
  return {
    skill,
    verdict,
    license: rowLicense,
    upstream,
    upstream_license: upstreamLicense,
    files: [...files],
    evidence_hash: evidenceHash,
    evidence_kind: evidenceKind,
    license_bytes_sha256: rowBytes,
    spdx: spdxBlockFor(skill, upstream, upstreamLicense, files, evidenceHash, rowLicense, rowBytes),
    note,
  }
}

/**
 * The harvest ledger: 5 MIT rows (Open Props, shadcn, Radix, 2x Tailwind) +
 * axe-core (MPL-2.0, clean-room) + WAI-ARIA (behavior-only clean-room).
 * No BSD/ISC row is claimed: without file-level LICENSE bytes those stay
 * NEGATIVE_KNOWLEDGE (see :data:`NEGATIVE_KNOWLEDGE_NOTES`).
 */
export const HARVEST_ROWS: readonly LedgerRow[] = [
  ledgerRow(
    "open-props-theming",
    "depend",
    "open-props",
    "MIT",
    ["tokens.css"],
    "dbe9cbb4",
    "dossier",
    "Theming substrate (depend): framework-agnostic custom-property tokens [VERIFIED: dbe9cbb4]; tokens.css compiled vars mirror the custom-property model. NEGATIVE_KNOWLEDGE: upstream per-file copyright lines not fetched (no network ingest).",
  ),
  ledgerRow(
    "shadcn-patterns",
    "clean-room",
    "shadcn/ui",
    "MIT",
    ["components/button.md", "components/dialog.md", "components/form-input.md", "webref.json"],
    "890dc55a",
    "dossier",
    "Component-pattern catalog as clean-room spec source [VERIFIED: 890dc55a]: patterns rebuilt as behavior specs; zero upstream bytes vendored.",
  ),
  ledgerRow(
    "radix-behaviors",
    "clean-room",
    "radix-primitives",
    "MIT",
    ["components/dialog.md", "tui-notes.md"],
    "74144f6a",
    "dossier",
    "Dialog, focus-management, and keyboard-interaction behaviors re-specified per target [VERIFIED: 74144f6a]; no upstream bytes vendored.",
  ),
  ledgerRow(
    "tailwind-naming",
    "clean-room",
    "tailwindcss",
    "MIT",
    ["tokens.css"],
    mitLicenseBytesSha256(),
    "license-bytes",
    "Token-naming conventions rebuilt clean-room as a spec source. HYPOTHESIS (registry claim, never VERIFIED): upstream tailwindcss ships MIT; no upstream LICENSE bytes fetched (no network), so the association is not cited as dossier evidence.",
  ),
  ledgerRow(
    "tailwind-theme",
    "depend",
    "tailwindcss",
    "MIT",
    ["tokens.css"],
    mitLicenseBytesSha256(),
    "license-bytes",
    "Tailwind @theme compiler as depend for token-to-utility codegen. HYPOTHESIS (registry claim): upstream MIT. NEGATIVE_KNOWLEDGE: compiler version pin not ingested (no lockfile scan); codegen contract is the tokens.css shape, not a pinned binary.",
  ),
  ledgerRow(
    "axe-checks",
    "clean-room",
    "axe-core",
    "MPL-2.0",
    ["probes.json"],
    "d0679fbc",
    "dossier",
    "Canonical EXCLUDED harvest [VERIFIED: d0679fbc]: MPL-2.0 is whitelist-incompatible, so axe-core is behavior-only -- contrast checks rebuilt in probes.json, never depend/vendor.",
  ),
  ledgerRow(
    "aria-contracts",
    "clean-room",
    "wai-aria-1.2",
    "W3C-Document",
    ["components/button.md", "components/dialog.md"],
    mitLicenseBytesSha256(),
    "license-bytes",
    "WAI-ARIA 1.2 role/state/keyboard contracts rebuilt behavior-only (our rebuild bytes are MIT); zero upstream bytes vendored. NEGATIVE_KNOWLEDGE: upstream W3C document bytes not fetched; upstream W3C document license never enters the whitelist path.",
  ),
]

/** Standing NEGATIVE_KNOWLEDGE: BSD/ISC coverage is NOT claimed. */
export const NEGATIVE_KNOWLEDGE_NOTES: readonly string[] = [
  "NEGATIVE_KNOWLEDGE: no BSD-3-Clause harvest claimed -- no candidate with file-level LICENSE bytes cached; full-whitelist coverage is not asserted.",
  "NEGATIVE_KNOWLEDGE: no ISC harvest claimed -- lucide-react (ISC, registry claim) via shadcn is HYPOTHESIS without LICENSE bytes and is excluded from the depend surface (icon slots use text glyphs).",
]

// -- transitive closure ------------------------------------------------------

export interface TransitiveDep {
  readonly dep: string
  readonly via: string
  readonly license_claim: string
  readonly status: "priced" | "negative"
  readonly risk: string
}

/**
 * Transitive closure for shadcn sub-deps (Gate 0 unpriced risk closed here):
 * every sub-dep is priced (risk: none, no bytes vendored) or explicitly
 * negative (no bytes, excluded). No GPL/AGPL anywhere in the closure.
 */
export const TRANSITIVE_DEPS: readonly TransitiveDep[] = [
  {
    dep: "@radix-ui/react-dialog",
    via: "shadcn/ui",
    license_claim: "MIT",
    status: "priced",
    risk: "none: covered by the radix-behaviors clean-room row; no bytes vendored.",
  },
  {
    dep: "tailwindcss",
    via: "shadcn/ui",
    license_claim: "MIT",
    status: "priced",
    risk: "none: compiler depend only (tailwind-theme row); no bytes vendored.",
  },
  {
    dep: "class-variance-authority",
    via: "shadcn/ui",
    license_claim: "Apache-2.0",
    status: "priced",
    risk: "none: cva matrix rebuilt clean-room in specs.py; no bytes vendored.",
  },
  {
    dep: "clsx",
    via: "shadcn/ui",
    license_claim: "MIT",
    status: "priced",
    risk: "none: not vendored; class-join trivially rebuilt.",
  },
  {
    dep: "tailwind-merge",
    via: "shadcn/ui",
    license_claim: "MIT",
    status: "priced",
    risk: "none: not vendored; no class-string merging shipped.",
  },
  {
    dep: "lucide-react",
    via: "shadcn/ui",
    license_claim: "ISC (registry claim, HYPOTHESIS)",
    status: "negative",
    risk: "NEGATIVE_KNOWLEDGE: no LICENSE bytes cached; excluded from the depend surface; icon slots use text glyphs.",
  },
  {
    dep: "BSD-family (no candidate)",
    via: "transitive scan",
    license_claim: "BSD-* (none claimed)",
    status: "negative",
    risk: "NEGATIVE_KNOWLEDGE: no BSD-licensed dep claimed without file-level LICENSE bytes (Gate 0 gap stays open, never faked).",
  },
]

// -- license gate (port of d66328c:runner/queereye/webref.py license_gate) ----

/** Domain vocabulary for rebuild-proof notes (mirrors the tui allowlist). */
const NOTE_ALLOWLIST: ReadonlySet<string> = new Set([
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

/** True when a rebuild-proof note carries a semantic phrase. */
function noteHasSemanticPhrase(note: string): boolean {
  const stripped = stripHardened(note)
  if (stripped.length < 20) return false
  const words = stripped.match(/[A-Za-z]{2,}/g) ?? []
  if (words.length < 3) return false
  const distinct = new Set(words.map((word) => word.toLowerCase()))
  if (distinct.size < 3) return false
  const allowHits = [...distinct].filter((word) => NOTE_ALLOWLIST.has(word)).length
  if (allowHits >= 2) {
    const good = [...distinct].filter((word) => new Set(word).size >= 3 && word.length >= 3)
    if (good.length >= 2 && distinct.size >= 3) return true
  }
  const good = [...distinct].filter((word) => new Set(word).size >= 3 && word.length >= 3)
  if (distinct.size >= 4 && good.length >= 3) return true
  return false
}

/**
 * License gate for one (license, action) pair. Returns error list.
 *
 * ``vendor``/``depend`` require the permissive whitelist (case-insensitive:
 * ``mit`` == ``MIT``); GPL/AGPL are clean-room-only so ``vendor``/``depend``
 * /``skip`` refuse them; unknown SPDX ids (e.g. ``EVIL``) are refused for ALL
 * actions including ``clean-room``/``skip`` (known SPDX required);
 * ``clean-room`` passes for known ids with a spec-rebuild note (when a
 * ``note`` is supplied it must carry a semantic phrase). Empty and
 * ``PROPRIETARY`` as ``clean-room``/``skip`` is refused (rebuild proof
 * required, never silent).
 */
function licenseGate(licenseId: unknown, action: string, note?: string): string[] {
  const license = stripHardened(strOr(licenseId))
  const act = stripHardened(strOr(action)).toLowerCase()
  if (!license) return [`license gate: empty license refused for ${act ? `'${act}'` : pyRepr(action)}`]
  if (license.toUpperCase() === "PROPRIETARY" && (act === "clean-room" || act === "skip"))
    return [`license gate: '${license}' is never clean-room/skip (proprietary bytes require rebuild proof; refused)`]
  const licenseUpper = license.toUpperCase()
  const isAllowlisted = WHITELIST_UPPER.has(licenseUpper)
  const isCopyleft =
    COPYLEFT_UPPER.has(licenseUpper) || licenseUpper.startsWith("GPL") || licenseUpper.startsWith("AGPL")
  const isKnown = isAllowlisted || isCopyleft
  if (act === "clean-room") {
    if (!isKnown)
      return [
        `license gate: unknown license '${license}' refused for clean-room (known SPDX required; rebuild proof refused)`,
      ]
    if (note !== undefined) {
      if (typeof note !== "string" || !stripHardened(note))
        return [
          `license gate: clean-room '${license}' requires rebuild proof note (blank/zero-width refused; waivers carry conditions)`,
        ]
      if (!noteHasSemanticPhrase(note))
        return [
          `license gate: clean-room '${license}' requires rebuild proof note (>=20 chars + semantic phrase; 'xxxx xxxxx' gibberish refused; waivers carry conditions)`,
        ]
    }
    return []
  }
  if (act === "vendor" || act === "depend") {
    if (isAllowlisted) return []
    if (isCopyleft)
      return [
        `license gate: '${license}' is clean-room-only; ${act} refused (permissive-only: ${pyList(SORTED_LICENSE_WHITELIST)})`,
      ]
    return [`license gate: unknown license '${license}' refused for ${act}`]
  }
  if (act === "skip") {
    if (isAllowlisted) return []
    if (isCopyleft)
      return [`license gate: '${license}' is clean-room-only; skip refused (use clean-room with rebuild proof)`]
    return [`license gate: unknown license '${license}' refused for skip`]
  }
  return [`license gate: unknown action ${pyRepr(action)}`]
}

// -- file-list traversal probe (lexical port of d66328c:runner/queereye/fs.py resolve_inside) --

class LedgerPathError extends Error {}

/** Lexically normalise an absolute POSIX path (no filesystem access). */
function normaliseAbsolute(value: string): string {
  const segments: string[] = []
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length) segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join("/")}`
}

/**
 * Resolve ``rel`` inside ``<root>/.factory/design/`` or throw (pure lexical check:
 * no symlink resolution, no I/O). Absolute paths must already live inside the
 * directory; ``..`` escapes are hard errors.
 */
function resolveInsideQueereye(root: string, rel: string): string {
  const dir = normaliseAbsolute(`${root}/.factory/design`)
  const candidate = normaliseAbsolute(rel.startsWith("/") ? rel : `${dir}/${rel}`)
  if (candidate !== dir && !candidate.startsWith(`${dir}/`))
    throw new LedgerPathError(`refusing write outside .factory/design/: ${pyRepr(rel)}`)
  if (candidate === dir) throw new LedgerPathError(`refusing write to .factory/design/ itself: ${pyRepr(rel)}`)
  return candidate
}

/** Mutation-probe root used by the legacy validator for the files[] scan. */
const LEDGER_PROBE_ROOT = "/tmp/queereye-ledger-probe"

// -- validators --------------------------------------------------------------

/**
 * Validate the harvest ledger. Returns error list (empty = valid).
 *
 * - Every row carries all machine keys; verdict/license/evidence_kind are
 *   closed vocabularies; ``license`` is whitelist-enforced (rejects other
 *   ids, case-insensitive); files is a non-empty list of stripped paths.
 * - ``depend``/``vendor``/``clean-room``/``skip`` upstream ids are ALL routed
 *   through the license gate: GPL skip refused without rebuild proof, unknown
 *   SPDX (EVIL-MADE-UP) refused for every verdict. Documented exceptions:
 *   MPL-2.0 (axe-checks) + W3C-Document (aria-contracts) behavior-only
 *   rebuilds with VERIFIED/NEGATIVE_KNOWLEDGE notes.
 * - Badge-launder: ``dossier`` evidence_hash must be a member of the phase
 *   dossier hashes (else fail, even with a marker); dossier rows must cite
 *   ``[VERIFIED: <hash>]`` in the note.
 * - Bytes: ``license_bytes_sha256`` must be 64-hex shape (faked BSD refused),
 *   never ``0*64``; MIT rows must pin the vendored MIT bytes; BSD/ISC rows
 *   must pin their own bytes (never MIT bytes). SPDX blocks must emit the
 *   ROW's license + bytes hash (never hardcoded MIT).
 * - Closed platforms (knapsack/supernova/zeroheight/backlight) refused.
 * - Files traversal (``../../etc/passwd``) refused (must stay inside
 *   ``.factory/design/``).
 * - Every ``vendor`` row emits an SPDX block (license + upstream + files).
 * - No GPL/AGPL bytes vendored: no row vendors upstream bytes under a
 *   copyleft id.
 * - Badge-only rows (``evidence_kind != dossier``) must say HYPOTHESIS or
 *   NEGATIVE_KNOWLEDGE in the note (registry claims never VERIFIED).
 * - No BSD/ISC ``license`` claim without LICENSE bytes: any row claiming a
 *   BSD/ISC ``license`` must pin ``license_bytes_sha256`` to real shipped
 *   bytes (this ledger claims none; the check still guards edits).
 */
export function validateLedger(rows: readonly unknown[] = HARVEST_ROWS): string[] {
  const errors: string[] = []
  if (!Array.isArray(rows) || rows.length === 0) return ["harvest ledger must be a non-empty list of rows"]
  const seenSkills = new Set<unknown>()
  for (const [index, raw] of rows.entries()) {
    const tag = isRecord(raw) && "skill" in raw ? String(raw.skill) : `<row ${index}>`
    if (!isRecord(raw)) {
      errors.push(`harvest ${tag}: row must be an object`)
      continue
    }
    for (const key of LEDGER_REQUIRED_KEYS)
      if (!(key in raw)) errors.push(`harvest ${tag}: missing required key '${key}'`)
    if (LEDGER_REQUIRED_KEYS.some((key) => !(key in raw))) continue
    if (isBlank(raw.skill)) errors.push(`harvest ${tag}: skill must be a stripped non-empty string`)
    if (seenSkills.has(raw.skill)) errors.push(`harvest ${tag}: duplicate skill id`)
    seenSkills.add(raw.skill)
    const verdict = stripHardened(strOr(raw.verdict))
    if (!LEDGER_VERDICTS.has(verdict))
      errors.push(
        `harvest ${tag}: verdict ${pyRepr(raw.verdict)} must be one of ${pyList([...LEDGER_VERDICTS].sort())}`,
      )
    const license = stripHardened(strOr(raw.license))
    if (!WHITELIST_UPPER.has(license.toUpperCase()))
      errors.push(
        `harvest ${tag}: license ${pyRepr(raw.license)} rejected (whitelist: ${pyList(SORTED_LICENSE_WHITELIST)})`,
      )
    const upstreamLicense = stripHardened(strOr(raw.upstream_license))
    const upstreamUpper = stripHardened(strOr(upstreamLicense)).toUpperCase()
    // F4/F5: route every verdict through the license gate (skip/clean-room too).
    if (verdict === "depend" || verdict === "vendor") {
      for (const error of licenseGate(upstreamLicense, verdict)) errors.push(`harvest ${tag}: ${error}`)
    } else if (verdict === "clean-room" || verdict === "skip") {
      if (verdict === "clean-room" && DOCUMENTED_CLEANROOM_UPSTREAMS.has(upstreamUpper)) {
        const noteText = strOr(raw.note)
        if (upstreamUpper === "MPL-2.0") {
          if (raw.skill !== "axe-checks")
            errors.push(`harvest ${tag}: MPL-2.0 clean-room exception only for axe-checks (got ${pyRepr(raw.skill)})`)
          else if (!noteText.includes("VERIFIED") && !noteText.includes("NEGATIVE_KNOWLEDGE"))
            errors.push(`harvest ${tag}: MPL-2.0 exception requires VERIFIED/NEGATIVE_KNOWLEDGE rebuild note`)
        } else if (upstreamUpper === "W3C-DOCUMENT") {
          if (raw.skill !== "aria-contracts")
            errors.push(
              `harvest ${tag}: W3C-Document clean-room exception only for aria-contracts (got ${pyRepr(raw.skill)})`,
            )
          else if (!noteText.includes("NEGATIVE_KNOWLEDGE"))
            errors.push(
              `harvest ${tag}: W3C-Document exception requires NEGATIVE_KNOWLEDGE in note (upstream bytes never fetched)`,
            )
        }
      } else {
        const gate =
          verdict === "clean-room"
            ? licenseGate(upstreamLicense, verdict, strOr(raw.note))
            : licenseGate(upstreamLicense, verdict)
        for (const error of gate) errors.push(`harvest ${tag}: ${error}`)
      }
    }
    if (verdict === "clean-room" && isBlank(raw.note))
      errors.push(`harvest ${tag}: clean-room requires a rebuild-proof note (blank refused; waivers carry conditions)`)
    // SPDX: every row's block must emit the ROW's license + bytes hash (never
    // hardcoded MIT); vendor additionally requires upstream naming.
    const spdx = strOr(raw.spdx)
    if (verdict === "vendor") {
      if (isBlank(spdx) || !String(spdx).includes("SPDX-License-Identifier"))
        errors.push(`harvest ${tag}: vendor must emit an SPDX block (license + upstream + files)`)
      else if (!String(spdx).includes(String(raw.upstream)))
        errors.push(`harvest ${tag}: vendor SPDX block must name the upstream`)
    }
    if (!isBlank(spdx)) {
      const spdxText = String(spdx)
      const expectedId = `SPDX-License-Identifier: ${license}`
      // Case-insensitive SPDX match (mit == MIT); a hardcoded wrong id still
      // fails (BSD row with MIT block refused even case-insensitively).
      if (!spdxText.toLowerCase().includes(expectedId.toLowerCase()))
        errors.push(
          `harvest ${tag}: SPDX block must emit the row license ${pyRepr(license)} (${pyRepr(expectedId)} missing; hardcoded MIT refused)`,
        )
      const bytesForSpdx = stripHardened(strOr(raw.license_bytes_sha256))
      if (bytesForSpdx && !spdxText.includes(bytesForSpdx))
        errors.push(
          `harvest ${tag}: SPDX block License-Bytes-SHA256 must match the row license_bytes_sha256 (hardcoded hash refused)`,
        )
    }
    if (!Array.isArray(raw.files) || raw.files.length === 0) {
      errors.push(`harvest ${tag}: files must be a non-empty list`)
    } else {
      for (const file of raw.files) {
        if (isBlank(file)) {
          errors.push(`harvest ${tag}: files entries must be stripped non-empty strings`)
          break
        }
        // F8 traversal: every files[] entry must resolve inside .factory/design/.
        try {
          resolveInsideQueereye(LEDGER_PROBE_ROOT, String(file))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          errors.push(
            `harvest ${tag}: files entry ${pyRepr(file)} escapes .factory/design/ (traversal refused: ${message})`,
          )
          break
        }
      }
    }
    const kind = stripHardened(strOr(raw.evidence_kind))
    if (!LEDGER_EVIDENCE_KINDS.has(kind))
      errors.push(
        `harvest ${tag}: evidence_kind ${pyRepr(raw.evidence_kind)} must be one of ${pyList([...LEDGER_EVIDENCE_KINDS].sort())}`,
      )
    else if (kind === "dossier") {
      // Badge-launder: dossier hash must be a phase dossier member.
      const evidenceHash = stripHardened(strOr(raw.evidence_hash))
      if (!DOSSIER_HASHES.includes(evidenceHash))
        errors.push(
          `harvest ${tag}: dossier evidence_hash ${pyRepr(evidenceHash)} must be a phase dossier hash ${pyList([...DOSSIER_HASHES].sort())} (badge launder refused; registry claims are HYPOTHESIS, never VERIFIED)`,
        )
      else {
        const noteText = strOr(raw.note)
        if (!noteText.includes("VERIFIED") || !noteText.includes(evidenceHash))
          errors.push(
            `harvest ${tag}: dossier evidence must cite [VERIFIED: ${evidenceHash}] in the note (badge launder refused)`,
          )
      }
    } else {
      const noteText = strOr(raw.note)
      if (!noteText.includes("HYPOTHESIS") && !noteText.includes("NEGATIVE_KNOWLEDGE"))
        errors.push(
          `harvest ${tag}: non-dossier evidence must mark the claim HYPOTHESIS or NEGATIVE_KNOWLEDGE in the note (registry claims are never VERIFIED)`,
        )
    }
    if (isBlank(raw.evidence_hash)) errors.push(`harvest ${tag}: evidence_hash required (hash or bytes)`)
    // Bytes shape: license_bytes_sha256 must be 64-hex (faked BSD refused).
    const bytes = stripHardened(strOr(raw.license_bytes_sha256))
    if (!bytes || !HEX64_RE.test(bytes)) {
      errors.push(
        `harvest ${tag}: license_bytes_sha256 must be 64-hex sha256 (got ${pyRepr(bytes)}; faked BSD bytes refused)`,
      )
    } else if (bytes.toLowerCase() === "0".repeat(64)) {
      // Reject 0*64; pin MIT rows to vendored bytes.
      errors.push(`harvest ${tag}: license_bytes_sha256 0*64 refused (bytes hash never verified)`)
    } else if (license.toUpperCase() === "MIT") {
      if (bytes.toLowerCase() !== mitLicenseBytesSha256().toLowerCase())
        errors.push(
          `harvest ${tag}: MIT license_bytes_sha256 must pin vendored MIT bytes ${mitLicenseBytesSha256()} (bytes hash never verified)`,
        )
    } else if (license.toUpperCase() === "BSD-3-CLAUSE" || license.toUpperCase() === "ISC") {
      if (!bytes) errors.push(`harvest ${tag}: BSD/ISC claim requires LICENSE bytes hash (no bytes, no claim)`)
      else if (bytes.toLowerCase() === mitLicenseBytesSha256().toLowerCase())
        errors.push(`harvest ${tag}: BSD/ISC bytes must pin own LICENSE bytes, not MIT bytes (faked BSD refused)`)
    }
    if (
      (license.toUpperCase() === "BSD-3-CLAUSE" || license.toUpperCase() === "ISC") &&
      isBlank(raw.license_bytes_sha256)
    )
      errors.push(`harvest ${tag}: BSD/ISC claim requires LICENSE bytes hash (no bytes, no claim)`)
    if (
      (upstreamUpper.startsWith("GPL") || upstreamUpper.startsWith("AGPL")) &&
      (verdict === "depend" || verdict === "vendor")
    )
      errors.push(
        `harvest ${tag}: copyleft ${pyRepr(upstreamLicense)} is clean-room-only; ${verdict} refused (no GPL/AGPL bytes vendored)`,
      )
    // Closed platforms: clean-room-from-docs only, no repo to scan.
    let blob: string
    try {
      blob = (JSON.stringify(raw) ?? String(raw)).toLowerCase()
    } catch {
      blob = String(raw).toLowerCase()
    }
    for (const closed of CLOSED_PLATFORMS)
      if (blob.includes(closed)) {
        errors.push(`harvest ${tag}: closed platform '${closed}' refused (clean-room-from-docs only, no repo to scan)`)
        break
      }
  }
  const mitRows = rows.filter((row) => isRecord(row) && stripHardened(strOr(row.license)).toUpperCase() === "MIT")
  if (mitRows.length < 4) errors.push(`harvest ledger needs >=4 MIT rows, found ${mitRows.length}`)
  const axeRows = rows.filter((row) => isRecord(row) && row.skill === "axe-checks")
  if (axeRows.length === 0) errors.push("harvest ledger missing the axe-checks clean-room row")
  else {
    const axe = axeRows[0]!
    if (axe.verdict !== "clean-room") errors.push("harvest axe-checks must be clean-room (MPL-2.0 excluded)")
    if (stripHardened(strOr(axe.upstream_license)) !== "MPL-2.0")
      errors.push("harvest axe-checks must record upstream MPL-2.0")
  }
  return errors
}

/**
 * Validate the shadcn transitive-closure scan. Returns error list.
 *
 * Every entry needs dep/via/license_claim/status/risk; status is ``priced``
 * (risk priced, no bytes vendored) or ``negative`` (NEGATIVE_KNOWLEDGE,
 * excluded); copyleft claims may only enter as ``negative`` with a clean-room
 * note (never priced-verified bytes). The 6 mandated shadcn sub-deps must be
 * present (deletable closure refused) plus ISC/BSD-negative rows (never faked
 * whitelist coverage). Closed-platform names are refused.
 */
export function validateTransitiveClosure(deps: readonly unknown[] = TRANSITIVE_DEPS): string[] {
  const errors: string[] = []
  if (!Array.isArray(deps) || deps.length === 0) return ["transitive closure must be a non-empty scan list"]
  for (const [index, raw] of deps.entries()) {
    const tag = isRecord(raw) && "dep" in raw ? String(raw.dep) : `<dep ${index}>`
    if (!isRecord(raw)) {
      errors.push(`closure ${tag}: entry must be an object`)
      continue
    }
    for (const key of ["dep", "via", "license_claim", "status", "risk"])
      if (!(key in raw) || isBlank(raw[key])) errors.push(`closure ${tag}: missing/blank required key '${key}'`)
    const status = stripHardened(strOr(raw.status))
    if (status !== "priced" && status !== "negative")
      errors.push(`closure ${tag}: status ${pyRepr(raw.status)} must be priced|negative`)
    const claim = strOr(raw.license_claim).toUpperCase()
    if ((claim.includes("GPL") || claim.includes("AGPL")) && status !== "negative")
      errors.push(`closure ${tag}: copyleft claim must be negative/clean-room-only`)
    if (status === "negative") {
      const risk = strOr(raw.risk)
      if (!risk.includes("NEGATIVE_KNOWLEDGE") && !risk.includes("HYPOTHESIS"))
        errors.push(`closure ${tag}: negative status must carry NEGATIVE_KNOWLEDGE/HYPOTHESIS in risk`)
    }
    let blob: string
    try {
      blob = (JSON.stringify(raw) ?? String(raw)).toLowerCase()
    } catch {
      blob = String(raw).toLowerCase()
    }
    for (const closed of CLOSED_PLATFORMS)
      if (blob.includes(closed)) {
        errors.push(`closure ${tag}: closed platform '${closed}' refused (clean-room-from-docs only, no repo to scan)`)
        break
      }
  }
  const viaShadcn = deps.filter((raw) => isRecord(raw) && strOr(raw.via) === "shadcn/ui")
  if (viaShadcn.length === 0) errors.push("transitive closure must scan shadcn sub-deps (via shadcn/ui)")
  // Mandated: all 6 sub-deps present via shadcn/ui (deletable refused).
  const present = new Set(viaShadcn.map((raw) => strOr((raw as Record<string, unknown>).dep)))
  for (const mandated of [...MANDATED_CLOSURE_DEPS].sort())
    if (!present.has(mandated))
      errors.push(`closure missing mandated sub-dep '${mandated}' (deletable closure refused; scan shadcn sub-deps)`)
  // Negative rows: ISC + BSD must stay negative (never faked coverage).
  const hasIscNegative = deps.some(
    (raw) =>
      isRecord(raw) &&
      strOr(raw.license_claim).toUpperCase().includes("ISC") &&
      stripHardened(strOr(raw.status)) === "negative" &&
      (strOr(raw.risk).includes("NEGATIVE_KNOWLEDGE") || strOr(raw.risk).includes("HYPOTHESIS")),
  )
  if (!hasIscNegative)
    errors.push("closure missing ISC-negative row (lucide-react HYPOTHESIS; static list refused without negative)")
  const hasBsdNegative = deps.some(
    (raw) =>
      isRecord(raw) &&
      strOr(raw.license_claim).toUpperCase().includes("BSD") &&
      stripHardened(strOr(raw.status)) === "negative" &&
      (strOr(raw.risk).includes("NEGATIVE_KNOWLEDGE") || strOr(raw.risk).includes("HYPOTHESIS")),
  )
  if (!hasBsdNegative)
    errors.push("closure missing BSD-negative row (no BSD bytes cached; static list refused without negative)")
  return errors
}

// -- skill bundle ------------------------------------------------------------
//
// anthropics/skills SKILL.md frontmatter (name/description +
// license/compatibility/metadata/allowed-tools) + SKILL.md + scripts/ +
// references/ + assets/ layout + progressive-disclosure budgets. The spec
// mandates the frontmatter contract and ships a validator [VERIFIED: 84f80b6c].

/** Frontmatter fields the skill bundle contract requires. */
export const SKILL_FRONTMATTER_FIELDS: readonly string[] = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]

/** Disclosure budgets (tokens estimated wc-style: words x 1.3). */
export const META_TARGET_TOKENS = 100
export const META_BUDGET_TOKENS = 150
export const BODY_BUDGET_TOKENS = 5000

/** Python ``str.split()`` whitespace (word split for the token estimate). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Python str.split() treats the \x1c-\x1f separators as whitespace.
const PYTHON_WHITESPACE_RE = /[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u

/**
 * Conservative token estimate: ``max(words * 1.3, bytes / 4)``.
 *
 * Words-only (``words * 1.3``) is whitespace-evadable: a 200KB single-word
 * (no spaces) counts 1 word and sails under the 5000tok body cap. The byte
 * backstop (1tok ~ 4 bytes, rounded up) closes it: the same blob estimates
 * ~50k tok and fails. Both legs wc-measured.
 */
export function estimateTokens(text: unknown): number {
  if (typeof text !== "string" || !text) return 0
  const byteLength = new TextEncoder().encode(text).length
  const byteEstimate = Math.ceil(byteLength / 4)
  const words = text.split(PYTHON_WHITESPACE_RE).filter((word) => word !== "")
  if (words.length === 0) return byteEstimate
  const wordEstimate = Math.floor(words.length * 1.3) + 1
  return Math.max(wordEstimate, byteEstimate)
}

export type FrontmatterFields = Record<string, string>

/**
 * Split SKILL.md into ``[frontmatter, body]``.
 *
 * Returns ``[null, text]`` when no ``---`` frontmatter block opens the file.
 * Keys are hardened-stripped; values are raw strings (may span one line).
 */
export function splitFrontmatter(text: unknown): [FrontmatterFields | null, string] {
  if (typeof text !== "string" || !text.startsWith("---")) return [null, typeof text === "string" ? text : ""]
  const end = text.indexOf("---", 3)
  if (end < 0) return [null, text]
  const fm: FrontmatterFields = {}
  for (const line of splitLines(text.slice(3, end).trim())) {
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const key = stripHardened(line.slice(0, colon))
    const value = line.slice(colon + 1).trim()
    fm[key] = value
  }
  return [fm, text.slice(end + 3).replace(/^\n+/, "")]
}

/** Python ``str.splitlines()``: drop the empty tail a trailing newline creates. */
function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/u)
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * Validate a SKILL.md frontmatter block. Returns error list.
 *
 * Every field in :data:`SKILL_FRONTMATTER_FIELDS` must be present and
 * stripped non-empty (zero-width-only refused); ``license`` must be
 * whitelist-enforced; ``allowed-tools`` must name at least one tool.
 */
export function validateSkillFrontmatter(text: unknown): string[] {
  const [fm] = splitFrontmatter(text)
  const errors: string[] = []
  if (fm === null) return ["skill SKILL.md must open with a --- frontmatter block"]
  for (const field of SKILL_FRONTMATTER_FIELDS)
    if (!(field in fm) || isBlank(fm[field]))
      errors.push(`skill frontmatter missing/blank required field '${field}' [VERIFIED: 84f80b6c]`)
  const license = fm.license ?? ""
  if (!isBlank(license) && !WHITELIST_UPPER.has(license.trim().toUpperCase()))
    errors.push(
      `skill frontmatter license ${pyRepr(license)} rejected (whitelist: ${pyList(SORTED_LICENSE_WHITELIST)})`,
    )
  const tools = fm["allowed-tools"] ?? ""
  if (!isBlank(tools) && !stripHardened(tools)) errors.push("skill frontmatter allowed-tools must name tools")
  return errors
}

/**
 * Check progressive-disclosure budgets. Returns error list.
 *
 * Metadata (frontmatter values joined) targets ~100tok (hard cap 150); body
 * must stay under 5000tok. Both measured with :func:`estimateTokens`
 * (``max(words*1.3, bytes/4)`` byte backstop; single-word whitespace evasion
 * refused).
 */
export function disclosureBudgetCheck(text: unknown): string[] {
  const [fm, body] = splitFrontmatter(text)
  const errors: string[] = []
  if (fm === null) return ["skill SKILL.md must open with a --- frontmatter block"]
  const metaText = Object.values(fm).join(" ")
  const metaTokens = estimateTokens(metaText)
  if (metaTokens > META_BUDGET_TOKENS)
    errors.push(`skill metadata ${metaTokens}tok exceeds ~${META_TARGET_TOKENS}tok budget (cap ${META_BUDGET_TOKENS})`)
  const bodyTokens = estimateTokens(body)
  if (bodyTokens >= BODY_BUDGET_TOKENS)
    errors.push(`skill body ${bodyTokens}tok exceeds <${BODY_BUDGET_TOKENS}tok budget`)
  return errors
}

// Spec data embedded from d66328c:runner/queereye/specs.py (that module is not
// ported yet; these are single-source constants for the sections below).
const CVA_VARIANTS: readonly string[] = ["default", "outline", "ghost", "destructive", "secondary", "link"]
const CVA_SIZES: readonly string[] = ["default", "xs", "sm", "lg", "icon"]
const DIALOG_ANATOMY: readonly string[] = [
  "Root",
  "Trigger",
  "Portal",
  "Overlay",
  "Content",
  "Title",
  "Description",
  "Close",
]
const REQUIRED_STATES: readonly string[] = ["loading", "empty", "error", "disabled"]
const REQUIRED_SPEC_KEYS: readonly string[] = [
  "name",
  "anatomy",
  "props",
  "variants",
  "slots",
  "keyboard",
  "focus",
  "scroll",
  "usage",
  "states",
  "snippets",
  "csf",
  "tui_rows",
]

/**
 * Shared token-schema prose reused by the skill bundle AND the Claude overlay.
 *
 * Single source inside this module: both renderers embed this exact string, so
 * schema drift between surfaces is a byte-compare failure, not prose.
 */
export function tokenSchemaSection(): string {
  return (
    "## Token schema (single source: `.factory/design/tokens.json`)\n" +
    "\n" +
    `DTCG snapshot \`${DTCG_SNAPSHOT}\`: tokens are plain nested JSON ` +
    "with `$value` / `$type` / `$description` plus `{dotted.alias}` " +
    "references (Style-Dictionary-compat input shape) [VERIFIED: e3ecfe46] " +
    "carrying the W3C DTCG generic-token methodology [VERIFIED: 7f369895]; " +
    "aliasing [VERIFIED: 12c70178]. Rules: one-off mints are compile " +
    "errors (alias a primitive); every color pair ships computed contrast " +
    ">=4.5:1 normal / 3:1 large (7:1 AAA enhanced noted) [VERIFIED: 9c9c4f32]; " +
    "`STYLE_GUIDE.md` is a pure render of tokens + probes (drift = CI " +
    "failure). Theming substrate: Open Props MIT custom-property tokens " +
    "[VERIFIED: dbe9cbb4] (depend).\n"
  )
}

/** Shared spec-template prose reused by the skill bundle AND Claude overlay. */
export function specTemplateSection(): string {
  const variants = CVA_VARIANTS.join("/")
  const sizes = CVA_SIZES.join("/")
  return (
    "## Spec template (behavior-first contracts)\n" +
    "\n" +
    "Every component spec carries props/anatomy/variants/slots + a11y " +
    "annotations + paired web/tui snippets: shadcn-style prop-driven " +
    "surface [VERIFIED: dc656fd4] over the cva matrix (variant " +
    `${variants} x size ${sizes}) [VERIFIED: c24a9c9c]; unstyled ` +
    "primitives with specified focus, keyboard, and screen-reader " +
    "behavior [VERIFIED: 28a04ca6]; CSF `component` field required for " +
    "autodocs prop-tables, play functions run headless " +
    "[VERIFIED: 60c8c31d]. Dialog anatomy " +
    `(${DIALOG_ANATOMY.join(", ")}) re-specifies focus-trap, ` +
    "Esc-close, pointer-outside, and SR announcements per target " +
    "(pointer-first web vs keyboard-first TUI inversion) " +
    "[VERIFIED: 0785dc45]. Checklist order: props, variants, slots, " +
    "keyboard, focus, scroll, usage do/don't, states " +
    "(loading/empty/error/disabled), snippets, csf, tui_rows.\n"
  )
}

/** Render the queereye skill bundle ``SKILL.md`` (deterministic). */
export function renderSkillMd(): string {
  const lines: string[] = []
  lines.push("---")
  lines.push("name: queereye-style")
  lines.push(
    "description: Interview-driven living style guide for brand color type " +
      "layout effects and dark-light modes with AA contrast gates and " +
      "behavior-first component specs portable across web and terminal.",
  )
  lines.push("license: MIT")
  lines.push("compatibility: opencode-v2 agent profile + claude-code skill")
  lines.push("metadata: tokens=dtcg-2025.10 guide=.factory/design ledger=harvest.json")
  lines.push("allowed-tools: read .factory/design/tokens.json, run queereye check, render guide")
  lines.push("---")
  lines.push("")
  lines.push("# Queereye Style Skill")
  lines.push("")
  lines.push(
    "Interview-driven living UI/UX fuel (permissive-only, SPDX-ledgered). " +
      "Claude Code merged custom commands into skills: this `SKILL.md` and a " +
      "`.claude/commands` file both create the same slash command " +
      "[VERIFIED: ca41333c]. Under OpenCode V2 the same skill drives the " +
      "`queereye` named agent profile (system prompt + model + permissions) " +
      "[VERIFIED: aab8ead6].",
  )
  lines.push("")
  lines.push(tokenSchemaSection())
  lines.push("")
  lines.push(specTemplateSection())
  lines.push("")
  lines.push("## A11y rules (gated, not advised)")
  lines.push("")
  lines.push(
    "Contrast-ratio-first generation [VERIFIED: 44295aec]: every pair " +
      ">=4.5:1 (3:1 large); decorative-but-inaccessible pairs are compile " +
      "errors. TUI lowering is deterministic: blur->border, hover->" +
      "focus-visible, motion->instant + reduced-motion variant; every web-only " +
      "primitive (focus-trap, Esc-close, pointer-outside, SR announcements) " +
      "gets a TUI re-spec row. axe-core (MPL-2.0) is excluded to " +
      "behavior-only checks [VERIFIED: d0679fbc]; ARIA 1.2 contracts are " +
      "rebuilt behavior-only.",
  )
  lines.push("")
  lines.push("## Snippet harness (headless play functions)")
  lines.push("")
  lines.push(
    "Stories pair each component with states as data (args), not prose; " +
      "the harness executes assertions against the rendered story without " +
      "user interaction and reports a snippet pass-rate (must be 1.00). " +
      "Harvest ledger: `.factory/design/harvest.json` (machine rows " +
      "{skill,verdict,license,upstream,files,evidence_hash}; whitelist " +
      "MIT/Apache-2.0/BSD-3-Clause/ISC; SPDX blocks; transitive closure; " +
      "style hashes dbe9cbb4 890dc55a 74144f6a d0679fbc 84f80b6c aab8ead6 " +
      "ca41333c).",
  )
  lines.push("")
  return lines.join("\n")
}

/**
 * Render the Claude overlay single ``SKILL.md`` (deterministic).
 *
 * Reuses :func:`tokenSchemaSection` and :func:`specTemplateSection`
 * byte-for-byte with the skill bundle (commands==skills merged shape
 * [VERIFIED: ca41333c]): overlay drift from the bundle schema is a
 * byte-compare failure.
 */
export function renderOverlaySkillMd(): string {
  const lines: string[] = []
  lines.push("---")
  lines.push("name: queereye-style")
  lines.push(
    "description: Claude overlay for the queereye living style guide with " +
      "AA contrast gates and portable behavior-first component specs.",
  )
  lines.push("license: MIT")
  lines.push("compatibility: claude-code skill (commands==skills merged shape)")
  lines.push("metadata: tokens=dtcg-2025.10 guide=.factory/design overlay=skill-claude")
  lines.push("allowed-tools: read .factory/design/tokens.json, run queereye check, render guide")
  lines.push("---")
  lines.push("")
  lines.push("# Queereye Style (Claude Overlay)")
  lines.push("")
  lines.push(
    "Single-`SKILL.md` overlay reusing the queereye token schema + spec " +
      "templates: a `SKILL.md` skill and a `.claude/commands` file both " +
      "create the same slash command [VERIFIED: ca41333c], so this file is " +
      "the whole overlay (no second config dialect). Pair with the OpenCode " +
      "V2 `queereye` agent profile surface as needed [VERIFIED: aab8ead6].",
  )
  lines.push("")
  lines.push(tokenSchemaSection())
  lines.push("")
  lines.push(specTemplateSection())
  lines.push("")
  lines.push(
    "Parity rule: scripted interview answers replayed through the " +
      "OpenCode surface and this Claude surface must produce byte-identical " +
      "`.factory/design/` outputs (tokens.json, tokens.css, STYLE_GUIDE.md, " +
      "probes.json); divergence is a failing test.",
  )
  lines.push("")
  return lines.join("\n")
}

/** Render ``skill/references/checklists.md`` from the spec template. */
export function renderChecklistsMd(): string {
  const lines = ["# Component spec checklists (clean-room)", ""]
  lines.push("Required sections (missing section = FAIL):")
  lines.push("")
  for (const key of REQUIRED_SPEC_KEYS) lines.push(`- \`${key}\``)
  lines.push("")
  lines.push("States every spec must address:")
  lines.push("")
  for (const state of REQUIRED_STATES) lines.push(`- \`${state}\``)
  lines.push("")
  lines.push("Dialog anatomy (full Radix part list required):")
  lines.push("")
  for (const part of DIALOG_ANATOMY) lines.push(`- \`${part}\``)
  lines.push("")
  lines.push(`cva variant axis: ${CVA_VARIANTS.map((variant) => `\`${variant}\``).join(", ")}`)
  lines.push("")
  lines.push(`cva size axis: ${CVA_SIZES.map((size) => `\`${size}\``).join(", ")}`)
  lines.push("")
  return lines.join("\n")
}

/** Render ``skill/references/a11y-rules.md`` (gated rules). */
export function renderA11yRulesMd(): string {
  const lines = ["# A11y rules (gated, not advised)", ""]
  lines.push(
    `- Contrast: normal text >=${WCAG_AA_NORMAL.toFixed(1)}:1, large text ` +
      `>=${WCAG_AA_LARGE.toFixed(1)}:1 (AAA enhanced ${WCAG_AAA_ENHANCED.toFixed(1)}:1 ` +
      "noted) [VERIFIED: 9c9c4f32]; generation is contrast-first " +
      "[VERIFIED: 44295aec].",
  )
  lines.push(
    "- Keyboard: every spec ships a non-empty keyboard table; focus is " +
      "re-specified per target with the keyboard-first/event-loop inversion " +
      "documented in focus.tui [VERIFIED: 0785dc45].",
  )
  lines.push(
    "- TUI downgrade rows per state: blur->border, hover->focus-visible, " +
      "motion->instant + reduced-motion variant.",
  )
  lines.push(
    "- Exclusions: axe-core (MPL-2.0) behavior-only [VERIFIED: d0679fbc]; " +
      "ARIA 1.2 contracts rebuilt behavior-only; no color-only signaling.",
  )
  lines.push("")
  return lines.join("\n")
}
