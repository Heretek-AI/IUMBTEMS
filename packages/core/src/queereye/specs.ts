// Generic component spec template: anatomy + props/variants/slots + a11y,
// ported from d66328c:runner/queereye/specs.py. Specs are behavior-first
// WHATWG/Radix-grade contracts portable across web and terminal, with CSF as
// the interchange shape and copy-own distribution:
//
// - shadcn-style prop-driven API surface is the ideal pin target for specs
//   because variant/size props already drive generic markup [VERIFIED: dc656fd4].
// - The cva variant/size API matrix is variant
//   default/outline/ghost/destructive/secondary/link x size
//   default/xs/sm/lg/icon [VERIFIED: c24a9c9c].
// - CSF is the proven open-standard shape for pairing a component with its
//   states as data (args) rather than prose [VERIFIED: 60c8c31d].
//
// Zero runtime dependencies, no network, no randomness: specs are local
// clean-room data structures rendered deterministically to
// `.queereye/components/<name>.md` (byte-match + `--check` drift gate,
// mirroring the phase-01 STYLE_GUIDE pattern).

/** cva variant axis [VERIFIED: c24a9c9c]. */
export const CVA_VARIANTS: readonly string[] = ["default", "outline", "ghost", "destructive", "secondary", "link"]

/** cva size axis [VERIFIED: c24a9c9c]. */
export const CVA_SIZES: readonly string[] = ["default", "xs", "sm", "lg", "icon"]

/** Canonical part names (Radix Dialog anatomy). */
export const DIALOG_ANATOMY: readonly string[] = [
  "Root",
  "Trigger",
  "Portal",
  "Overlay",
  "Content",
  "Title",
  "Description",
  "Close",
]

export const BUTTON_ANATOMY: readonly string[] = ["Root", "Label", "Icon", "Spinner"]

export const INPUT_ANATOMY: readonly string[] = ["Root", "Label", "Field", "Hint", "Error"]

// Phase-02 extension beyond d66328c: table, nav and toast ship alongside the
// original three exemplars, each with its own fixed anatomy.
export const TABLE_ANATOMY: readonly string[] = ["Root", "Caption", "Header", "Body", "Row", "Cell"]

export const NAV_ANATOMY: readonly string[] = ["Root", "List", "Item", "Link", "Icon"]

export const TOAST_ANATOMY: readonly string[] = [
  "Root",
  "Viewport",
  "Toast",
  "Icon",
  "Title",
  "Description",
  "Action",
  "Close",
]

/** States every spec must address (loading/empty/error/disabled). */
export const REQUIRED_STATES: readonly string[] = ["loading", "empty", "error", "disabled"]

/** Top-level keys every spec must carry; `csf` names the autodocs component and `tui_rows` the lowering rows. */
export const REQUIRED_SPEC_KEYS: readonly string[] = [
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
 * Spec names this phase ships. Unknown names (e.g. "evil") previously skipped
 * full-anatomy enforcement (`_expected is None`); they are now refused
 * outright [VERIFIED: 0785dc45]. The original three (d66328c) plus the
 * phase-02 additions table/nav/toast.
 */
export const KNOWN_SPEC_NAMES: ReadonlySet<string> = new Set([
  "button",
  "dialog",
  "form-input",
  "nav",
  "table",
  "toast",
])

const KNOWN_SPEC_NAMES_SORTED: readonly string[] = [...KNOWN_SPEC_NAMES].sort()

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface PropDecl {
  type: string
  values?: unknown[]
  default?: unknown
}

export interface VariantMatrix {
  variant: string[]
  size: string[]
  default: Record<string, unknown>
}

export interface SlotDecl {
  description: string
}

export interface KeyboardRow {
  keys: string
  action: string
}

export interface Respec {
  web: string
  tui: string
}

export interface SpecUsage {
  do: string[]
  dont: string[]
}

export interface Snippets {
  web: string
  tui: string
}

export interface CsfMeta {
  component: string
  title?: string
  [key: string]: unknown
}

export interface TuiRow {
  state: string
  web: string
  tui: string
}

export interface ComponentSpec {
  name: string
  anatomy: string[]
  props: Record<string, PropDecl>
  variants: VariantMatrix
  slots: Record<string, SlotDecl>
  keyboard: KeyboardRow[]
  focus: Respec
  scroll: Respec
  usage: SpecUsage
  states: Record<string, string>
  snippets: Snippets
  csf: CsfMeta
  tui_rows: TuiRow[]
}

// ---------------------------------------------------------------------------
// Hardened string checks (d66328c:runner/queereye/specs.py _strip_hardened)
// ---------------------------------------------------------------------------

/**
 * Zero-width / invisible characters Python str.strip() misses (ZWSP/WJ/BOM
 * family). Blank checks must remove these before stripping, otherwise
 * "\u200b" (single ZWSP) launders as non-blank.
 */
const ZERO_WIDTH_CHARS = "\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u00ad"

const stripHardened = (value: string): string => {
  let cleaned = value
  for (const char of ZERO_WIDTH_CHARS) {
    if (cleaned.includes(char)) cleaned = cleaned.replaceAll(char, "")
  }
  return cleaned.trim()
}

const isBlank = (value: unknown): boolean => typeof value !== "string" || stripHardened(value).length === 0

/** Prose-wave placeholder detector (todo/tbd/fixme). */
const hasPlaceholder = (value: unknown): boolean => {
  const lowered = String(value || "").toLowerCase()
  return lowered.includes("todo") || lowered.includes("tbd") || lowered.includes("fixme")
}

/** Minimum prose length for per-target re-specs (rejects "x" waves). */
const MIN_RESPEC_LEN = 20

/** Keywords proving the keyboard-first/event-loop inversion is documented in `focus.tui` [VERIFIED: 0785dc45]. */
const FOCUS_TUI_KEYWORDS: readonly string[] = ["keyboard-first", "event-loop", "event loop", "focus list"]

/** Keywords proving scroll re-specs carry layout/scroll meaning (not gibberish). */
const SCROLL_KEYWORDS: readonly string[] = [
  "scroll",
  "region",
  "overflow",
  "lock",
  "frozen",
  "pinned",
  "clip",
  "sticky",
  "footer",
  "content",
  "viewport",
  "layout",
  "width",
  "horizontal",
  "vertical",
]

/** Repeat-run probe: any alnum char repeated 10+ consecutively (`x*100`) is gibberish. */
const REPEAT_RUN_RE = /([A-Za-z0-9])\1{9,}/

/** Minimum snippet length: trivial `Button` (6 chars) passes a 40-char probe via the component tag [VERIFIED: 60c8c31d]. */
const MIN_SNIPPET_LEN = 20

/** TUI vocabulary accepted as a semantic link for `snippets.tui` only. */
const TUI_SNIPPET_VOCAB: readonly string[] = [
  "focus",
  "border",
  "region",
  "keyboard",
  "event-loop",
  "event loop",
  "inverted",
  "caret",
  "status",
  "row",
  "cell",
  "grid",
  "scroll",
  "hover",
  "motion",
]

const distinctKeywordHits = (textLower: string, keywords: readonly string[]): number =>
  keywords.reduce((hits, keyword) => hits + (textLower.includes(keyword) ? 1 : 0), 0)

/** True when `text` is repetition-dominated gibberish (`x*20`/`scroll + x*100`). */
const isLowEntropy = (text: unknown): boolean => {
  if (typeof text !== "string" || !text) return true
  if (REPEAT_RUN_RE.test(text)) return true
  const alnum = text.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (!alnum) return true
  if (alnum.length >= 10 && new Set(alnum).size <= 2) return true
  if (alnum.length >= 20) {
    let most = 0
    for (const char of new Set(alnum)) {
      let count = 0
      for (const candidate of alnum) if (candidate === char) count += 1
      if (count > most) most = count
    }
    if (most / alnum.length > 0.5) return true
  }
  return false
}

/** True when `text` carries real prose (>= minWords alpha words, >= minDistinct distinct, no low-entropy dominance). */
const meetsProseBar = (text: unknown, minWords = 4, minDistinct = 3): boolean => {
  if (typeof text !== "string") return false
  const words = text.match(/[A-Za-z]{2,}/g) ?? []
  if (words.length < minWords) return false
  if (new Set(words.map((word) => word.toLowerCase())).size < minDistinct) return false
  return !isLowEntropy(text)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Python `repr()`-shaped formatting for error messages (rule text parity). */
const pyRepr = (value: unknown): string => {
  if (typeof value === "string") return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
  if (typeof value === "boolean") return value ? "True" : "False"
  if (value === null || value === undefined) return "None"
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`,
    )
    return `{${entries.join(", ")}}`
  }
  return String(value)
}

const pyList = (items: readonly unknown[]): string => `[${items.map(pyRepr).join(", ")}]`

const pyStr = (value: unknown): string => (value === null || value === undefined ? "None" : String(value))

const err = (specName: unknown, message: string): string => `${pyStr(specName)}: ${message}`

/**
 * Lowercased tokens a snippet must reference (component/variant/slot):
 * spec-name parts (`form-input` -> `form`/`input`), CSF component camel parts
 * (`FormInput` -> `form`/`input`), slot names, anatomy parts and the cva
 * variant/size axes [VERIFIED: c24a9c9c].
 */
const specSemanticTokens = (spec: Record<string, unknown>): Set<string> => {
  const tokens = new Set<string>()
  const name = "name" in spec ? String(spec.name || "") : ""
  for (const part of name.split(/[^A-Za-z0-9]+/)) {
    if (part.length >= 3) tokens.add(part.toLowerCase())
  }
  const normalizedName = name.trim().toLowerCase().replaceAll("-", "").replaceAll("_", "")
  if (normalizedName.length >= 3) tokens.add(normalizedName)
  const csf = isRecord(spec.csf) ? spec.csf : {}
  const component = typeof csf.component === "string" ? csf.component : csf.component ? String(csf.component) : ""
  for (const part of component.match(/[A-Za-z]{3,}/g) ?? []) tokens.add(part.toLowerCase())
  const normalizedComponent = component.trim().toLowerCase().replaceAll("-", "").replaceAll("_", "")
  if (normalizedComponent.length >= 3) tokens.add(normalizedComponent)
  if (isRecord(spec.slots)) {
    for (const slot of Object.keys(spec.slots)) {
      if (slot.trim().length >= 2) tokens.add(slot.trim().toLowerCase())
    }
  }
  if (Array.isArray(spec.anatomy)) {
    for (const part of spec.anatomy) {
      if (typeof part === "string" && part.trim().length >= 2) tokens.add(part.trim().toLowerCase())
    }
  }
  for (const value of [...CVA_VARIANTS, ...CVA_SIZES]) tokens.add(value.toLowerCase())
  tokens.delete("")
  const result = new Set<string>()
  for (const token of tokens) if (token.length >= 2) result.add(token)
  return result
}

/**
 * True when `code` references the spec (not just length + markers). Web
 * snippets must contain a spec token; tui snippets additionally accept TUI
 * lowering vocabulary (focus/border/region/...) since the button tui carries
 * `focused ... inverted border` instead of a literal `button` token.
 */
const snippetHasSemanticLink = (code: unknown, spec: Record<string, unknown>, isTui = false): boolean => {
  if (typeof code !== "string") return false
  const lower = code.toLowerCase()
  for (const token of specSemanticTokens(spec)) if (token && lower.includes(token)) return true
  if (isTui) for (const vocab of TUI_SNIPPET_VOCAB) if (lower.includes(vocab)) return true
  return false
}

// ---------------------------------------------------------------------------
// validate_spec (d66328c:runner/queereye/specs.py)
// ---------------------------------------------------------------------------

/**
 * Validate one spec object. Returns a list of error strings (empty = valid).
 *
 * Completeness gate: a spec missing variants/slots/a11y (keyboard+focus) or a
 * snippet FAILs — every section is required, never advisory.
 */
export function validateSpec(spec: unknown): string[] {
  const errors: string[] = []
  const name = isRecord(spec) ? ("name" in spec ? spec.name : "<unnamed>") : "<unnamed>"
  if (!isRecord(spec)) return ["spec must be an object"]
  for (const key of REQUIRED_SPEC_KEYS) {
    if (!(key in spec)) errors.push(err(name, `missing required section ${pyRepr(key)}`))
  }
  if (errors.length) return errors

  // -- anatomy ---------------------------------------------------------
  const anatomy = spec.anatomy
  if (!Array.isArray(anatomy) || anatomy.length === 0) {
    errors.push(err(name, "anatomy must be a non-empty list of part names"))
  } else {
    // Type-guard first: reject non-string entries with a structured error
    // (a dict entry must not raise TypeError from set()).
    for (const part of anatomy) {
      if (typeof part !== "string") {
        errors.push(err(name, `anatomy part ${pyRepr(part)} must be a string (non-string entry refused)`))
      } else if (isBlank(part)) {
        errors.push(err(name, "anatomy part names must be stripped non-empty"))
        break
      }
    }
    // Uniqueness with hashability guard (unhashable -> structured error).
    const hashable = anatomy.every((part) => part === null || typeof part !== "object")
    if (hashable) {
      if (new Set(anatomy).size !== anatomy.length) errors.push(err(name, "anatomy part names must be unique"))
    } else {
      errors.push(err(name, "anatomy part names must be hashable strings (unhashable entry refused)"))
    }
    // Full-anatomy enforcement per component. Unknown names no longer skip
    // enforcement (`_expected is None` is refused) [VERIFIED: 0785dc45].
    const normalizedName = typeof name === "string" ? stripHardened(name) : name
    let expected: readonly string[] | null = null
    let label = ""
    if (normalizedName === "dialog") {
      expected = DIALOG_ANATOMY
      label = "DIALOG_ANATOMY"
    } else if (normalizedName === "button") {
      expected = BUTTON_ANATOMY
      label = "BUTTON_ANATOMY"
    } else if (normalizedName === "form-input") {
      expected = INPUT_ANATOMY
      label = "INPUT_ANATOMY"
    } else if (normalizedName === "table") {
      expected = TABLE_ANATOMY
      label = "TABLE_ANATOMY"
    } else if (normalizedName === "nav") {
      expected = NAV_ANATOMY
      label = "NAV_ANATOMY"
    } else if (normalizedName === "toast") {
      expected = TOAST_ANATOMY
      label = "TOAST_ANATOMY"
    } else {
      errors.push(
        err(
          name,
          `unknown spec name ${pyRepr(name)} (must be one of ${pyList(KNOWN_SPEC_NAMES_SORTED)}; anatomy skip refused) ` +
            "[VERIFIED: 0785dc45]",
        ),
      )
    }
    if (expected !== null) {
      const missingParts = expected.filter((part) => !anatomy.includes(part))
      if (missingParts.length) {
        errors.push(
          err(
            name,
            `${pyStr(name)} anatomy must include full ${label} ${pyList(expected)}; missing ${pyList(missingParts)} [VERIFIED: 0785dc45]`,
          ),
        )
      }
      // Smuggled extras (e.g. ["Root", ..., "X"]) refused: every string part
      // must belong to the expected set.
      const unknownParts = anatomy.filter((part) => typeof part === "string" && !expected.includes(part))
      if (unknownParts.length) {
        errors.push(
          err(
            name,
            `${pyStr(name)} anatomy has unknown part ${pyList(unknownParts)} (must be a member of the expected anatomy) [VERIFIED: 0785dc45]`,
          ),
        )
      }
    }
  }

  // -- props ------------------------------------------------------------
  const props = spec.props
  if (!isRecord(props) || Object.keys(props).length === 0) {
    errors.push(err(name, "props must be a non-empty object"))
  } else {
    for (const [prop, declUnknown] of Object.entries(props)) {
      if (!isRecord(declUnknown) || isBlank(declUnknown.type)) {
        errors.push(err(name, `prop ${pyRepr(prop)} must declare a non-empty 'type'`))
        continue
      }
      const decl = declUnknown
      if ("values" in decl) {
        const values = decl.values
        if (!Array.isArray(values) || values.length === 0) {
          errors.push(err(name, `prop ${pyRepr(prop)} 'values' must be a non-empty list`))
        } else {
          for (const value of values) {
            if (isBlank(value)) {
              errors.push(err(name, `prop ${pyRepr(prop)} 'values' entries must be stripped non-empty`))
              break
            }
          }
          // Props cva smuggle refused: variant/size prop values must be a
          // subset of the cva axes even when the variants axis itself is
          // intact [VERIFIED: c24a9c9c]. Prop-name match is case-insensitive.
          const propLower = typeof prop === "string" ? prop.toLowerCase() : prop
          if (propLower === "variant") {
            const unknownProp = values.filter((value) => !CVA_VARIANTS.includes(value as string))
            if (unknownProp.length) {
              errors.push(
                err(
                  name,
                  `prop ${pyRepr(prop)} values ${pyList(unknownProp)} not in cva variant axis (smuggle refused) [VERIFIED: c24a9c9c]`,
                ),
              )
            }
          } else if (propLower === "size") {
            const unknownProp = values.filter((value) => !CVA_SIZES.includes(value as string))
            if (unknownProp.length) {
              errors.push(
                err(
                  name,
                  `prop ${pyRepr(prop)} values ${pyList(unknownProp)} not in cva size axis (smuggle refused) [VERIFIED: c24a9c9c]`,
                ),
              )
            }
          }
          if ((propLower === "variant" || propLower === "size") && "default" in decl) {
            const defaultVal = decl.default
            if (typeof defaultVal === "string" && !values.includes(defaultVal)) {
              errors.push(
                err(
                  name,
                  `prop ${pyRepr(prop)} default ${pyRepr(defaultVal)} not in cva axis values [VERIFIED: c24a9c9c]`,
                ),
              )
            }
          }
        }
      }
      // Non-string defaults refused (structured error): string/enum props need
      // str, boolean props need strict bool, numbers need int/float;
      // dict/list/None never valid.
      if ("default" in decl) {
        const defaultValue = decl.default
        const declType = decl.type
        if (declType === "string" || declType === "enum") {
          if (typeof defaultValue !== "string") {
            errors.push(
              err(
                name,
                `prop ${pyRepr(prop)} default ${pyRepr(defaultValue)} must be a string (non-string default refused)`,
              ),
            )
          }
        } else if (declType === "boolean") {
          if (typeof defaultValue !== "boolean") {
            errors.push(
              err(
                name,
                `prop ${pyRepr(prop)} default ${pyRepr(defaultValue)} must be a boolean (non-boolean default refused)`,
              ),
            )
          }
        } else if (declType === "number" || declType === "integer") {
          if (typeof defaultValue !== "number") {
            errors.push(
              err(
                name,
                `prop ${pyRepr(prop)} default ${pyRepr(defaultValue)} must be a number (non-number default refused)`,
              ),
            )
          }
        } else {
          const primitive =
            typeof defaultValue === "string" || typeof defaultValue === "boolean" || typeof defaultValue === "number"
          if (!primitive) {
            errors.push(
              err(
                name,
                `prop ${pyRepr(prop)} default ${pyRepr(defaultValue)} must be a string/boolean/number (non-string default refused)`,
              ),
            )
          }
        }
      }
    }
  }

  // -- variants: cva matrix ---------------------------------------------
  const variants = spec.variants
  if (!isRecord(variants)) {
    errors.push(err(name, "variants must be an object with variant/size axes"))
  } else {
    for (const [axis, expected] of [
      ["variant", CVA_VARIANTS],
      ["size", CVA_SIZES],
    ] as const) {
      const values = variants[axis]
      if (!Array.isArray(values) || values.length === 0) {
        errors.push(err(name, `variants.${axis} must be a non-empty list`))
      } else {
        for (const value of values) {
          if (isBlank(value)) {
            errors.push(err(name, `variants.${axis} entries must be stripped non-empty`))
            break
          }
        }
        const missing = expected.filter((value) => !values.includes(value))
        if (missing.length) {
          errors.push(err(name, `variants.${axis} missing cva entries ${pyList(missing)} [VERIFIED: c24a9c9c]`))
        }
        // Evil smuggled values ("evil") must FAIL: every entry must be a
        // member of the cva axis [VERIFIED: c24a9c9c].
        const unknown = values.filter((value) => !expected.includes(value as string))
        if (unknown.length) {
          errors.push(
            err(
              name,
              `variants.${axis} has unknown cva entry ${pyList(unknown)} (must be a member of the cva axis) [VERIFIED: c24a9c9c]`,
            ),
          )
        }
      }
    }
    if (!("default" in variants)) {
      errors.push(err(name, "variants must declare a 'default' selection"))
    } else {
      const defaultSel = variants.default
      if (!isRecord(defaultSel)) {
        errors.push(err(name, "variants.default must be an object"))
      } else {
        for (const [axis, expected] of [
          ["variant", CVA_VARIANTS],
          ["size", CVA_SIZES],
        ] as const) {
          if (axis in defaultSel && !expected.includes(defaultSel[axis] as string)) {
            errors.push(
              err(name, `variants.default.${axis} ${pyRepr(defaultSel[axis])} not in cva axis [VERIFIED: c24a9c9c]`),
            )
          }
        }
      }
    }
  }

  // -- slots --------------------------------------------------------------
  const slots = spec.slots
  if (!isRecord(slots) || Object.keys(slots).length === 0) {
    errors.push(err(name, "slots must be a non-empty object"))
  } else {
    for (const [slot, declUnknown] of Object.entries(slots)) {
      if (typeof slot !== "string" || isBlank(slot)) {
        errors.push(err(name, `slot name ${pyRepr(slot)} must be a stripped non-empty string (blank slot refused)`))
      }
      if (!isRecord(declUnknown) || isBlank(declUnknown.description)) {
        errors.push(err(name, `slot ${pyRepr(slot)} must carry a stripped non-empty 'description'`))
      }
    }
  }

  // -- keyboard (a11y) ------------------------------------------------------
  const keyboard = spec.keyboard
  if (!Array.isArray(keyboard) || keyboard.length === 0) {
    errors.push(err(name, "keyboard table must be non-empty (a11y required)"))
  } else {
    for (const [i, row] of keyboard.entries()) {
      if (!isRecord(row) || isBlank(row.keys) || isBlank(row.action)) {
        errors.push(err(name, `keyboard row ${i} must carry stripped non-empty 'keys' + 'action'`))
      }
    }
  }

  // -- focus / scroll re-specified per target -------------------------------
  for (const section of ["focus", "scroll"] as const) {
    const node = spec[section]
    if (!isRecord(node)) {
      errors.push(err(name, `${section} must be an object`))
    } else {
      for (const target of ["web", "tui"] as const) {
        const value = node[target]
        if (isBlank(value)) {
          errors.push(err(name, `${section} must re-specify per target (${pyRepr(target)})`))
        } else {
          const stripped = stripHardened(value as string)
          if (stripped.length < MIN_RESPEC_LEN) {
            errors.push(err(name, `${section}.${target} must be >= ${MIN_RESPEC_LEN} chars (prose-wave refused)`))
          }
          if (hasPlaceholder(value)) {
            errors.push(err(name, `${section}.${target} contains placeholder ('todo'/'tbd' refused)`))
          }
          // Prose/entropy bar for every re-spec: keyword + repeat
          // (`scroll + x*100`) passes length + substring, so require real
          // prose (words + varied alphabet, no 10-run).
          if (typeof value === "string" && stripHardened(value)) {
            if (isLowEntropy(value)) {
              errors.push(
                err(
                  name,
                  `${section}.${target} low-entropy/repetition refused (keyword + gibberish refused; needs varied prose, no 10-char repeat run)`,
                ),
              )
            } else if (!meetsProseBar(value)) {
              errors.push(
                err(
                  name,
                  `${section}.${target} must carry prose (>=4 words, >=3 distinct; keyword + gibberish refused)`,
                ),
              )
            }
          }
        }
      }
      // Keyboard-first/event-loop inversion must be documented in focus.tui,
      // not prose-waved [VERIFIED: 0785dc45].
      if (section === "focus") {
        const tuiValue = node.tui
        if (typeof tuiValue === "string" && stripHardened(tuiValue)) {
          const lowered = stripHardened(tuiValue).toLowerCase()
          if (!FOCUS_TUI_KEYWORDS.some((keyword) => lowered.includes(keyword))) {
            errors.push(
              err(
                name,
                "focus.tui must document the keyboard-first/event-loop inversion (needs one of " +
                  `${pyList(FOCUS_TUI_KEYWORDS)}) [VERIFIED: 0785dc45]`,
              ),
            )
          }
        }
      }
      // Scroll must carry layout/scroll meaning: both web and tui require
      // scroll/layout keywords PLUS prose (gibberish "x"*20 / "y"*20 passes
      // length-only).
      if (section === "scroll") {
        for (const target of ["web", "tui"] as const) {
          const value = node[target]
          if (typeof value === "string" && stripHardened(value)) {
            const lowered = stripHardened(value).toLowerCase()
            const hits = distinctKeywordHits(lowered, SCROLL_KEYWORDS)
            if (hits === 0) {
              errors.push(
                err(
                  name,
                  `scroll.${target} must name scroll/layout semantics (needs one of ${pyList(SCROLL_KEYWORDS)}; gibberish refused)`,
                ),
              )
            } else if (hits < 2) {
              errors.push(
                err(
                  name,
                  `scroll.${target} needs >=2 distinct scroll/layout keywords (got ${hits}; single-keyword + repeat refused; gibberish refused)`,
                ),
              )
            }
          }
        }
      }
    }
  }

  // -- usage do/don't ---------------------------------------------------------
  const usage = spec.usage
  if (!isRecord(usage)) {
    errors.push(err(name, "usage must be an object"))
  } else {
    for (const key of ["do", "dont"] as const) {
      const items = usage[key]
      if (!Array.isArray(items) || items.length === 0) {
        errors.push(err(name, `usage.${key} must be a non-empty list`))
      } else {
        for (const [i, item] of items.entries()) {
          if (isBlank(item)) errors.push(err(name, `usage.${key}[${i}] must be a stripped non-empty string`))
        }
      }
    }
  }

  // -- states ---------------------------------------------------------------
  const states = spec.states
  if (!isRecord(states)) {
    errors.push(err(name, "states must be an object"))
  } else {
    for (const state of REQUIRED_STATES) {
      if (isBlank(states[state])) {
        errors.push(
          err(
            name,
            `states must address ${pyRepr(state)} with a stripped non-empty string (loading/empty/error/disabled)`,
          ),
        )
      }
    }
  }

  // -- snippets (paired web + tui) --------------------------------------------
  const snippets = spec.snippets
  if (!isRecord(snippets)) {
    errors.push(err(name, "snippets must be an object"))
  } else {
    for (const target of ["web", "tui"] as const) {
      const code = snippets[target]
      if (typeof code !== "string" || isBlank(code)) {
        errors.push(err(name, `snippets.${target} must be a non-empty code string`))
      } else {
        const stripped = stripHardened(code)
        if (stripped.length < MIN_SNIPPET_LEN) {
          errors.push(
            err(
              name,
              `snippets.${target} too short (<${MIN_SNIPPET_LEN} chars; snippet-quality refused) [VERIFIED: 60c8c31d]`,
            ),
          )
        } else if (isLowEntropy(code)) {
          errors.push(
            err(
              name,
              `snippets.${target} low-entropy/repetition refused (pure repetition x*20/y*20 refused; needs varied code, no 10-char repeat run) [VERIFIED: 60c8c31d]`,
            ),
          )
        } else if (!snippetHasSemanticLink(code, spec, target === "tui")) {
          errors.push(
            err(
              name,
              `snippets.${target} must reference the component (name/variant/slot/anatomy${target === "tui" ? "/TUI vocab" : ""}; ` +
                "length + markers alone refused, gibberish refused) [VERIFIED: 60c8c31d]",
            ),
          )
        }
      }
    }
  }

  // -- csf interchange ----------------------------------------------------------
  const csf = spec.csf
  if (!isRecord(csf) || isBlank(csf.component)) {
    errors.push(err(name, "csf.component field required for autodocs [VERIFIED: 60c8c31d]"))
  }

  // -- tui_rows -------------------------------------------------------------------
  const tuiRows = spec.tui_rows
  if (!Array.isArray(tuiRows) || tuiRows.length === 0) {
    errors.push(err(name, "tui_rows must be non-empty (every state lowered)"))
  } else {
    for (const [i, row] of tuiRows.entries()) {
      if (!isRecord(row) || isBlank(row.state) || isBlank(row.web) || isBlank(row.tui)) {
        errors.push(err(name, `tui_rows[${i}] must carry stripped non-empty 'state' + 'web' + 'tui'`))
      }
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// Exemplar specs (d66328c:runner/queereye/specs.py)
// ---------------------------------------------------------------------------

const BUTTON_KEYBOARD: readonly KeyboardRow[] = [
  { keys: "Tab / Shift+Tab", action: "Move focus to / from the button" },
  { keys: "Enter / Space", action: "Activate the button (click)" },
  { keys: "Escape", action: "No-op while focused (no menu to dismiss)" },
]

const DIALOG_KEYBOARD: readonly KeyboardRow[] = [
  { keys: "Tab / Shift+Tab", action: "Cycle focus within the modal content" },
  { keys: "Escape", action: "Close the dialog and restore focus to Trigger" },
  { keys: "Enter", action: "Activate the focused control inside Content" },
]

const INPUT_KEYBOARD: readonly KeyboardRow[] = [
  { keys: "Tab / Shift+Tab", action: "Move focus into / out of the field" },
  { keys: "Printable keys", action: "Insert text at the caret" },
  { keys: "Escape", action: "TUI: clear-and-blur per lowering; web: blur only" },
  { keys: "Enter", action: "Submit the enclosing form (when present)" },
]

const buttonSpec = (): ComponentSpec => ({
  name: "button",
  anatomy: [...BUTTON_ANATOMY],
  props: {
    variant: { type: "enum", values: [...CVA_VARIANTS], default: "default" },
    size: { type: "enum", values: [...CVA_SIZES], default: "default" },
    disabled: { type: "boolean", default: false },
    loading: { type: "boolean", default: false },
    label: { type: "string", default: "" },
  },
  variants: {
    variant: [...CVA_VARIANTS],
    size: [...CVA_SIZES],
    default: { variant: "default", size: "default" },
  },
  slots: {
    label: { description: "Visible text (required unless icon-only with aria-label)." },
    icon: { description: "Optional leading/trailing glyph; hidden while loading." },
    spinner: { description: "Loading indicator; replaces icon when loading." },
  },
  keyboard: BUTTON_KEYBOARD.map((row) => ({ ...row })),
  focus: {
    web: "Visible focus ring on :focus-visible; pointer hover never replaces focus.",
    tui: "Selected row/button drawn with inverted border; focus follows the explicit focus list (keyboard-first).",
  },
  scroll: {
    web: "Button never scrolls content; sticky footers keep it in view.",
    tui: "Button pinned to the region footer; region scrolls under it.",
  },
  usage: {
    do: [
      "Use variant=default for the primary action, ghost/link for tertiary.",
      "Render <a> with buttonVariants for navigation instead of role-breaking Button-as-link.",
    ],
    dont: [
      "Do not disable without an adjacent reason (error/hint text).",
      "Do not use motion-only feedback; pair with a label change.",
    ],
  },
  states: {
    loading: "Spinner replaces icon; label unchanged; activation ignored.",
    empty: "Icon-only buttons require aria-label; label slot empty is an error.",
    error: "Destructive variant; error text adjacent, never color-only.",
    disabled: "aria-disabled + no activation; contrast of label still gated.",
  },
  snippets: {
    web: '<button class="btn" data-variant="default" data-size="default">Save</button>',
    tui: "[ Save ]  (focused: >[ Save ]< with inverted border)",
  },
  csf: { component: "Button", title: "Queereye/Button" },
  tui_rows: [
    { state: "hover", web: "pointer hover tint", tui: "focus-visible border (no pointer)" },
    { state: "focus", web: ":focus-visible ring", tui: "inverted border on focused row" },
    {
      state: "focus-trap",
      web: "n/a single control (no trap)",
      tui: "focus list includes button row (no trap needed)",
    },
    { state: "esc-close", web: "Esc is a no-op (no menu to dismiss)", tui: "Esc is a no-op (event-loop keeps focus)" },
    { state: "pointer-outside", web: "n/a (no overlay)", tui: "n/a (no overlay; Tab moves on)" },
    {
      state: "sr-announcement",
      web: "label exposed as accessible name",
      tui: "label text drawn adjacent (plain-text name)",
    },
    { state: "motion", web: "150ms press scale", tui: "instant + reduced-motion variant" },
    { state: "blur", web: "soft shadow blur", tui: "single-line border (no blur)" },
    { state: "loading", web: "spinner + label", tui: "spinner glyph + label (no animation)" },
    {
      state: "empty",
      web: "icon-only empty label with aria-label",
      tui: "empty text + aria-label row (no icon-only gap)",
    },
    {
      state: "error",
      web: "destructive ring + adjacent error text",
      tui: "error line printed below button (no color-only)",
    },
    { state: "disabled", web: "dimmed + no pointer", tui: "dimmed + skipped in focus order" },
  ],
})

const dialogSpec = (): ComponentSpec => ({
  name: "dialog",
  anatomy: [...DIALOG_ANATOMY],
  props: {
    open: { type: "boolean", default: false },
    modal: { type: "boolean", default: true },
    variant: { type: "enum", values: [...CVA_VARIANTS], default: "default" },
    size: { type: "enum", values: [...CVA_SIZES], default: "default" },
    title: { type: "string", default: "" },
  },
  variants: {
    variant: [...CVA_VARIANTS],
    size: [...CVA_SIZES],
    default: { variant: "default", size: "default" },
  },
  slots: {
    trigger: { description: "Element that opens the dialog; focus returns here on close." },
    overlay: { description: "Modal scrim; pointer-outside dismiss on web." },
    content: { description: "Dialog panel; focus trapped here while open (web)." },
    title: { description: "Accessible name; announced on open." },
    description: { description: "Optional supporting text; announced with title." },
    close: { description: "Explicit dismiss control; always rendered." },
  },
  keyboard: DIALOG_KEYBOARD.map((row) => ({ ...row })),
  focus: {
    web: "Focus trapped within modal; Esc closes; focus restored to Trigger.",
    tui: "Focus list pinned to dialog region; Esc/q closes; focus restored to trigger row (no OS trap).",
  },
  scroll: {
    web: "Body scroll locked while modal open; Content scrolls internally.",
    tui: "Background region frozen; dialog region scrolls; no scroll-lock API needed.",
  },
  usage: {
    do: [
      "Always render Title + Close; Title names the dialog for SR.",
      "Return focus to Trigger on close on both targets.",
    ],
    dont: [
      "Do not nest modal dialogs; stack is a single explicit region.",
      "Do not rely on pointer-outside alone; always offer Close.",
    ],
  },
  states: {
    loading: "Content shows skeleton rows; Close stays enabled.",
    empty: "Title + empty-copy + single action; never a bare overlay.",
    error: "Error block inside Content; focus moved to Error on open.",
    disabled: "Trigger disabled explains why; open dialog never disables Close.",
  },
  snippets: {
    web:
      "<div data-dialog-root><button data-dialog-trigger>Open</button><div data-dialog-overlay></div>" +
      "<div data-dialog-content><h2 data-dialog-title>Title</h2><button data-dialog-close>Close</button></div></div>",
    tui: "+--[ Title ]------+\n| region content  |\n| [ Close ]       |\n+-----------------+",
  },
  csf: { component: "Dialog", title: "Queereye/Dialog" },
  tui_rows: [
    { state: "hover", web: "pointer hover tint on Trigger/Close", tui: "focus-visible border (no pointer)" },
    {
      state: "focus",
      web: ":focus-visible ring inside Content",
      tui: "inverted border on focused row (keyboard-first)",
    },
    { state: "focus-trap", web: "OS-level focus trapped within modal", tui: "explicit focus list pinned to region" },
    { state: "esc-close", web: "Esc closes automatically", tui: "Esc/q keybinding closes (event-loop)" },
    { state: "pointer-outside", web: "outside pointer event dismisses", tui: "explicit Close key (no pointer)" },
    { state: "sr-announcement", web: "Title/Description announced by SR", tui: "status-line text set on open" },
    { state: "blur", web: "overlay backdrop blur", tui: "border (no blur)" },
    { state: "motion", web: "overlay fade 150ms", tui: "instant + reduced-motion variant" },
    { state: "loading", web: "skeleton rows in Content", tui: "static skeleton rows as text (no shimmer)" },
    {
      state: "empty",
      web: "Title + empty-copy + single action",
      tui: "empty text + single action row (no bare overlay)",
    },
    { state: "error", web: "error block in Content with SR text", tui: "error text row + focus list moves to error" },
    {
      state: "disabled",
      web: "Trigger dimmed; open dialog keeps Close enabled",
      tui: "trigger row dimmed + skipped; Close stays in focus list",
    },
  ],
})

const inputSpec = (): ComponentSpec => ({
  name: "form-input",
  anatomy: [...INPUT_ANATOMY],
  props: {
    variant: { type: "enum", values: [...CVA_VARIANTS], default: "outline" },
    size: { type: "enum", values: [...CVA_SIZES], default: "default" },
    value: { type: "string", default: "" },
    placeholder: { type: "string", default: "" },
    invalid: { type: "boolean", default: false },
    disabled: { type: "boolean", default: false },
  },
  variants: {
    variant: [...CVA_VARIANTS],
    size: [...CVA_SIZES],
    default: { variant: "outline", size: "default" },
  },
  slots: {
    label: { description: "Associated label; always rendered (never placeholder-only)." },
    field: { description: "Text entry box; caret + value." },
    hint: { description: "Helper text; replaced by Error when invalid." },
    error: { description: "Validation message; linked via aria-describedby." },
  },
  keyboard: INPUT_KEYBOARD.map((row) => ({ ...row })),
  focus: {
    web: "Caret in Field; :focus-visible ring; error announced via aria-describedby.",
    tui: "Field row focused with inverted border; error line printed below (no SR); keyboard-first: field in explicit focus list, event-loop drives caret.",
  },
  scroll: {
    web: "Field scrolls horizontally for overflow; page scroll unaffected.",
    tui: "Field clips to region width with horizontal scroll keys (Left/Right).",
  },
  usage: {
    do: ["Always pair Field with a visible Label.", "Surface errors as text in the Error slot, never color-only."],
    dont: ["Do not use placeholder as the label.", "Do not clear user input on blur without confirmation."],
  },
  states: {
    loading: "Field readonly with hint 'Loading…'; value preserved.",
    empty: "Placeholder shown; Label still visible; no error.",
    error: "Error slot filled; invalid ring; focus stays in Field.",
    disabled: "Field readonly + dimmed; value preserved; skipped in Tab order.",
  },
  snippets: {
    web: '<label>Name<input data-input-field placeholder="Ada" /></label><p data-input-hint>First name</p>',
    tui: "Name: [Ada______]  (focused: >Name: [Ada______]<)\n      hint: First name",
  },
  csf: { component: "FormInput", title: "Queereye/FormInput" },
  tui_rows: [
    { state: "hover", web: "pointer hover border tint", tui: "focus-visible border (no pointer)" },
    { state: "focus", web: ":focus-visible ring + caret", tui: "inverted border + block caret" },
    { state: "focus-trap", web: "n/a single field (no trap)", tui: "field stays in form focus list (no trap)" },
    { state: "esc-close", web: "blur only (no dismiss)", tui: "clear-and-blur keybinding (event-loop)" },
    { state: "pointer-outside", web: "n/a (no overlay)", tui: "n/a (no overlay; Tab moves on)" },
    { state: "motion", web: "caret blink + 150ms ring fade", tui: "static caret + reduced-motion variant" },
    { state: "blur", web: "soft outer glow", tui: "single-line border (no blur)" },
    { state: "sr-announcement", web: "error announced via aria-describedby", tui: "error line printed below field" },
    { state: "loading", web: "skeleton shimmer", tui: "static 'Loading…' hint (no shimmer)" },
    { state: "empty", web: "placeholder + visible Label (no error)", tui: "placeholder text row + Label (no error)" },
    { state: "error", web: "invalid ring + SR error text", tui: "error line printed below field (no color-only)" },
    {
      state: "disabled",
      web: "dimmed + readonly + removed from Tab order",
      tui: "dimmed + readonly + skipped in focus list",
    },
  ],
})

// Phase-02 additions: table, nav and toast authored in the same template
// shape as the d66328c exemplars (full props/variants/slots, real
// keyboard/focus behavior, web + tui snippets, CSF component, the four
// required states, responsive/scroll notes and a full tui_rows lowering).

const tableSpec = (): ComponentSpec => ({
  name: "table",
  anatomy: [...TABLE_ANATOMY],
  props: {
    variant: { type: "enum", values: [...CVA_VARIANTS], default: "default" },
    size: { type: "enum", values: [...CVA_SIZES], default: "default" },
    striped: { type: "boolean", default: false },
    caption: { type: "string", default: "" },
    emptyLabel: { type: "string", default: "No rows" },
  },
  variants: {
    variant: [...CVA_VARIANTS],
    size: [...CVA_SIZES],
    default: { variant: "default", size: "default" },
  },
  slots: {
    caption: { description: "Table name; announced before the header row." },
    header: { description: "Column headers; sortable ones are buttons." },
    row: { description: "Data row; carries the row key for focus restore." },
    cell: { description: "Data cell; text or a single interactive control." },
    empty: { description: "Empty-state row spanning all columns." },
  },
  keyboard: [
    { keys: "Tab / Shift+Tab", action: "Move focus between sortable headers and cell controls" },
    { keys: "ArrowUp / ArrowDown", action: "Move the row cursor when the table region is focused" },
    { keys: "Enter / Space", action: "Activate the focused header sort or row action" },
    { keys: "Escape", action: "Clear the row cursor and return focus to the table root" },
  ],
  focus: {
    web: "Roving tabindex lands on the first interactive cell; :focus-visible ring marks the current row.",
    tui: "Table rows join the keyboard-first focus list; the event-loop drives the cell cursor with an inverted border.",
  },
  scroll: {
    web: "Header stays sticky while body rows scroll inside the region; horizontal overflow never moves the page.",
    tui: "Table region clips vertical overflow; the pinned Header row stays frozen during scroll.",
  },
  usage: {
    do: [
      "Keep the caption visible; name every column header in text.",
      "Sort slices by the active header and keep the direction in the caption.",
    ],
    dont: [
      "Do not trap arrow keys; unused arrows should move the page scroll.",
      "Do not signal row state with color alone.",
    ],
  },
  states: {
    loading: "Skeleton rows render inside Body; the Caption and Header stay visible.",
    empty: "Caption plus a single empty-state row spanning the Body; never a header-only table.",
    error: "Error row text replaces Body rows; the Header stays readable.",
    disabled: "Rows dim and leave the focus list; any active row cursor clears.",
  },
  snippets: {
    web: "<table data-table-root><caption>Invoices</caption><tr data-table-row><td data-table-cell>INV-1</td></tr></table>",
    tui: "+-- Invoices ----+\n| row cell border |\n| >INV-1< focused |\n+-----------------+",
  },
  csf: { component: "Table", title: "Queereye/Table" },
  tui_rows: [
    { state: "hover", web: "pointer hover row tint", tui: "focus-visible border (no pointer)" },
    { state: "focus", web: ":focus-visible ring on the cell", tui: "inverted border on focused row" },
    { state: "focus-trap", web: "n/a single region (no trap)", tui: "table region joins the focus list (no trap)" },
    { state: "esc-close", web: "clears the active cell cursor", tui: "Esc clears the cursor (event-loop)" },
    { state: "pointer-outside", web: "n/a (no overlay)", tui: "n/a (no overlay; Tab moves on)" },
    { state: "sr-announcement", web: "caption + headers announced by SR", tui: "caption line drawn above the grid" },
    { state: "motion", web: "120ms row highlight fade", tui: "instant + reduced-motion variant" },
    { state: "blur", web: "soft row shadow blur", tui: "single-line border (no blur)" },
    { state: "loading", web: "skeleton rows in Body", tui: "static skeleton rows as text" },
    { state: "empty", web: "empty-state row spans the columns", tui: "empty row printed across the grid width" },
    { state: "error", web: "error row replaces Body text", tui: "error row + focus list moves to error" },
    { state: "disabled", web: "rows dimmed + no pointer", tui: "rows dimmed + skipped in focus order" },
  ],
})

const navSpec = (): ComponentSpec => ({
  name: "nav",
  anatomy: [...NAV_ANATOMY],
  props: {
    variant: { type: "enum", values: [...CVA_VARIANTS], default: "default" },
    size: { type: "enum", values: [...CVA_SIZES], default: "default" },
    orientation: { type: "enum", values: ["horizontal", "vertical"], default: "horizontal" },
    collapsed: { type: "boolean", default: false },
    label: { type: "string", default: "Main" },
  },
  variants: {
    variant: [...CVA_VARIANTS],
    size: [...CVA_SIZES],
    default: { variant: "default", size: "default" },
  },
  slots: {
    item: { description: "List item; one link plus an optional icon." },
    link: { description: "Navigation target; marks the current page." },
    icon: { description: "Optional glyph; decorative unless it is the only label." },
  },
  keyboard: [
    { keys: "Tab / Shift+Tab", action: "Move focus to / from the nav (a single tab stop)" },
    { keys: "ArrowLeft / ArrowRight", action: "Move focus along a horizontal nav" },
    { keys: "ArrowUp / ArrowDown", action: "Move focus along a vertical nav" },
    { keys: "Enter / Space", action: "Activate the focused link" },
    { keys: "Home / End", action: "Move focus to the first / last item" },
  ],
  focus: {
    web: "Roving tabindex keeps one link tabbable; :focus-visible ring marks the current item.",
    tui: "Nav items join the keyboard-first focus list; the event-loop handles arrow traversal and draws the focused row inverted.",
  },
  scroll: {
    web: "Nav region scrolls horizontally on narrow viewports; sticky positioning keeps the top level reachable.",
    tui: "Nav region clips horizontal overflow; the pinned footer row exposes a more-items probe.",
  },
  usage: {
    do: [
      "Render one nav per landmark; label it with aria-label or a visible heading.",
      "Mark the current page with aria-current, never color alone.",
    ],
    dont: ["Do not wrap long item lists in a focus trap.", "Do not nest another nav landmark inside an item."],
  },
  states: {
    loading: "Skeleton item rows render; the current item stays marked.",
    empty: "Empty text row renders inside List; Root keeps its label.",
    error: "Error row text replaces List; the nav landmark stays reachable.",
    disabled: "Items dim and leave the focus list; the landmark keeps one tab stop.",
  },
  snippets: {
    web:
      '<nav data-nav-root aria-label="Main"><ul data-nav-list><li data-nav-item>' +
      '<a data-nav-link aria-current="page">Home</a></li></ul></nav>',
    tui: "[ Home ]  (focused: >[ Docs ]< inverted border)\n  region footer: +3 more",
  },
  csf: { component: "Nav", title: "Queereye/Nav" },
  tui_rows: [
    { state: "hover", web: "pointer hover tint on the item", tui: "focus-visible border (no pointer)" },
    { state: "focus", web: ":focus-visible ring on the link", tui: "inverted border on focused row" },
    { state: "focus-trap", web: "n/a single landmark (no trap)", tui: "nav joins the focus list (no trap)" },
    { state: "esc-close", web: "clears the roving cursor", tui: "Esc parks the cursor (event-loop)" },
    { state: "pointer-outside", web: "n/a (no overlay)", tui: "n/a (no overlay; Tab moves on)" },
    {
      state: "sr-announcement",
      web: "landmark label + aria-current announced",
      tui: "current item marked in plain text",
    },
    { state: "motion", web: "120ms underline slide", tui: "instant + reduced-motion variant" },
    { state: "blur", web: "soft item shadow blur", tui: "single-line border (no blur)" },
    { state: "loading", web: "skeleton item rows", tui: "static skeleton rows as text" },
    { state: "empty", web: "empty text row inside List", tui: "empty row printed under the landmark" },
    { state: "error", web: "error row replaces List text", tui: "error row + focus list moves to error" },
    { state: "disabled", web: "items dimmed + no pointer", tui: "items dimmed + skipped in focus order" },
  ],
})

const toastSpec = (): ComponentSpec => ({
  name: "toast",
  anatomy: [...TOAST_ANATOMY],
  props: {
    variant: { type: "enum", values: [...CVA_VARIANTS], default: "default" },
    size: { type: "enum", values: [...CVA_SIZES], default: "default" },
    open: { type: "boolean", default: false },
    duration: { type: "number", default: 5000 },
    title: { type: "string", default: "" },
  },
  variants: {
    variant: [...CVA_VARIANTS],
    size: [...CVA_SIZES],
    default: { variant: "default", size: "default" },
  },
  slots: {
    title: { description: "Outcome text; announced as the status message." },
    description: { description: "Optional detail line under the title." },
    action: { description: "Optional single action (undo/retry)." },
    close: { description: "Explicit dismiss control; always rendered." },
  },
  keyboard: [
    { keys: "Tab / Shift+Tab", action: "Move focus into / out of the toast region" },
    { keys: "Escape", action: "Dismiss the focused toast and restore prior focus" },
    { keys: "Enter / Space", action: "Activate the focused toast action" },
    { keys: "F6", action: "Cycle between the toast viewport and the page (web)" },
  ],
  focus: {
    web: "Toast is announced without stealing focus; Escape dismisses and restores focus to the trigger.",
    tui: "Toast lands in the keyboard-first status row; the event-loop keeps it in the focus list until acknowledged.",
  },
  scroll: {
    web: "Toast viewport stacks messages; long stacks scroll inside the region and never lock the page.",
    tui: "Toast column clips to terminal height; overflow scrolls in the status region above the pinned footer.",
  },
  usage: {
    do: [
      "Keep copy short: the title names the outcome, the description adds detail.",
      "Offer one action at most; keep dismissal explicit.",
    ],
    dont: [
      "Do not use a toast for validation errors that need user input.",
      "Do not cover the focused control with the viewport.",
    ],
  },
  states: {
    loading: "Toast shows a status spinner row; the title text stays visible.",
    empty: "Empty toast renders the title only; never a silent blank viewport.",
    error: "Destructive variant; error text inside Description, never color-only.",
    disabled: "Toasts pause dismissal timers and keep an explicit Close control.",
  },
  snippets: {
    web:
      '<div data-toast-viewport><div data-toast-root role="status"><p data-toast-title>Saved</p>' +
      "<button data-toast-close>Dismiss</button></div></div>",
    tui: "[ status: Saved ]  (focused: >[ Dismiss ]< inverted border)",
  },
  csf: { component: "Toast", title: "Queereye/Toast" },
  tui_rows: [
    { state: "hover", web: "pointer hover tint on the toast", tui: "focus-visible border (no pointer)" },
    { state: "focus", web: ":focus-visible ring on Action/Close", tui: "inverted border on focused row" },
    { state: "focus-trap", web: "n/a polite region (no trap)", tui: "toast stays in the status focus list (no trap)" },
    { state: "esc-close", web: "Esc dismisses the focused toast", tui: "Esc/q dismisses the status row (event-loop)" },
    { state: "pointer-outside", web: "n/a (no overlay)", tui: "n/a (no overlay; Tab moves on)" },
    {
      state: "sr-announcement",
      web: "role=status text announced politely",
      tui: "status line drawn in the footer region",
    },
    { state: "motion", web: "180ms stack-in slide", tui: "instant + reduced-motion variant" },
    { state: "blur", web: "soft toast shadow blur", tui: "single-line border (no blur)" },
    { state: "loading", web: "spinner row + title", tui: "static status row (no animation)" },
    { state: "empty", web: "title-only toast; viewport stays visible", tui: "title row printed; no blank region" },
    { state: "error", web: "destructive text in Description + SR", tui: "error text row + focus list moves to action" },
    {
      state: "disabled",
      web: "timers paused; Close stays enabled",
      tui: "dismiss timer paused; Close stays in focus list",
    },
  ],
})

/** The six exemplar specs: the d66328c three plus the phase-02 table/nav/toast additions. */
export const EXEMPLARS = {
  button: buttonSpec(),
  dialog: dialogSpec(),
  "form-input": inputSpec(),
  table: tableSpec(),
  nav: navSpec(),
  toast: toastSpec(),
} satisfies Record<string, ComponentSpec>

/** Validate every exemplar (default all six). Returns `{name: errors}`. */
export function validateAll(specs: Record<string, ComponentSpec> = EXEMPLARS): Record<string, string[]> {
  const results: Record<string, string[]> = {}
  for (const [name, spec] of Object.entries(specs)) results[name] = validateSpec(spec)
  return results
}

/** `components/<name>.md` relative path inside `.queereye/`. */
export function specFilename(name: string): string {
  const safe = [...name]
    .map((char) => (/^[\p{L}\p{N}]$/u.test(char) || char === "-" || char === "_" ? char : "-"))
    .join("")
  return `components/${safe}.md`
}

// ---------------------------------------------------------------------------
// render_spec_md (d66328c:runner/queereye/specs.py)
// ---------------------------------------------------------------------------

/** Python `str()`-shape text for a scalar (booleans render True/False). */
const scalarText = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "True" : "False"
  return String(value)
}

/** Python f-string `decl.get('default', '')` shape. */
const formatDefault = (decl: Record<string, unknown>): string => {
  if (!("default" in decl)) return ""
  const value = decl.default
  if (value === undefined || value === null) return "None"
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "object") return pyRepr(value)
  return String(value)
}

/** Python `json.dumps(value, sort_keys=True)` shape (", " / ": " separators, sorted keys). */
const pyJson = (value: unknown): string => {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${pyJson((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(", ")}}`
  }
  return String(value)
}

/** Pure render of one spec to markdown (deterministic, sorted keys). */
export function renderSpecMd(spec: ComponentSpec): string {
  const lines: string[] = []
  const name = spec.name ?? "unknown"
  const csf = spec.csf ?? {}
  lines.push(`# Component — ${name}`)
  lines.push("")
  lines.push(
    "_Behavior-first contract (what, not how): unstyled primitives with " +
      "specified focus, keyboard, and screen-reader behavior " +
      "[VERIFIED: 28a04ca6]. Variant/size surface is prop-driven " +
      "[VERIFIED: dc656fd4] over the cva matrix " +
      "[VERIFIED: c24a9c9c]; states pair as CSF args data, not prose " +
      "[VERIFIED: 60c8c31d]._",
  )
  lines.push("")
  lines.push("## Anatomy")
  lines.push("")
  for (const part of spec.anatomy ?? []) lines.push(`- \`${part}\``)
  lines.push("")
  lines.push("## Props")
  lines.push("")
  lines.push("| prop | type | default | values |")
  lines.push("| --- | --- | --- | --- |")
  const props = spec.props ?? {}
  for (const prop of Object.keys(props).sort()) {
    const decl = props[prop]
    if (!decl) continue
    const record = decl as unknown as Record<string, unknown>
    const values = Array.isArray(decl.values) ? decl.values.map((value) => scalarText(value)).join(",") : ""
    lines.push(`| ${prop} | ${scalarText(decl.type)} | ${formatDefault(record)} | ${values} |`)
  }
  lines.push("")
  lines.push("## Variants x Size (cva matrix [VERIFIED: c24a9c9c])")
  lines.push("")
  const variants = spec.variants ?? { variant: [], size: [], default: {} }
  lines.push(`- variant: ${(variants.variant ?? []).join(", ")}`)
  lines.push(`- size: ${(variants.size ?? []).join(", ")}`)
  lines.push(`- default: \`${pyJson(variants.default ?? {})}\``)
  lines.push("")
  lines.push("## Slots")
  lines.push("")
  const slots = spec.slots ?? {}
  for (const slot of Object.keys(slots).sort()) {
    const decl = slots[slot]
    lines.push(`- \`${slot}\`: ${decl?.description ?? ""}`)
  }
  lines.push("")
  lines.push("## Keyboard")
  lines.push("")
  lines.push("| keys | action |")
  lines.push("| --- | --- |")
  for (const row of spec.keyboard ?? []) lines.push(`| ${row.keys ?? ""} | ${row.action ?? ""} |`)
  lines.push("")
  lines.push("## Focus / Scroll (per-target re-spec)")
  lines.push("")
  for (const section of ["focus", "scroll"] as const) {
    const node = spec[section] ?? { web: "", tui: "" }
    lines.push(`- ${section}.web: ${node.web ?? ""}`)
    lines.push(`- ${section}.tui: ${node.tui ?? ""}`)
  }
  lines.push("")
  lines.push("## Usage")
  lines.push("")
  lines.push("Do:")
  for (const item of spec.usage?.do ?? []) lines.push(`- ${item}`)
  lines.push("Don't:")
  for (const item of spec.usage?.dont ?? []) lines.push(`- ${item}`)
  lines.push("")
  lines.push("## States (loading / empty / error / disabled)")
  lines.push("")
  const states = spec.states ?? {}
  for (const state of Object.keys(states).sort()) lines.push(`- ${state}: ${states[state]}`)
  lines.push("")
  lines.push("## Snippets (paired)")
  lines.push("")
  const snippets = spec.snippets ?? { web: "", tui: "" }
  lines.push("```html (web)")
  lines.push(snippets.web ?? "")
  lines.push("```")
  lines.push("```text (tui)")
  lines.push(snippets.tui ?? "")
  lines.push("```")
  lines.push("")
  lines.push("## CSF interchange")
  lines.push("")
  lines.push(`- component: \`${scalarText(csf.component)}\` (required for autodocs [VERIFIED: 60c8c31d])`)
  lines.push(`- title: \`${scalarText(csf.title)}\``)
  lines.push("")
  lines.push("## TUI lowering (deterministic rows)")
  lines.push("")
  lines.push("| state | web | tui |")
  lines.push("| --- | --- | --- |")
  for (const row of spec.tui_rows ?? []) lines.push(`| ${row.state ?? ""} | ${row.web ?? ""} | ${row.tui ?? ""} |`)
  lines.push("")
  return lines.join("\n")
}
