// Queereye phase-02 component specs: the six exemplar contracts, the
// validateSpec/validateAll port (hardened strings, prose/entropy bars, cva
// matrix, snippets, a11y, CSF, tui rows) and the deterministic markdown
// render. Ported from d66328c:runner/tests/test_queereye_specs.py (the
// spec-only portions; project/CLI and webref/tui/csf gates live elsewhere).
import { describe, expect, test } from "bun:test"
import {
  BUTTON_ANATOMY,
  type ComponentSpec,
  CVA_SIZES,
  CVA_VARIANTS,
  DIALOG_ANATOMY,
  EXEMPLARS,
  INPUT_ANATOMY,
  REQUIRED_SPEC_KEYS,
  REQUIRED_STATES,
  renderSpecMd,
  specFilename,
  validateAll,
  validateSpec,
} from "../src/queereye/specs.ts"

const clone = (spec: ComponentSpec): ComponentSpec => structuredClone(spec)

/** Delete a key like Python `del spec["key"]` (missing-section probes). */
const drop = (target: object, key: string): void => {
  Reflect.deleteProperty(target, key)
}

describe("spec constants", () => {
  test("cva axes enumerate the variant x size matrix", () => {
    expect([...CVA_VARIANTS]).toEqual(["default", "outline", "ghost", "destructive", "secondary", "link"])
    expect([...CVA_SIZES]).toEqual(["default", "xs", "sm", "lg", "icon"])
  })

  test("anatomy constants carry the canonical part lists", () => {
    expect([...DIALOG_ANATOMY]).toEqual([
      "Root",
      "Trigger",
      "Portal",
      "Overlay",
      "Content",
      "Title",
      "Description",
      "Close",
    ])
    expect([...BUTTON_ANATOMY]).toEqual(["Root", "Label", "Icon", "Spinner"])
    expect([...INPUT_ANATOMY]).toEqual(["Root", "Label", "Field", "Hint", "Error"])
  })

  test("required states and required spec keys are pinned", () => {
    expect([...REQUIRED_STATES]).toEqual(["loading", "empty", "error", "disabled"])
    expect([...REQUIRED_SPEC_KEYS]).toEqual([
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
    ])
  })
})

describe("exemplar completeness (d66328c:runner/tests/test_queereye_specs.py TestSpecCompleteness)", () => {
  test("six exemplars present", () => {
    expect(Object.keys(EXEMPLARS).sort()).toEqual(["button", "dialog", "form-input", "nav", "table", "toast"])
  })

  test("exemplars validate clean", () => {
    for (const [name, errors] of Object.entries(validateAll())) expect(errors, name).toEqual([])
  })

  test("table, nav and toast validate individually", () => {
    expect(validateSpec(EXEMPLARS.table)).toEqual([])
    expect(validateSpec(EXEMPLARS.nav)).toEqual([])
    expect(validateSpec(EXEMPLARS.toast)).toEqual([])
  })

  test("missing variants fails", () => {
    const bad = clone(EXEMPLARS.button)
    drop(bad, "variants")
    expect(validateSpec(bad).some((error) => error.includes("variants"))).toBe(true)
  })

  test("missing slots fails", () => {
    const bad = clone(EXEMPLARS.button)
    bad.slots = {}
    expect(validateSpec(bad)).not.toEqual([])
  })

  test("missing keyboard or focus fails", () => {
    const noKeyboard = clone(EXEMPLARS.dialog)
    noKeyboard.keyboard = []
    expect(validateSpec(noKeyboard).some((error) => error.includes("keyboard"))).toBe(true)
    const noFocus = clone(EXEMPLARS.dialog)
    drop(noFocus, "focus")
    expect(validateSpec(noFocus).some((error) => error.includes("focus"))).toBe(true)
  })

  test("missing tui snippet fails", () => {
    const bad = clone(EXEMPLARS["form-input"])
    drop(bad.snippets, "tui")
    expect(validateSpec(bad).some((error) => error.includes("snippets.tui"))).toBe(true)
  })

  test("missing csf.component fails", () => {
    const bad = clone(EXEMPLARS.button)
    drop(bad.csf, "component")
    expect(validateSpec(bad).some((error) => error.includes("csf.component"))).toBe(true)
  })

  test("incomplete cva matrix fails", () => {
    const bad = clone(EXEMPLARS.button)
    bad.variants = { variant: ["default"], size: ["default"], default: { variant: "default", size: "default" } }
    const errors = validateSpec(bad)
    expect(errors.some((error) => error.includes("cva"))).toBe(true)
  })
})

describe("hardened validation rules", () => {
  test("truncated dialog anatomy fails", () => {
    const bad = clone(EXEMPLARS.dialog)
    bad.anatomy = ["Root"]
    expect(validateSpec(bad).some((error) => error.includes("DIALOG_ANATOMY"))).toBe(true)
  })

  test("non-string anatomy entries return structured errors, never throw", () => {
    const bad = clone(EXEMPLARS.button)
    bad.anatomy = ["Root", { evil: 1 } as unknown as string]
    const errors = validateSpec(bad)
    expect(errors.some((error) => error.includes("string") || error.includes("hashable"))).toBe(true)
  })

  test("unknown spec name is refused", () => {
    const bad = clone(EXEMPLARS.button)
    bad.name = "evil"
    bad.anatomy = ["X"]
    expect(validateSpec(bad).some((error) => error.includes("unknown spec name"))).toBe(true)
  })

  test("smuggled cva values and defaults are refused", () => {
    const badValue = clone(EXEMPLARS.button)
    badValue.variants.variant = [...CVA_VARIANTS, "evil"]
    expect(validateSpec(badValue).some((error) => error.includes("unknown cva"))).toBe(true)

    const badDefault = clone(EXEMPLARS.button)
    badDefault.variants.default = { variant: "evil", size: "default" }
    expect(validateSpec(badDefault).some((error) => error.includes("cva axis"))).toBe(true)

    const badProp = clone(EXEMPLARS.button)
    badProp.props.Variant = { type: "enum", values: ["evil"], default: "evil" }
    expect(validateSpec(badProp).some((error) => error.includes("smuggle") || error.includes("cva"))).toBe(true)
  })

  test("blank and placeholder values are refused", () => {
    const blankState = clone(EXEMPLARS.button)
    blankState.states.loading = "   "
    expect(validateSpec(blankState).some((error) => error.includes("loading"))).toBe(true)

    const placeholder = clone(EXEMPLARS.dialog)
    placeholder.focus = { web: "todo", tui: "todo" }
    const errors = validateSpec(placeholder)
    expect(errors.some((error) => error.includes("prose-wave") || error.includes("placeholder"))).toBe(true)
    expect(errors.some((error) => error.includes("keyboard-first"))).toBe(true)
  })

  test("zero-width strings count as blank", () => {
    const badProp = clone(EXEMPLARS.button)
    badProp.props.label = { type: "\u200b", default: "" }
    expect(validateSpec(badProp).some((error) => error.includes("prop") && error.includes("type"))).toBe(true)

    const badSlot = clone(EXEMPLARS.button)
    badSlot.slots["\u200b"] = { description: "evil" }
    expect(validateSpec(badSlot).some((error) => error.includes("slot name"))).toBe(true)
  })

  test("gibberish snippets are refused", () => {
    const bad = clone(EXEMPLARS.button)
    bad.snippets = { web: "x".repeat(20), tui: "y".repeat(20) }
    const errors = validateSpec(bad)
    expect(
      errors.some(
        (error) => error.includes("snippets") && (error.includes("low-entropy") || error.includes("reference")),
      ),
    ).toBe(true)
  })

  test("keyword + repeat scroll re-specs are refused", () => {
    const bad = clone(EXEMPLARS.button)
    bad.scroll = { web: `scroll ${"x".repeat(100)}`, tui: `region ${"y".repeat(100)}` }
    const errors = validateSpec(bad)
    expect(
      errors.some(
        (error) => error.includes("scroll") && (error.includes(">=2 distinct") || error.includes("low-entropy")),
      ),
    ).toBe(true)
  })
})

describe("renderSpecMd (byte-stable deterministic render)", () => {
  test("render is byte-stable across calls for every exemplar", () => {
    for (const [name, spec] of Object.entries(EXEMPLARS)) {
      const first = renderSpecMd(spec)
      expect(renderSpecMd(spec)).toBe(first)
      expect(first).toContain(`# Component — ${name}`)
    }
  })

  test("golden substrings match the template render", () => {
    const md = renderSpecMd(EXEMPLARS.button)
    for (const needle of [
      "# Component — button",
      "- variant: default, outline, ghost, destructive, secondary, link",
      '- default: `{"size": "default", "variant": "default"}`',
      "| variant | enum | default | default,outline,ghost,destructive,secondary,link |",
      "| disabled | boolean | False |  |",
      "- component: `Button` (required for autodocs [VERIFIED: 60c8c31d])",
      "| hover | pointer hover tint | focus-visible border (no pointer) |",
    ]) {
      expect(md).toContain(needle)
    }
    expect(md.endsWith("\n")).toBe(true)
  })

  test("specFilename sanitizes to the components/ path", () => {
    expect(specFilename("form-input")).toBe("components/form-input.md")
    expect(specFilename("a b/c")).toBe("components/a-b-c.md")
    expect(specFilename("Table")).toBe("components/Table.md")
  })

  test("validateAll takes a subset map", () => {
    const results = validateAll({ button: EXEMPLARS.button })
    expect(Object.keys(results)).toEqual(["button"])
    expect(results.button).toEqual([])
  })
})
