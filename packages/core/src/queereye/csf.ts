// CSF interchange + headless play-function harness + spec-vs-render
// divergence gate (phase queereye-02, port of
// d66328c:runner/queereye/csf.py).
//
// - CSF is the proven open-standard shape for pairing a component with its
//   states as data (args) rather than prose [VERIFIED: 60c8c31d]: every story
//   carries a `component` field (required for autodocs prop-tables) plus
//   named args per state.
// - Play functions execute assertions against the rendered story without
//   user interaction [VERIFIED: 60c8c31d]: the harness below runs assertion
//   callables against rendered exemplars headlessly and reports a snippet
//   pass-rate.
// - The visual-regression pattern is rebuilt clean-room (hash-compare of
//   rendered bytes), never vendored.
// - The CI spec-vs-render check requires: slots filled, downgrade rows per
//   state, pinned-ref freshness.
//
// The canonical spec catalog (specs.ts) is the default linkage; an explicit
// `spec` / catalog argument overrides it so the harness stays usable with
// duck-typed data. Deterministic pure functions only: no file I/O, no
// network.

import { sha256 } from "../util/hash.ts"
import { EXEMPLARS } from "./specs.ts"
import { validateTuiCoverage } from "./tui.ts"

/** Zero-width set `String.prototype.trim` misses (ZWSP/WJ/BOM family). */
const ZERO_WIDTH_CHARS = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u200e", "\u200f", "\u00ad"]

/** Marker pattern for paired snippet linkage (web/tui markers are metadata,
 * never outer-tag bytes for the component assertion). */
const MARKER_RE = /<!--(?:web|tui):[\s\S]*?-->/g

// d66328c:runner/queereye/csf.py (_strip_hardened)
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

// d66328c:runner/queereye/csf.py (_strip_markers)
/** Remove `<!--web:...-->` / `<!--tui:...-->` markers from a frame. */
export function stripMarkers(frame: unknown): unknown {
  if (typeof frame !== "string") return frame
  return frame.replace(MARKER_RE, "")
}

/** Python `str()` for the scalar values a story can carry (an f-string
 * rendered `True`/`False`/`None` into the frame, and the port stays
 * byte-faithful). */
const pythonStr = (value: unknown): string => {
  if (value === null || value === undefined) return "None"
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  if (Array.isArray(value)) return `[${value.map(pythonStr).join(", ")}]`
  if (typeof value === "object") return JSON.stringify(value) ?? "None"
  return String(value)
}

/** Python-style `repr()` for a string in an error message. */
const repr = (value: string): string => `'${value}'`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// d66328c:runner/queereye/csf.py (CSF_REQUIRED_FIELDS)
/** CSF meta fields this harness understands. `component` is REQUIRED:
 * autodocs prop-tables generate from it [VERIFIED: 60c8c31d]. */
export const CSF_REQUIRED_FIELDS = ["component"] as const

// d66328c:runner/queereye/csf.py (CSF_OPTIONAL_FIELDS)
export const CSF_OPTIONAL_FIELDS = ["title", "args", "play"] as const

/** One exemplar story (states as data, not prose). */
export interface CsfStory {
  readonly id: string
  readonly component: string
  readonly args: Readonly<Record<string, unknown>>
}

// d66328c:runner/queereye/csf.py (EXEMPLAR_STORIES)
/** Story ids shipped per exemplar (states as data, not prose). */
export const EXEMPLAR_STORIES: Readonly<Record<string, readonly CsfStory[]>> = {
  button: [
    { id: "button--default", component: "Button", args: { variant: "default", size: "default", label: "Save" } },
    { id: "button--loading", component: "Button", args: { variant: "default", size: "default", loading: true } },
    { id: "button--destructive", component: "Button", args: { variant: "destructive", size: "sm", label: "Delete" } },
  ],
  dialog: [
    { id: "dialog--closed", component: "Dialog", args: { open: false } },
    { id: "dialog--open", component: "Dialog", args: { open: true, title: "Title" } },
  ],
  "form-input": [
    { id: "form-input--empty", component: "FormInput", args: { value: "" } },
    { id: "form-input--error", component: "FormInput", args: { value: "x", invalid: true } },
  ],
}

/** Loose spec shape: the phase-02 spec catalog is data, duck-typed. */
export type CsfSpec = object

/** Spec catalog keyed by spec name (mirrors the legacy `EXEMPLARS` map). */
export type SpecCatalog = Record<string, CsfSpec>

/** Default catalog: the canonical phase-02 exemplars (specs.ts). */
export const DEFAULT_SPEC_CATALOG: SpecCatalog = EXEMPLARS

/** All exemplar stories, flattened in group order. */
export function allExemplarStories(): CsfStory[] {
  return Object.values(EXEMPLAR_STORIES).flat()
}

/** Story label used in validation results (legacy `meta.get("id", ...)`). */
const storyLabel = (story: unknown): string =>
  isRecord(story) && story.id !== undefined ? pythonStr(story.id) : "<unnamed>"

// d66328c:runner/queereye/csf.py (validate_csf_meta)
/** Validate one CSF story meta. Returns error list (empty = valid). */
export function validateCsfMeta(meta: unknown): string[] {
  if (!isRecord(meta)) return ["csf story must be an object"]
  const label = storyLabel(meta)
  const errors: string[] = []
  // `component` is REQUIRED for autodocs [VERIFIED: 60c8c31d]: whitespace
  // "   " and zero-width-only must FAIL (hardened strip, not truthiness).
  for (const field of CSF_REQUIRED_FIELDS) {
    const value = meta[field]
    if (typeof value !== "string" || !hardenedString(value))
      errors.push(`csf ${label}: ${repr(field)} field required for autodocs [VERIFIED: 60c8c31d]`)
  }
  // Story `id` is REQUIRED: missing/blank/non-string FAILs (no
  // `if not None` exemption — missing id must not pass).
  const storyId = meta.id
  if (typeof storyId !== "string" || !hardenedString(storyId))
    errors.push(`csf ${label}: 'id' must be a stripped non-empty string`)
  if (Object.hasOwn(meta, "args") && !isRecord(meta.args))
    errors.push(`csf ${label}: args must be an object (states as data)`)
  return errors
}

// d66328c:runner/queereye/csf.py (validate_all_stories)
/** Validate every exemplar story. Returns `{id: errors}`. */
export function validateAllStories(stories?: readonly unknown[]): Record<string, string[]> {
  const list = stories ?? allExemplarStories()
  const results: Record<string, string[]> = {}
  for (const story of list) results[storyLabel(story)] = validateCsfMeta(story)
  return results
}

/** The linked spec's `csf.component`, stringified as legacy did. */
const specCsfComponent = (spec: unknown): string => {
  if (!isRecord(spec) || !isRecord(spec.csf)) return ""
  const component = spec.csf.component
  return component === undefined ? "" : pythonStr(component)
}

// d66328c:runner/queereye/csf.py (_find_spec_for_component)
/** Find the catalog spec whose `csf.component` names `component`.
 *
 * Lookup is exact on the `csf.component` field [VERIFIED: 60c8c31d], with a
 * stripped case-insensitive name fallback (`FormInput` <-> `form-input`).
 * The catalog defaults to the phase-02 exemplars and may be overridden with
 * duck-typed data.
 */
export function findSpecForComponent(component: unknown, catalog?: SpecCatalog): CsfSpec | undefined {
  const source = catalog ?? DEFAULT_SPEC_CATALOG
  const target = hardenedString(component === undefined || component === null ? "" : pythonStr(component))
  if (!target) return undefined
  for (const spec of Object.values(source)) {
    if (hardenedString(specCsfComponent(spec)) === target) return spec
  }
  const lowered = target.toLowerCase().replaceAll("-", "").replaceAll("_", "")
  for (const spec of Object.values(source)) {
    const csfComponent = specCsfComponent(spec)
    if (csfComponent.trim().toLowerCase().replaceAll("-", "").replaceAll("_", "") === lowered) return spec
    const specName = isRecord(spec) && spec.name !== undefined ? pythonStr(spec.name) : ""
    if (specName.trim().toLowerCase().replaceAll("-", "").replaceAll("_", "") === lowered) return spec
  }
  return undefined
}

// d66328c:runner/queereye/csf.py (render_story)
/** Headless render of one story to deterministic text (no user I/O).
 *
 * The renderer is intentionally tiny: it stringifies the component + sorted
 * args into a canonical frame. Play functions assert against this frame —
 * executing assertions against the rendered story without user interaction
 * [VERIFIED: 60c8c31d]. The paired spec snippets (web + tui) are linked into
 * the frame (as `<!--web:...-->` / `<!--tui:...-->` markers) so snippet
 * linkage is asserted, never prose-waved: a story whose component has no
 * spec, or whose spec has blank snippets, renders without markers and the
 * snippet assertion fails.
 */
export function renderStory(story: unknown, spec?: CsfSpec | null, catalog?: SpecCatalog): string {
  const record = isRecord(story) ? story : {}
  const componentValue = "component" in record ? record.component : "Unknown"
  const component = pythonStr(componentValue)
  const args = isRecord(record.args) ? record.args : {}
  const argS = Object.keys(args)
    .sort()
    .map((key) => `${key}="${pythonStr(args[key])}"`)
    .join(" ")
  const innerValue = "inner" in record ? record.inner : ""
  const inner = pythonStr(innerValue)
  let frame = `<${component} ${argS}>${inner}</${component}>`.trim()
  const linked = isRecord(spec) ? spec : findSpecForComponent(componentValue, catalog)
  if (isRecord(linked) && isRecord(linked.snippets)) {
    const snippets = linked.snippets
    const webSnippet = snippets.web
    const tuiSnippet = snippets.tui
    if (typeof webSnippet === "string" && hardenedString(webSnippet))
      frame += `<!--web:${hardenedString(webSnippet)}-->`
    if (typeof tuiSnippet === "string" && hardenedString(tuiSnippet)) {
      // Collapse newlines for a single-line deterministic frame.
      const tuiOneLine = hardenedString(tuiSnippet).split(/\s+/).join(" ")
      frame += `<!--tui:${tuiOneLine}-->`
    }
  }
  return frame
}

// d66328c:runner/queereye/specs.py (_REPEAT_RUN_RE, _is_low_entropy)
/** Repeat-run + low-entropy probe: any char repeated 10+ consecutively
 * (`x*20`) or a tiny alphabet dominating a long string is gibberish. The
 * clean-room copy keeps the play gate hard on injected catalogs, independent
 * of the spec-validation module's internals.
 */
const REPEAT_RUN_RE = /([A-Za-z0-9])\1{9,}/

/** True when `text` is repetition-dominated gibberish. */
export function isLowEntropy(text: unknown): boolean {
  if (typeof text !== "string" || !text) return true
  if (REPEAT_RUN_RE.test(text)) return true
  const alnum = text.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (!alnum) return true
  if (alnum.length >= 10 && new Set(alnum).size <= 2) return true
  if (alnum.length >= 20) {
    const counts = new Map<string, number>()
    for (const char of alnum) counts.set(char, (counts.get(char) ?? 0) + 1)
    let most = 0
    for (const count of counts.values()) if (count > most) most = count
    if (most / alnum.length > 0.5) return true
  }
  return false
}

/** cva variant/size axes [VERIFIED: c24a9c9c] (specs.py also carries them;
 * they count as snippet semantic tokens). */
const CVA_VARIANTS = ["default", "outline", "ghost", "destructive", "secondary", "link"]
const CVA_SIZES = ["default", "xs", "sm", "lg", "icon"]

/** TUI vocabulary accepted as a semantic link for `snippets.tui` only
 * (web snippets must reference the component/variant/slot itself). */
const TUI_SNIPPET_VOCAB = [
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

/** Lowercased tokens a snippet must reference (component/variant/slot). */
const specSemanticTokens = (spec: unknown): Set<string> => {
  const tokens = new Set<string>()
  const record = isRecord(spec) ? spec : {}
  const name = typeof record.name === "string" ? record.name : pythonStr(record.name ?? "")
  for (const part of name.split(/[^A-Za-z0-9]+/)) if (part.length >= 3) tokens.add(part.toLowerCase())
  const normalizedName = name.trim().toLowerCase().replaceAll("-", "").replaceAll("_", "")
  if (normalizedName.length >= 3) tokens.add(normalizedName)
  const component = specCsfComponent(record)
  for (const part of component.match(/[A-Za-z]{3,}/g) ?? []) tokens.add(part.toLowerCase())
  const normalizedComponent = component.trim().toLowerCase().replaceAll("-", "").replaceAll("_", "")
  if (normalizedComponent.length >= 3) tokens.add(normalizedComponent)
  if (isRecord(record.slots))
    for (const slot of Object.keys(record.slots)) if (slot.trim().length >= 2) tokens.add(slot.trim().toLowerCase())
  if (Array.isArray(record.anatomy))
    for (const part of record.anatomy)
      if (typeof part === "string" && part.trim().length >= 2) tokens.add(part.trim().toLowerCase())
  if (isRecord(record.variants))
    for (const value of Object.values(record.variants))
      if (Array.isArray(value)) for (const item of value) if (typeof item === "string") tokens.add(item.toLowerCase())
  for (const axisValue of [...CVA_VARIANTS, ...CVA_SIZES]) tokens.add(axisValue)
  return new Set([...tokens].filter((token) => token.length >= 2))
}

// d66328c:runner/queereye/specs.py (_snippet_has_semantic_link)
/** True when `code` references the spec (not just length + markers).
 *
 * Web snippets must contain a spec token (component name part, CSF component
 * part, slot, anatomy, or cva value). Tui snippets additionally accept TUI
 * lowering vocabulary (focus/border/region/...) since the button tui carries
 * `focused ... inverted border` instead of a literal `button` token. Pure
 * repetition (`x*20`) contains none and fails.
 */
export function snippetHasSemanticLink(code: unknown, spec: unknown, isTui = false): boolean {
  if (typeof code !== "string") return false
  const lower = code.toLowerCase()
  for (const token of specSemanticTokens(spec)) if (token && lower.includes(token)) return true
  if (isTui) for (const vocab of TUI_SNIPPET_VOCAB) if (lower.includes(vocab)) return true
  return false
}

/** `(ok, message)` result of one play assertion (legacy tuple). */
export interface PlayAssertionResult {
  readonly ok: boolean
  readonly message: string
}

/** One headless assertion over the rendered frame. */
export type PlayAssertion = (frame: string) => PlayAssertionResult

// d66328c:runner/queereye/csf.py (_play_assertions_for)
/** Clean-room play-function assertions for one story (callable list).
 *
 * Each assertion takes the rendered frame and returns `{ok, message}`. No
 * user interaction, no browser. Hardened: `"" in frame` tautology refused
 * (component must be stripped non-empty and named in the frame), empty
 * `args` refused (states as data [VERIFIED: 60c8c31d] requires at least one
 * arg), the loading `"True" in frame` tautology removed (requires the
 * `loading` token), and the paired spec snippets (web + tui) must be linked
 * in the frame.
 */
export function playAssertionsFor(story: unknown, spec?: CsfSpec | null, catalog?: SpecCatalog): PlayAssertion[] {
  const storyRecord = isRecord(story) ? story : {}
  const component = storyRecord.component
  const args = isRecord(storyRecord.args) ? storyRecord.args : {}
  const linked = isRecord(spec) ? spec : findSpecForComponent(component, catalog)

  const hasComponent: PlayAssertion = (frame) => {
    if (typeof component !== "string" || !hardenedString(component))
      return { ok: false, message: "component must be a stripped non-empty string" }
    // Zero-width-only component (ZWSP) is blank, not a name.
    const comp = hardenedString(component)
    // Strip paired snippet markers before checking: marker bytes
    // (`<!--web:<button>...-->`) previously laundered a lower-case `button`
    // against a `<Button>` frame (case laundering via in-marker bytes).
    // Check the outer tag only.
    const outer = String(stripMarkers(frame))
    // Exact frame-tag match, not substring: 'utton' is inside 'Button' so a
    // bare `in` check launders it. Require the opening tag "<Comp" plus the
    // closing tag "</Comp>" in the outer frame.
    if (!outer.includes(`<${comp}`) || !outer.includes(`</${comp}>`))
      return {
        ok: false,
        message:
          `frame missing exact tag for ${repr(comp)} in outer frame (substring refused; ` +
          "in-marker bytes ignored; require <Comp ...>...</Comp> outside markers)",
      }
    // Case-exact linkage: the story component must equal the linked spec's
    // `csf.component` exactly (`button` != `Button`). The case-insensitive
    // fallback in `findSpecForComponent` links `button` to the Button spec,
    // but the play gate refuses the case mismatch here.
    if (isRecord(linked)) {
      const linkedComp = hardenedString(specCsfComponent(linked))
      if (linkedComp && comp !== linkedComp)
        return {
          ok: false,
          message:
            `component ${repr(comp)} != linked spec component ${repr(linkedComp)} ` +
            `(case-exact linkage refused; require outer <${linkedComp}>, not <${comp}>)`,
        }
    }
    return { ok: true, message: `rendered frame names ${repr(comp)} as exact tag` }
  }

  const argsPresent: PlayAssertion = (frame) => {
    if (Object.keys(args).length === 0)
      return { ok: false, message: "args must be a non-empty object (states as data)" }
    const missing: string[] = []
    for (const key of Object.keys(args)) {
      if (!hardenedString(key)) {
        missing.push(repr(key))
        continue
      }
      const value = args[key]
      // Whitespace-only values ("   ") and zero-width-only are refused:
      // hardened strip-check arg values. Empty "" stays legitimate (the
      // `empty` state).
      if (typeof value === "string" && value !== "" && !hardenedString(value)) {
        missing.push(`${hardenedString(key)}: whitespace value refused`)
        continue
      }
      const rawValue = pythonStr(value)
      // Empty-string values (the `empty` state, e.g. value="") are
      // legitimate: assert the arg *key* rendered (`value=`), not the
      // `"" in frame` tautology (empty string is in every string).
      if (!hardenedString(rawValue)) {
        if (!frame.includes(`${hardenedString(key)}=`) && !frame.includes(hardenedString(key))) missing.push(key)
        continue
      }
      if (!frame.includes(rawValue)) missing.push(key)
    }
    if (missing.length) return { ok: false, message: `args missing from frame: [${missing.map(repr).join(", ")}]` }
    return { ok: true, message: `all ${Object.keys(args).length} args present in frame` }
  }

  const loadingOrLabel: PlayAssertion = (frame) => {
    if (args.loading) {
      // Require the loading token itself, not the "True" tautology: any True
      // arg would contain "True", so only "loading" proves the loading
      // state rendered.
      const ok = frame.toLowerCase().includes("loading")
      return { ok, message: ok ? "loading state visible" : "loading state invisible" }
    }
    return { ok: true, message: "non-loading story needs no spinner assertion" }
  }

  const snippetsLinked: PlayAssertion = (frame) => {
    if (!isRecord(linked)) return { ok: false, message: "no spec linked for snippet assertion" }
    if (!isRecord(linked.snippets)) return { ok: false, message: "linked spec has no snippets object" }
    const webSnippet = linked.snippets.web
    const tuiSnippet = linked.snippets.tui
    if (typeof webSnippet !== "string" || !hardenedString(webSnippet))
      return { ok: false, message: "linked spec web snippet blank (linkage refused)" }
    if (typeof tuiSnippet !== "string" || !hardenedString(tuiSnippet))
      return { ok: false, message: "linked spec tui snippet blank (linkage refused)" }
    // Snippet-quality: trivial "Button" passes the 40-char probe via the
    // component tag, so require min length + marker linkage, not just
    // substring. Both snippets must be substantive and the frame must carry
    // the paired markers (link to spec, not substring laundering). Hardened:
    // pure repetition (x*20/y*20) passes length + self-contains (probe is
    // the snippet's own prefix), so require a semantic link (snippet
    // references component name/variant/slot) plus entropy (no 10-char
    // repeat run, varied alphabet) [VERIFIED: 60c8c31d].
    const minSnippetLen = 20
    const tuiOneLine = hardenedString(tuiSnippet).split(/\s+/).join(" ")
    if (hardenedString(webSnippet).length < minSnippetLen)
      return {
        ok: false,
        message: `linked spec web snippet too short (<${minSnippetLen} chars; snippet-quality refused)`,
      }
    if (tuiOneLine.length < minSnippetLen)
      return {
        ok: false,
        message: `linked spec tui snippet too short (<${minSnippetLen} chars; snippet-quality refused)`,
      }
    if (isLowEntropy(webSnippet))
      return {
        ok: false,
        message:
          "linked spec web snippet low-entropy/repetition refused (x*20 self-contains refused; needs varied code)",
      }
    if (isLowEntropy(tuiSnippet))
      return {
        ok: false,
        message:
          "linked spec tui snippet low-entropy/repetition refused (y*20 self-contains refused; needs varied code)",
      }
    if (!snippetHasSemanticLink(webSnippet, linked, false))
      return {
        ok: false,
        message:
          "linked spec web snippet must reference the component (name/variant/slot; length + markers alone refused)",
      }
    if (!snippetHasSemanticLink(tuiSnippet, linked, true))
      return {
        ok: false,
        message:
          "linked spec tui snippet must reference the component (name/variant/slot/TUI vocab; length + markers refused)",
      }
    if (!frame.includes("<!--web:") || !frame.includes("<!--tui:"))
      return {
        ok: false,
        message: "snippets not linked in render (markers missing; substring laundering refused)",
      }
    if (!frame.includes(hardenedString(webSnippet).slice(0, 40)))
      return { ok: false, message: "web snippet not linked in render" }
    if (!frame.includes(tuiOneLine.slice(0, 40))) return { ok: false, message: "tui snippet not linked in render" }
    return { ok: true, message: "paired web+tui snippets linked in render" }
  }

  return [hasComponent, argsPresent, loadingOrLabel, snippetsLinked]
}

/** Result of `runPlay`: assertion messages by outcome. */
export interface PlayResult {
  readonly passed: string[]
  readonly failures: string[]
}

// d66328c:runner/queereye/csf.py (run_play)
/** Run the play function for one story. Returns `{passed, failures}`.
 *
 * Headless: no prompts, no input, no browser. `spec` optionally supplies the
 * linked spec (default: lookup in the injected `catalog` by `csf.component`);
 * an empty/blank component fails (no `"" in frame` tautology).
 */
export function runPlay(story: unknown, spec?: CsfSpec | null, catalog?: SpecCatalog): PlayResult {
  const frame = renderStory(story, spec, catalog)
  const passed: string[] = []
  const failures: string[] = []
  for (const assertion of playAssertionsFor(story, spec, catalog)) {
    const { ok, message } = assertion(frame)
    if (ok) passed.push(message)
    else failures.push(message)
  }
  return { passed, failures }
}

/** Result of `runPlaySuite`: per-story results and the green fraction. */
export interface PlaySuiteResult {
  readonly results: Record<string, PlayResult>
  readonly passRate: number
}

// d66328c:runner/queereye/csf.py (run_play_suite)
/** Run play functions over every exemplar story.
 *
 * `results` maps story id -> `{passed, failures}` and `passRate` is the
 * fraction of stories with zero failures. The injected spec catalog links
 * the exemplar stories to their snippets.
 */
export function runPlaySuite(stories?: readonly unknown[], catalog?: SpecCatalog): PlaySuiteResult {
  const list = stories ?? allExemplarStories()
  const results: Record<string, PlayResult> = {}
  let green = 0
  for (const story of list) {
    const result = runPlay(story, undefined, catalog)
    results[storyLabel(story)] = result
    if (result.failures.length === 0) green += 1
  }
  const total = Object.keys(results).length
  return { results, passRate: total ? green / total : 1 }
}

/** Result of the visual-regression hash compare. */
export interface VisualRegressionResult {
  readonly equal: boolean
  readonly hash_a: string
  readonly hash_b: string
}

// d66328c:runner/queereye/csf.py (visual_regression_check)
/** Clean-room visual-regression pattern: hash-compare rendered frames.
 *
 * Identical bytes pass; any difference fails with both hashes for the CI
 * log. This is a pattern rebuilt clean-room (sha256 compare), not a
 * vendored screenshot harness.
 */
export function visualRegressionCheck(frameA: string, frameB: string): VisualRegressionResult {
  const hashA = sha256(frameA)
  const hashB = sha256(frameB)
  return { equal: hashA === hashB, hash_a: hashA, hash_b: hashB }
}

// d66328c:runner/queereye/csf.py (spec_vs_render_check)
/** CI divergence gate: slots filled, downgrade rows per state, ref fresh.
 *
 * - Every slot named in `spec.slots` must appear in `renderedSlots` (the
 *   caller MUST supply the actual render output; `null`/missing is refused —
 *   no default-to-own-slots tautology).
 * - Every state in `spec.states` needs a `tui_rows` downgrade row
 *   (delegates to the tui module coverage for the full rule).
 * - `webrefFresh` must be `true` (pinned-ref freshness age gate).
 * Returns error list (empty = in sync).
 */
export function specVsRenderCheck(
  spec: unknown,
  renderedSlots?: Iterable<string> | null,
  webrefFresh: unknown = true,
): string[] {
  if (!isRecord(spec)) return ["spec must be an object"]
  const name = pythonStr(spec.name === undefined ? "<unnamed>" : spec.name)
  const errors: string[] = []
  if (renderedSlots === undefined || renderedSlots === null) {
    errors.push(
      `spec-vs-render ${name}: rendered_slots must be supplied by the caller (no default pass; pass the actual render output)`,
    )
  }
  const filled = renderedSlots === undefined || renderedSlots === null ? new Set<string>() : new Set(renderedSlots)
  const expectedSlots = isRecord(spec.slots) ? spec.slots : {}
  for (const slot of Object.keys(expectedSlots).sort())
    if (!filled.has(slot)) errors.push(`spec-vs-render ${name}: slot ${repr(slot)} not filled in render`)
  errors.push(...validateTuiCoverage(spec))
  if (webrefFresh !== true) errors.push(`spec-vs-render ${name}: pinned webref stale (freshness gate)`)
  return errors
}
