// Schema-typed 7-axis interview turn loop with recommendations and repair.
// Each axis is a form: a mandatory `requiredSlots` list that prompts for the
// next value. Every answer is validated inline by its repair hook (WCAG AA,
// scale monotonicity, contradiction rejection); vague answers are parse
// errors carrying a counter-question, and pasted raw values (hex, font
// literals) are smuggling attempts that must yield zero one-off tokens.

import type { ProbePair } from "./contrast.ts"
import { contrastRatio, ensureRatio, WCAG_AA_NORMAL } from "./contrast.ts"
import { validateTokens } from "./tokens.ts"

/** Interview axes in run order. */
export const AXES = ["brand", "color", "type", "layout", "effects", "dark_light", "a11y"] as const
export type Axis = (typeof AXES)[number]

/** Answers that carry no usable signal: parse errors with counter-questions. */
const VAGUE_ANSWERS = new Set([
  "",
  "?",
  "whatever",
  "anything",
  "idk",
  "i dunno",
  "dunno",
  "maybe",
  "yes",
  "no",
  "asdf",
  "test",
  "skip me",
])

const SKIP_WORDS = new Set(["skip", "skip axis", "skip this", "use defaults", "defaults"])

const HEX_SMUGGLING_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/
const QUOTED_FONT_RE = /['"][A-Za-z][A-Za-z0-9 .-]*['"]/

/** Taste markers that contradict an AA/AAA a11y requirement. */
const LOW_CONTRAST_MARKERS = [
  "low contrast",
  "faint",
  "barely visible",
  "pastel on white",
  "washed out",
  "subtle gray on white",
]

export class VagueAnswerError extends Error {
  constructor(
    readonly axis: Axis,
    readonly slot: string,
    readonly counterQuestion: string,
  ) {
    super(`vague answer for ${axis}.${slot}: ${counterQuestion}`)
  }
}

export class ContradictionError extends Error {
  constructor(
    readonly axis: Axis,
    readonly slot: string,
    readonly repair: string,
  ) {
    super(`contradiction in ${axis}.${slot}: ${repair}`)
  }
}

export class SmuggledValueError extends Error {
  constructor(
    readonly axis: Axis,
    readonly slot: string,
    readonly repair: string,
  ) {
    super(`smuggled raw value for ${axis}.${slot}: ${repair}`)
  }
}

export interface Form {
  readonly requiredSlots: readonly string[]
  readonly questions: Readonly<Record<string, string>>
  readonly recommendations: Readonly<Record<string, readonly string[]>>
  readonly defaults: Readonly<Record<string, string>>
}

export const FORMS: Readonly<Record<Axis, Form>> = {
  brand: {
    requiredSlots: ["name", "voice", "values"],
    questions: {
      name: "What is the product or brand name?",
      voice: "Which voice fits best: minimal, playful, editorial, or technical?",
      values: "Pick up to two guiding values (e.g. clarity, warmth, precision).",
    },
    recommendations: {
      name: ["Keep it under 3 words."],
      voice: ["minimal", "playful", "editorial", "technical"],
      values: ["clarity", "warmth", "precision", "boldness"],
    },
    defaults: { name: "Untitled", voice: "minimal", values: "clarity" },
  },
  color: {
    requiredSlots: ["primary", "neutral", "accent"],
    questions: {
      primary: "Which primary family: ocean, forest, plum, or ember?",
      neutral: "Which neutral family: slate, stone, or sand?",
      accent: "Which accent family: gold, teal, coral, or none?",
    },
    recommendations: {
      primary: ["ocean", "forest", "plum", "ember"],
      neutral: ["slate", "stone", "sand"],
      accent: ["gold", "teal", "coral", "none"],
    },
    defaults: { primary: "ocean", neutral: "slate", accent: "teal" },
  },
  type: {
    requiredSlots: ["family", "scale", "base_size"],
    questions: {
      family: "Which type family class: system, grotesque, serif, or mono?",
      scale: "Which modular scale: minor-third (1.200), major-third (1.250), or perfect-fourth (1.333)?",
      base_size: "Base body size in px (14, 16, or 18)?",
    },
    recommendations: {
      family: ["system", "grotesque", "serif", "mono"],
      scale: ["1.200", "1.250", "1.333"],
      base_size: ["14", "16", "18"],
    },
    defaults: { family: "system", scale: "1.250", base_size: "16" },
  },
  layout: {
    requiredSlots: ["density", "radius", "grid"],
    questions: {
      density: "Density: compact, comfortable, or spacious?",
      radius: "Corner radius scale: sharp (0/2), soft (6/10), or round (12/16)?",
      grid: "Grid columns for desktop: 8 or 12?",
    },
    recommendations: {
      density: ["compact", "comfortable", "spacious"],
      radius: ["sharp", "soft", "round"],
      grid: ["8", "12"],
    },
    defaults: { density: "comfortable", radius: "soft", grid: "12" },
  },
  effects: {
    requiredSlots: ["motion", "elevation", "decoration"],
    questions: {
      motion: "Motion: none, subtle (150ms), or expressive (250ms + spring)?",
      elevation: "Elevation: flat, restrained (2 levels), or deep (4 levels)?",
      decoration: "Decorative treatments (gradients, patterns) allowed: yes or text-safe-only?",
    },
    recommendations: {
      motion: ["none", "subtle", "expressive"],
      elevation: ["flat", "restrained", "deep"],
      decoration: ["text-safe-only", "yes"],
    },
    defaults: { motion: "subtle", elevation: "restrained", decoration: "text-safe-only" },
  },
  dark_light: {
    requiredSlots: ["modes", "surface"],
    questions: {
      modes: "Which color modes must ship: light, dark, or both?",
      surface: "Dark-mode surface strategy: dimmed brand, true black, or lifted gray?",
    },
    recommendations: {
      modes: ["both", "light", "dark"],
      surface: ["dimmed brand", "true black", "lifted gray"],
    },
    defaults: { modes: "both", surface: "dimmed brand" },
  },
  a11y: {
    requiredSlots: ["text_level", "large_text_level", "reduced_motion"],
    questions: {
      text_level: "Body-text target: AA (4.5:1) or AAA (7:1)?",
      large_text_level: "Large-text target: AA-large (3:1) or AA (4.5:1)?",
      reduced_motion: "Honor prefers-reduced-motion: yes or no?",
    },
    recommendations: {
      text_level: ["AA", "AAA"],
      large_text_level: ["AA-large", "AA"],
      reduced_motion: ["yes", "no"],
    },
    defaults: { text_level: "AA", large_text_level: "AA-large", reduced_motion: "yes" },
  },
}

/** Preference words → primitive hex (single source; never minted per answer). */
export const PRIMITIVES = {
  color: {
    ocean: "#1d4ed8",
    forest: "#15803d",
    plum: "#7e22ce",
    ember: "#c2410c",
    slate: "#475569",
    stone: "#57534e",
    sand: "#a8a29e",
    gold: "#b45309",
    teal: "#0f766e",
    coral: "#be123c",
    paper: "#ffffff",
    ink: "#0f172a",
  },
} as const

export const TYPE_STACKS: Readonly<Record<string, string>> = {
  system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  grotesque: "'Inter', system-ui, sans-serif",
  serif: "'Source Serif 4', Georgia, serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
}

export const TYPE_SCALES: Readonly<Record<string, number>> = { "1.200": 1.2, "1.250": 1.25, "1.333": 1.333 }
const DENSITY_SPACE: Readonly<Record<string, string>> = { compact: "4", comfortable: "8", spacious: "12" }
const RADIUS_SETS: Readonly<Record<string, readonly string[]>> = {
  sharp: ["0", "2"],
  soft: ["6", "10"],
  round: ["12", "16"],
}
const MOTION_MS: Readonly<Record<string, string>> = { none: "0", subtle: "150", expressive: "250" }

const norm = (value: unknown) => String(value ?? "").trim()

export const isVague = (value: unknown): boolean => {
  const text = norm(value).toLowerCase()
  return text.length < 2 || VAGUE_ANSWERS.has(text)
}

/** Raw hex/font literals smuggled inside a free-text answer. */
export function findSmuggledRaw(value: unknown): string[] {
  const text = norm(value)
  const hits = [...text.matchAll(new RegExp(HEX_SMUGGLING_RE.source, "g"))].map((match) => `hex ${match[0]}`)
  hits.push(...[...text.matchAll(new RegExp(QUOTED_FONT_RE.source, "g"))].map((match) => `font literal ${match[0]}`))
  return hits
}

/** Deterministic counter-question for a vague answer. */
export function counterQuestionFor(axis: Axis, slot: string): string {
  const form = FORMS[axis]
  const options = (form.recommendations[slot] ?? []).join(", ")
  const base = form.questions[slot] ?? `${axis}.${slot}?`
  return options ? `${base} Please pick one of: ${options}.` : `${base} Please answer in a few words.`
}

// ------------------------------------------------------------- repair hooks

const validateBrandForm = (slots: Record<string, string>): string[] => {
  const repairs: string[] = []
  const values = norm(slots.values).toLowerCase()
  if (LOW_CONTRAST_MARKERS.some((marker) => values.includes(marker)))
    repairs.push(
      "brand values ask for low contrast while the guide is contrast-gated; repair: keep the value word but pair it with AA text colors.",
    )
  return repairs
}

const validateColorForm = (slots: Record<string, string>): string[] => {
  const repairs: string[] = []
  for (const slot of ["primary", "neutral", "accent"]) {
    const word = norm(slots[slot]).toLowerCase()
    if (word === "" || word === "none") continue
    if (!(word in PRIMITIVES.color))
      repairs.push(
        `unknown color family "${word}" for ${slot}; repair: pick ocean/forest/plum/ember (primary), slate/stone/sand (neutral), gold/teal/coral/none (accent).`,
      )
  }
  return repairs
}

const validateTypeForm = (slots: Record<string, string>): string[] => {
  const repairs: string[] = []
  const family = norm(slots.family)
  if (family && !(family.toLowerCase() in TYPE_STACKS))
    repairs.push("unknown type family; repair: system/grotesque/serif/mono.")
  const scale = norm(slots.scale)
  if (scale && !(scale in TYPE_SCALES)) repairs.push("unknown modular scale; repair: 1.200/1.250/1.333.")
  const base = norm(slots.base_size)
  if (base && !["14", "16", "18"].includes(base)) repairs.push("unknown base size; repair: 14/16/18.")
  return repairs
}

const validateLayoutForm = (slots: Record<string, string>): string[] => {
  const repairs: string[] = []
  const density = norm(slots.density)
  if (density && !(density.toLowerCase() in DENSITY_SPACE))
    repairs.push("unknown density; repair: compact/comfortable/spacious.")
  const radius = norm(slots.radius)
  if (radius && !(radius.toLowerCase() in RADIUS_SETS)) repairs.push("unknown radius; repair: sharp/soft/round.")
  const grid = norm(slots.grid)
  if (grid && !["8", "12"].includes(grid)) repairs.push("unknown grid; repair: 8/12.")
  return repairs
}

const validateEffectsForm = (slots: Record<string, string>): string[] => {
  const repairs: string[] = []
  const motion = norm(slots.motion)
  if (motion && !(motion.toLowerCase() in MOTION_MS)) repairs.push("unknown motion; repair: none/subtle/expressive.")
  if (norm(slots.decoration).toLowerCase() === "yes")
    repairs.push(
      "unrestricted decoration risks decorative-but-inaccessible text; repair: text-safe-only (decorative treatments never carry text).",
    )
  return repairs
}

const validateDarkLightForm = (slots: Record<string, string>): string[] => {
  const repairs: string[] = []
  const modes = norm(slots.modes)
  if (modes && !["light", "dark", "both"].includes(modes.toLowerCase()))
    repairs.push("unknown modes; repair: light/dark/both.")
  const surface = norm(slots.surface)
  if (surface && !["dimmed brand", "true black", "lifted gray"].includes(surface.toLowerCase()))
    repairs.push("unknown surface; repair: dimmed brand/true black/lifted gray.")
  return repairs
}

const validateA11yForm = (slots: Record<string, string>): string[] => {
  const repairs: string[] = []
  const textLevel = norm(slots.text_level)
  if (textLevel && !["AA", "AAA"].includes(textLevel.toUpperCase()))
    repairs.push("body-text target below AA is rejected; repair: AA (4.5:1) or AAA (7:1).")
  const large = norm(slots.large_text_level)
  if (large && !["AA-LARGE", "AA"].includes(large.toUpperCase()))
    repairs.push("large-text target below 3:1 is rejected; repair: AA-large (3:1) or AA.")
  const reduced = norm(slots.reduced_motion)
  if (reduced && !["yes", "no"].includes(reduced.toLowerCase()))
    repairs.push("reduced_motion must be yes/no; repair: yes.")
  return repairs
}

const VALIDATORS: Readonly<Record<Axis, (slots: Record<string, string>) => string[]>> = {
  brand: validateBrandForm,
  color: validateColorForm,
  type: validateTypeForm,
  layout: validateLayoutForm,
  effects: validateEffectsForm,
  dark_light: validateDarkLightForm,
  a11y: validateA11yForm,
}

export const validateForm = (axis: Axis, slots: Record<string, string>): string[] => [...VALIDATORS[axis]({ ...slots })]

// ------------------------------------------------------------- the loop

export interface NextSlot {
  readonly axis: Axis
  readonly slot: string
  readonly question: string
  readonly recommendations: readonly string[]
}

export class SlotLoop {
  readonly values: Record<Axis, Record<string, string>> = Object.fromEntries(AXES.map((axis) => [axis, {}])) as never
  readonly skipped: Record<Axis, Set<string>> = Object.fromEntries(AXES.map((axis) => [axis, new Set()])) as never

  requiredSlots(axis: Axis): string[] {
    return [...FORMS[axis].requiredSlots]
  }

  nextRequiredSlot(): NextSlot | undefined {
    for (const axis of AXES)
      for (const slot of this.requiredSlots(axis))
        if (!(slot in this.values[axis]) && !this.skipped[axis].has(slot))
          return {
            axis,
            slot,
            question: FORMS[axis].questions[slot]!,
            recommendations: [...(FORMS[axis].recommendations[slot] ?? [])],
          }
    return undefined
  }

  isComplete(): boolean {
    return this.nextRequiredSlot() === undefined
  }

  /** Explicitly default one slot (the all-skip path). */
  skip(axis: Axis, slot: string): void {
    if (!this.requiredSlots(axis).includes(slot)) throw new Error(`unknown slot ${axis}.${slot}`)
    this.skipped[axis].add(slot)
    delete this.values[axis][slot]
  }

  /** Validate and store one answer; throws on vague/smuggled/contradiction. */
  submit(axis: Axis, slot: string, value: unknown): string {
    if (!AXES.includes(axis) || !this.requiredSlots(axis).includes(slot))
      throw new Error(`unknown slot ${axis}.${slot}`)
    const text = norm(value)
    if (SKIP_WORDS.has(text.toLowerCase())) {
      this.skip(axis, slot)
      return this.effective(axis, slot)
    }
    // Valid recommended words are never vague, even when short ("8", "yes",
    // "no"): a yes/no answer to a yes/no slot carries signal.
    const validWords = new Set(
      [...(FORMS[axis].recommendations[slot] ?? []), FORMS[axis].defaults[slot]!].map((word) =>
        String(word).toLowerCase(),
      ),
    )
    if (!validWords.has(text.toLowerCase()) && isVague(text))
      throw new VagueAnswerError(axis, slot, counterQuestionFor(axis, slot))
    const smuggled = findSmuggledRaw(text)
    if (smuggled.length)
      throw new SmuggledValueError(
        axis,
        slot,
        `pasted raw value (${smuggled.join("; ")}) is not minted as a one-off; repair: answer with the recommended word and it aliases an existing primitive.`,
      )
    if (axis === "color" && HEX_SMUGGLING_RE.test(text))
      throw new SmuggledValueError(axis, slot, "hex literals never become tokens; pick a family word.")
    const problems = validateForm(axis, { ...this.values[axis], [slot]: text })
    if (problems.length) throw new ContradictionError(axis, slot, problems.join(" | "))
    const cross = this.crossAxisRepair(axis, slot, text)
    if (cross) throw new ContradictionError(axis, slot, cross)
    this.skipped[axis].delete(slot)
    this.values[axis][slot] = text
    return text
  }

  /** Settled value or the axis default (skipped slots stay defaulted). */
  effective(axis: Axis, slot: string): string {
    return this.values[axis][slot] ?? FORMS[axis].defaults[slot]!
  }

  private crossAxisRepair(axis: Axis, slot: string, text: string): string | undefined {
    const low = text.toLowerCase()
    if (axis === "brand" && slot === "values") {
      const level = this.values.a11y.text_level ?? "AA"
      if (LOW_CONTRAST_MARKERS.some((marker) => low.includes(marker)) && ["AA", "AAA"].includes(level.toUpperCase()))
        return `sycophancy refused: 'low contrast' taste contradicts the ${level.toUpperCase()} text gate; repair: keep the aesthetic in non-text decoration, text stays AA.`
    }
    if (axis === "a11y" && slot === "text_level") {
      const brandValues = (this.values.brand.values ?? "").toLowerCase()
      if (LOW_CONTRAST_MARKERS.some((marker) => brandValues.includes(marker)) && ["aa", "aaa"].includes(low))
        return "contradiction with settled brand values demanding low contrast; repair: text stays gated, low contrast is non-text decoration only."
    }
    if (axis === "effects" && slot === "motion") {
      if ((this.values.a11y.reduced_motion ?? "yes").toLowerCase() === "yes" && low === "expressive") return undefined
      if (low === "always animate everything, ignore prefers-reduced-motion")
        return "motion contradicts reduced-motion=yes; repair: expressive motion with a reduced-motion off-ramp."
    }
    return undefined
  }

  private colorHex(word: string, fallback: string): string {
    const key = norm(word).toLowerCase() || fallback
    return (
      PRIMITIVES.color[key as keyof typeof PRIMITIVES.color] ??
      PRIMITIVES.color[fallback as keyof typeof PRIMITIVES.color]
    )
  }

  /**
   * Build the primitive → semantic → component token tree. Every
   * non-primitive `$value` is an alias, so a completed loop (including
   * all-skip) mints zero one-off tokens. Color pairs are contrast-gated:
   * any chosen combination below the target is nudged with the ratio-first
   * generator before it becomes a primitive.
   */
  toTokens(): Record<string, unknown> {
    const textLevel = this.effective("a11y", "text_level").toUpperCase()
    const bodyTarget = textLevel === "AAA" ? 7.0 : WCAG_AA_NORMAL

    let primary = this.colorHex(this.effective("color", "primary"), "ocean")
    let neutral = this.colorHex(this.effective("color", "neutral"), "slate")
    const accentWord = norm(this.effective("color", "accent")).toLowerCase()
    const accent = accentWord !== "none" ? this.colorHex(accentWord, "teal") : undefined
    const paper = PRIMITIVES.color.paper
    const ink = PRIMITIVES.color.ink

    primary = ensureRatio(primary, paper, bodyTarget)
    if (contrastRatio(neutral, paper) < bodyTarget) neutral = ensureRatio(neutral, paper, bodyTarget)

    const modes = norm(this.effective("dark_light", "modes")).toLowerCase()
    const surfaceWord = norm(this.effective("dark_light", "surface")).toLowerCase()
    const darkSurface = { "true black": "#000000", "lifted gray": "#1f2937" }[surfaceWord] ?? "#172554"
    const darkOn = "#f8fafc"
    const darkPrimary =
      contrastRatio(primary, darkSurface) < bodyTarget ? ensureRatio(primary, darkSurface, bodyTarget) : primary

    const scale = TYPE_SCALES[norm(this.effective("type", "scale"))]!
    const base = Number.parseInt(norm(this.effective("type", "base_size")), 10)
    const steps = Array.from({ length: 6 }, (_, index) => Math.round(base * scale ** index * 100) / 100)
    if (!steps.every((step, index) => index === 0 || step > steps[index - 1]!))
      throw new Error("type scale is not monotonic")
    const familyWord = norm(this.effective("type", "family")).toLowerCase()
    const densityWord = norm(this.effective("layout", "density")).toLowerCase()
    const radiusPair = RADIUS_SETS[norm(this.effective("layout", "radius")).toLowerCase()]!
    const motionWord = norm(this.effective("effects", "motion")).toLowerCase()
    const reduced = norm(this.effective("a11y", "reduced_motion")).toLowerCase() === "yes"

    const colorPrimitives: Record<string, unknown> = {
      "brand-500": { $value: primary, $type: "color", $description: "Primary brand color (contrast-gated)." },
      "neutral-500": { $value: neutral, $type: "color", $description: "Neutral text/support color (contrast-gated)." },
      paper: { $value: paper, $type: "color", $description: "Light surface." },
      ink: { $value: ink, $type: "color", $description: "Light body text." },
      "dark-surface": { $value: darkSurface, $type: "color", $description: "Dark-mode surface." },
      "dark-ink": { $value: darkOn, $type: "color", $description: "Dark-mode body text." },
      "dark-brand-500": {
        $value: darkPrimary,
        $type: "color",
        $description: "Dark-mode brand color (contrast-gated).",
      },
    }
    if (accent !== undefined)
      colorPrimitives["accent-500"] = { $value: accent, $type: "color", $description: "Accent color." }

    const semanticText =
      contrastRatio(primary, paper) >= bodyTarget ? "{color.primitive.brand-500}" : "{color.primitive.neutral-500}"
    return {
      color: {
        primitive: colorPrimitives,
        semantic: {
          primary: { $value: "{color.primitive.brand-500}", $type: "color", $description: "Brand primary alias." },
          "text-body": { $value: semanticText, $type: "color", $description: "Body text alias (gated)." },
          surface: { $value: "{color.primitive.paper}", $type: "color", $description: "Default surface alias." },
          "text-body-dark": {
            $value: "{color.primitive.dark-ink}",
            $type: "color",
            $description: "Dark-mode body text alias.",
          },
        },
        component: {
          $type: "color",
          "button-background": { $value: "{color.semantic.primary}" },
          "button-text": { $value: "{color.primitive.paper}" },
          "link-text": { $value: "{color.semantic.text-body}" },
        },
      },
      type: {
        primitive: {
          "family-base": {
            $value: TYPE_STACKS[familyWord] ?? TYPE_STACKS.system,
            $type: "fontFamily",
            $description: "Base type stack.",
          },
          "size-base": { $value: { value: base, unit: "px" }, $type: "dimension", $description: "Base body size." },
          "scale-ratio": { $value: scale, $type: "number", $description: "Modular scale ratio." },
          ...Object.fromEntries(
            [...steps].reverse().map((step, index) => [
              `heading-${index + 1}`,
              {
                $value: { value: step, unit: "px" },
                $type: "dimension",
                $description: `Scale step ${index + 1} (primitive).`,
              },
            ]),
          ),
        },
        semantic: {
          body: { $value: "{type.primitive.family-base}", $type: "fontFamily" },
          "body-size": { $value: "{type.primitive.size-base}", $type: "dimension" },
          ...Object.fromEntries(
            Array.from({ length: 6 }, (_, index) => [
              `heading-${index + 1}`,
              { $value: `{type.primitive.heading-${index + 1}}`, $type: "dimension" },
            ]),
          ),
        },
        component: {
          $type: "dimension",
          ...Object.fromEntries(
            Array.from({ length: 6 }, (_, index) => [
              `heading-${index + 1}`,
              { $value: `{type.semantic.heading-${index + 1}}` },
            ]),
          ),
        },
      },
      space: {
        primitive: {
          base: {
            $value: { value: Number.parseInt(DENSITY_SPACE[densityWord] ?? "8", 10), unit: "px" },
            $type: "dimension",
            $description: "Density base step.",
          },
          "grid-columns": { $value: Number.parseInt(norm(this.effective("layout", "grid")), 10), $type: "number" },
        },
        semantic: { md: { $value: "{space.primitive.base}", $type: "dimension" } },
      },
      radius: {
        primitive: {
          sm: { $value: { value: Number.parseInt(radiusPair[0]!, 10), unit: "px" }, $type: "dimension" },
          lg: { $value: { value: Number.parseInt(radiusPair[1]!, 10), unit: "px" }, $type: "dimension" },
        },
        semantic: {
          control: { $value: "{radius.primitive.sm}", $type: "dimension" },
          card: { $value: "{radius.primitive.lg}", $type: "dimension" },
        },
      },
      motion: {
        primitive: {
          "duration-base": {
            $value: { value: Number.parseInt(MOTION_MS[motionWord] ?? "150", 10), unit: "ms" },
            $type: "duration",
          },
          "reduced-motion": { $value: reduced ? "reduce" : "no-preference", $type: "string" },
        },
        semantic: { control: { $value: "{motion.primitive.duration-base}", $type: "duration" } },
      },
      modes: {
        $type: "string",
        primitive: { supported: { $value: modes } },
        semantic: { current: { $value: "{modes.primitive.supported}" } },
      },
    }
  }

  /** Text color pairs (name, fg, bg, large?) for the contrast gate. */
  probePairs(): ProbePair[] {
    const tokens = this.toTokens() as any
    const prim = tokens.color.primitive
    const pairs: ProbePair[] = [
      { name: "body on paper", fg: prim["neutral-500"].$value, bg: prim.paper.$value },
      { name: "brand on paper", fg: prim["brand-500"].$value, bg: prim.paper.$value },
      { name: "body on dark", fg: prim["dark-ink"].$value, bg: prim["dark-surface"].$value },
    ]
    if (prim["accent-500"])
      pairs.push({ name: "accent large on paper", fg: prim["accent-500"].$value, bg: prim.paper.$value, large: true })
    return pairs
  }

  /** Validation errors for the current partial tree (empty = valid). */
  tokenErrors(): string[] {
    return validateTokens(this.toTokens())
  }
}
