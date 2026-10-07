// TUI notes as deterministic lowering: constraints + dichotomous key
// (phase queereye-02, port of d66328c:runner/queereye/tui.py).
//
// Pointer-first web vs keyboard-first TUI is an input-model inversion,
// documented here — not prose-waved:
//
// - Web-only primitives (Radix Dialog gap): focus trapped within modal, Esc
//   closes automatically, pointer-outside dismissal, screen-reader
//   announcements [VERIFIED: 0785dc45]. None of these exists in a terminal;
//   the port gap is structural, so every one gets an explicit TUI re-spec row.
// - Behavior wording follows the unstyled-primitive contract (specified
//   focus, keyboard, screen-reader behavior) [VERIFIED: 28a04ca6]; each web
//   behavior below lowers to a terminal behavior deterministically.
// - Downgrade rows: blur -> border, hover -> focus-visible, motion ->
//   instant + reduced-motion variant (plus focus-trap/Esc/pointer/SR rows).
//
// NEGATIVE_KNOWLEDGE(tui-host-caps): whether the deployed TUI host can
// render hover tints, backdrop blur, or timed motion is UNMEASURED in this
// phase — no downgrade row asserts host render correctness, only the
// specified fallback. An experiment spike (render probe per capability) is
// required before any row may claim pixel fidelity; until then every
// motion/blur/hover row is a specification of the fallback, not a
// measurement of the host.
//
// Pure data + deterministic helpers: no file I/O, no network.

/** Zero-width set `String.prototype.trim` misses (ZWSP/WJ/BOM family). */
const ZERO_WIDTH_CHARS = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u200e", "\u200f", "\u00ad"]

// d66328c:runner/queereye/tui.py (_strip_hardened)
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

// d66328c:runner/queereye/tui.py (_is_blank_hardened)
/** True when not a hardened stripped non-empty string. */
export function isBlankHardened(value: unknown): boolean {
  const stripped = stripHardened(value)
  return typeof stripped !== "string" || stripped.length === 0
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Python-style `repr()` for a string in an error message. */
const repr = (value: string): string => `'${value}'`

/** Python `str()` for the scalar values a state label can carry. */
const pythonStr = (value: unknown): string => {
  if (value === null || value === undefined) return "None"
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  return String(value)
}

// d66328c:runner/queereye/tui.py (_WAIVER_ALLOWLIST)
/** Domain vocabulary proving a waiver/note carries a semantic phrase
 * (not `xxxx xxxxx`). TUI + component + license rebuild terms. */
export const WAIVER_ALLOWLIST: ReadonlySet<string> = new Set([
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
  "destructive",
  "variant",
  "size",
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
  "icon-only",
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
])

// d66328c:runner/queereye/tui.py (_waiver_has_semantic_phrase)
/** True when `reason` carries a semantic phrase (>=20 chars + words).
 *
 * Requires hardened length >=20 plus either >=2 allowlist words or
 * >=4 distinct good words (each with >=3 distinct letters). `xxxx xxxxx`
 * (10 chars, 2 low-entropy words, 0 allowlist) fails both branches; the
 * exemplar waiver (60 chars, 6+ allowlist, 8+ good words) passes.
 */
export function waiverHasSemanticPhrase(reason: unknown): boolean {
  if (typeof reason !== "string") return false
  const stripped = hardenedString(reason)
  if (stripped.length < 20) return false
  const words = stripped.match(/[A-Za-z]{2,}/g) ?? []
  if (words.length < 3) return false
  const distinct = new Set(words.map((word) => word.toLowerCase()))
  if (distinct.size < 3) return false
  const good = [...distinct].filter((word) => new Set(word).size >= 3 && word.length >= 3)
  if ([...distinct].filter((word) => WAIVER_ALLOWLIST.has(word)).length >= 2 && good.length >= 2 && distinct.size >= 3)
    return true
  // Strict prose branch: >=4 distinct, >=3 good words (varied alphabet).
  return distinct.size >= 4 && good.length >= 3
}

/** Terminal capability: the web assumption and the TUI constraint. */
export interface ConstraintEntry {
  readonly web: string
  readonly tui: string
}

// d66328c:runner/queereye/tui.py (CONSTRAINT_CATALOG)
/** Constraint catalog: the terminal capabilities every lowering assumes.
 * Each entry names the web assumption and the TUI constraint. `hover` and
 * `motion` carry the NEGATIVE_KNOWLEDGE host-cap flag (fallback specified,
 * host render unmeasured). */
export const CONSTRAINT_CATALOG: Readonly<Record<string, ConstraintEntry>> = {
  "region-geometry": {
    web: "Free CSS layout (flex/grid, overlapping layers, z-index).",
    tui: "Fixed grid of character cells; components own rectangular regions.",
  },
  "event-focus-routing": {
    web: "OS/browser focus + pointer events routed by the compositor.",
    tui: "Single terminal event loop; focus is an explicit ordered list.",
  },
  keybindings: {
    web: "Keyboard is one of several inputs (pointer-first).",
    tui: "Keyboard-first: every pointer gesture needs a key equivalent.",
  },
  "palette-depth": {
    web: "24-bit color + alpha compositing.",
    tui: "Indexed/approximated palette; no alpha (borders instead of translucency).",
  },
  hover: {
    web: "Pointer hover states (:hover).",
    tui: "No hover: focus-visible border is the only highlight. [NEGATIVE_KNOWLEDGE: host hover unmeasured]",
  },
  motion: {
    web: "Timed transitions/animations (150-250ms).",
    tui: "Instant swap + reduced-motion variant. [NEGATIVE_KNOWLEDGE: host animation unmeasured]",
  },
}

// d66328c:runner/queereye/tui.py (WEB_ONLY_PRIMITIVES)
/** Web-only primitives requiring a TUI re-spec row (the Radix gap
 * [VERIFIED: 0785dc45] plus SR behavior from the behavior contract
 * [VERIFIED: 28a04ca6]). */
export const WEB_ONLY_PRIMITIVES: Readonly<Record<string, ConstraintEntry>> = {
  "focus-trap": {
    web: "Focus is automatically trapped within modal [VERIFIED: 0785dc45].",
    tui: "Explicit focus list pinned to the dialog region; Tab cycles the list.",
  },
  "esc-close": {
    web: "Esc closes the component automatically [VERIFIED: 0785dc45].",
    tui: "Event-loop keybinding (Esc/q) closes and restores focus to Trigger.",
  },
  "pointer-outside": {
    web: "Outside pointer event dismisses the overlay.",
    tui: "No pointer: explicit Close control + keybinding dismisses.",
  },
  "sr-announcement": {
    web: "Title/Description announced by the screen reader [VERIFIED: 28a04ca6].",
    tui: "Status-line text set on open/change (plain-text announcement).",
  },
}

/** One downgrade row: a web visual state and its TUI lowering. */
export interface TuiRow {
  readonly state: string
  readonly web: string
  readonly tui: string
}

// d66328c:runner/queereye/tui.py (DOWNGRADE_ROWS)
/** Every visual state gets an explicit downgrade row. */
export const DOWNGRADE_ROWS: readonly TuiRow[] = [
  { state: "blur", web: "soft shadow / backdrop blur", tui: "single-line border (no blur)" },
  { state: "hover", web: "pointer hover tint", tui: "focus-visible border (no pointer)" },
  { state: "focus", web: ":focus-visible ring", tui: "inverted border on focused row (keyboard-first)" },
  { state: "motion", web: "150ms transition", tui: "instant + reduced-motion variant" },
  { state: "focus-trap", web: "OS-level focus trapped within modal", tui: "explicit focus list pinned to region" },
  { state: "esc-close", web: "Esc closes automatically", tui: "Esc/q keybinding closes (event-loop)" },
  { state: "pointer-outside", web: "outside pointer event dismisses", tui: "explicit Close key (no pointer)" },
  { state: "sr-announcement", web: "Title/Description announced by SR", tui: "status-line text set on open" },
  { state: "loading", web: "spinner / shimmer", tui: "static glyph + text (no animation)" },
  { state: "empty", web: "empty copy with single action", tui: "empty text + single action row (no animation)" },
  { state: "disabled", web: "dimmed + no pointer events", tui: "dimmed + skipped in focus order" },
  { state: "error", web: "ring + SR text", tui: "error line printed below field" },
]

// d66328c:runner/queereye/tui.py (NEGATIVE_KNOWLEDGE)
/** NEGATIVE_KNOWLEDGE entries: host capabilities this phase does NOT assert. */
export const NEGATIVE_KNOWLEDGE: readonly string[] = [
  "NEGATIVE_KNOWLEDGE(tui-hover-render): host hover-tint rendering unmeasured; rows specify the focus-visible fallback only.",
  "NEGATIVE_KNOWLEDGE(tui-blur-render): host blur/backdrop rendering unmeasured; rows specify the border fallback only.",
  "NEGATIVE_KNOWLEDGE(tui-motion-render): host animation timing unmeasured; rows specify instant + reduced-motion only.",
]

// d66328c:runner/queereye/tui.py (_MIN_WAIVER_LEN)
/** Minimum waiver reason length: waivers carry conditions — 'xxxx xxxxx'
 * (10 chars + space) is NOT a reason phrase: waivers need >=20 chars + a
 * semantic phrase. */
export const MIN_WAIVER_LEN = 20

// d66328c:runner/queereye/tui.py (EVENT_LOOP_NOTE)
/** Terminal event-loop architecture note (model/state + keyboard-first). */
export const EVENT_LOOP_NOTE =
  "Terminal event loop: a single queue delivers key/resize events to the " +
  "focused region; focus is an explicit ordered list (keyboard-first " +
  "inversion of the pointer-first web); regions re-render synchronously on " +
  "state change; motion is an instant swap honoring the reduced-motion " +
  "variant; announcements are plain-text status-line writes."

// d66328c:runner/queereye/tui.py (lowering_for)
/** Dichotomous-key lowering for one web state name.
 *
 * Deterministic total function over the known states: exact (case-folded,
 * stripped) match against `DOWNGRADE_ROWS` wins; unknown states lower to the
 * conservative `explicit text + border` fallback row (never a silent
 * pass-through). Raises nothing.
 */
export function loweringFor(state: unknown): TuiRow {
  const key = hardenedString(state ? pythonStr(state) : "").toLowerCase()
  for (const row of DOWNGRADE_ROWS) if (row.state.toLowerCase() === key) return { ...row }
  return {
    state: pythonStr(state),
    web: "unspecified web state",
    tui: "explicit text + border fallback (no web behavior inherited)",
  }
}

// d66328c:runner/queereye/tui.py (validate_tui_coverage)
/** TUI-coverage unit: every web-only primitive + downgrade state covered.
 *
 * Returns error list: unknown/missing rows for every entry in
 * `WEB_ONLY_PRIMITIVES` (all 4 required for every spec — dialog and
 * button/input alike [VERIFIED: 0785dc45]) plus every state in
 * `DOWNGRADE_ROWS` plus every key in `spec.states`. Every row must carry
 * stripped non-empty `web` + `tui`. A missing state fails unless the spec
 * carries an explicit waiver (`spec.tui_waivers[state]` with a stripped
 * non-empty, semantic reason). Empty = covered.
 */
export function validateTuiCoverage(spec: unknown): string[] {
  if (!isRecord(spec)) return ["spec must be an object"]
  const name = pythonStr(spec.name === undefined ? "<unnamed>" : spec.name)
  const errors: string[] = []
  const rows = spec.tui_rows
  if (!Array.isArray(rows) || rows.length === 0) return [`${name}: tui_rows must be non-empty`]
  const byState = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    if (!isRecord(row)) {
      errors.push(`${name}: tui_rows entry must be an object`)
      continue
    }
    const stateKey = hardenedString(row.state === undefined ? "" : pythonStr(row.state)).toLowerCase()
    if (!stateKey) {
      errors.push(`${name}: tui_rows entry has blank 'state'`)
      continue
    }
    byState.set(stateKey, row)
  }
  // Every row must carry stripped non-empty web + tui (no empty downgrade).
  for (const row of rows) {
    if (!isRecord(row)) continue
    const stateLabel = hardenedString(row.state === undefined ? "" : pythonStr(row.state)) || "<blank>"
    for (const field of ["web", "tui"] as const)
      if (isBlankHardened(row[field])) errors.push(`${name}: tui_rows[${stateLabel}] has empty ${field} lowering`)
  }
  // All 4 web-only primitives required for every spec (no non-dialog
  // exemption) [VERIFIED: 0785dc45].
  for (const primitive of Object.keys(WEB_ONLY_PRIMITIVES))
    if (!byState.has(primitive)) errors.push(`${name}: tui_rows missing web-only primitive ${repr(primitive)}`)
  // Waivers (explicit state -> reason) excuse a missing DOWNGRADE or state
  // row; blank/absent/short reason still FAILs (no silent empty/error
  // exemption; single-char 'x' laundering refused — waivers carry
  // conditions, >=10 chars with a reason phrase).
  let waivers: Record<string, unknown> = {}
  const waiversRaw = spec.tui_waivers === undefined ? {} : spec.tui_waivers
  if (waiversRaw === null) waivers = {}
  else if (!isRecord(waiversRaw)) {
    errors.push(`${name}: tui_waivers must be an object when present`)
  } else {
    waivers = waiversRaw
    for (const [wkey, reason] of Object.entries(waivers)) {
      if (typeof reason !== "string" || !hardenedString(reason))
        errors.push(
          `${name}: tui_waivers[${repr(wkey)}] reason must be a stripped non-empty string (blank/zero-width refused; waivers carry conditions)`,
        )
      else if (!waiverHasSemanticPhrase(reason))
        errors.push(
          `${name}: tui_waivers[${repr(wkey)}] reason must carry a semantic phrase (>=20 chars + >=2 allowlist words or >=20 chars + distinct good words; 'xxxx xxxxx' gibberish refused; waivers carry conditions)`,
        )
    }
  }
  const waived = (key: string): boolean => {
    for (const candidate of [key, hardenedString(key).toLowerCase()]) {
      const reason = waivers[candidate]
      if (typeof reason === "string" && waiverHasSemanticPhrase(reason)) return true
    }
    return false
  }
  // Full DOWNGRADE_ROWS coverage required for every spec (no per-spec
  // subset: dialog missing hover/focus and button/input missing rows FAIL).
  for (const downgrade of DOWNGRADE_ROWS) {
    const key = downgrade.state.toLowerCase()
    if (!byState.has(key) && !waived(key))
      errors.push(`${name}: tui_rows missing downgrade row ${repr(key)} (full DOWNGRADE_ROWS coverage required)`)
  }
  // Every spec state needs its own explicit downgrade row (no
  // empty/error exemption unless explicitly waived with reason).
  // Non-dict states (e.g. "evil") skip coverage silently — refused here.
  const states = spec.states === undefined ? {} : spec.states
  if (!isRecord(states)) {
    errors.push(`${name}: states must be an object (non-dict states refused; coverage cannot be skipped)`)
  } else {
    for (const state of Object.keys(states)) {
      const key = hardenedString(state).toLowerCase()
      if (!byState.has(key) && !waived(state) && !waived(key))
        errors.push(
          `${name}: state ${repr(state)} has no tui_rows downgrade row (waive explicitly via tui_waivers with reason if truly n/a)`,
        )
    }
  }
  return errors
}

// d66328c:runner/queereye/tui.py (render_tui_notes)
/** Pure render of `.queereye/tui-notes.md` (deterministic). */
export function renderTuiNotes(): string {
  const lines: string[] = []
  lines.push("# TUI notes — deterministic lowering")
  lines.push("")
  lines.push(
    "_Pointer-first web vs keyboard-first TUI is an input-model inversion, " +
      "not a style tweak. Web-only primitives (focus trapped within modal, " +
      "Esc closes automatically [VERIFIED: 0785dc45]; specified focus, " +
      "keyboard, and screen-reader behavior [VERIFIED: 28a04ca6]) each get " +
      "an explicit TUI re-spec row below._",
  )
  lines.push("")
  lines.push("## Constraint catalog")
  lines.push("")
  lines.push("| constraint | web | tui |")
  lines.push("| --- | --- | --- |")
  for (const name of Object.keys(CONSTRAINT_CATALOG).sort()) {
    const entry = CONSTRAINT_CATALOG[name]!
    lines.push(`| ${name} | ${entry.web} | ${entry.tui} |`)
  }
  lines.push("")
  lines.push("## Dichotomous key (lowering decision tree)")
  lines.push("")
  lines.push("```text")
  lines.push("state needs pointer position? --yes--> explicit Close/focus key (no pointer)")
  lines.push("  --no--> state needs OS focus trap? --yes--> pin explicit focus list to region")
  lines.push("  --no--> state needs SR announcement? --yes--> status-line text write")
  lines.push("  --no--> state is blur/hover/motion? --yes--> border / focus-visible / instant")
  lines.push("  --no--> explicit text + border fallback (never inherit web behavior)")
  lines.push("```")
  lines.push("")
  lines.push("## Downgrade rows (every state)")
  lines.push("")
  lines.push("| state | web | tui |")
  lines.push("| --- | --- | --- |")
  for (const row of DOWNGRADE_ROWS) lines.push(`| ${row.state} | ${row.web} | ${row.tui} |`)
  lines.push("")
  lines.push("## Terminal event loop")
  lines.push("")
  lines.push(EVENT_LOOP_NOTE)
  lines.push("")
  lines.push("## Negative knowledge (unmeasured host caps)")
  lines.push("")
  for (const entry of NEGATIVE_KNOWLEDGE) lines.push(`- ${entry}`)
  lines.push("")
  lines.push(
    "An experiment spike (render probe per capability) is required before " + "any row may claim pixel fidelity.",
  )
  lines.push("")
  return lines.join("\n")
}
