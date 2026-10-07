// Queereye phase-02 acceptance: CSF interchange + the headless play harness,
// the pinned webref snapshot + license gate, the TUI lowering notes and the
// spec-vs-render divergence gate. Ports the CSF/webref/TUI portions of
// d66328c:runner/tests/test_queereye_specs.py that need no phase-01 project.
import { describe, expect, test } from "bun:test"
import {
  allExemplarStories,
  EXEMPLAR_STORIES,
  playAssertionsFor,
  renderStory,
  runPlay,
  runPlaySuite,
  specVsRenderCheck,
  validateAllStories,
  validateCsfMeta,
  visualRegressionCheck,
} from "../src/queereye/csf.ts"
import {
  CONSTRAINT_CATALOG,
  DOWNGRADE_ROWS,
  EVENT_LOOP_NOTE,
  loweringFor,
  NEGATIVE_KNOWLEDGE,
  renderTuiNotes,
  validateTuiCoverage,
  WEB_ONLY_PRIMITIVES,
  waiverHasSemanticPhrase,
} from "../src/queereye/tui.ts"
import {
  COPYLEFT_IDS,
  isWebrefFresh,
  LICENSE_WHITELIST,
  licenseGate,
  noteHasSemanticPhrase,
  SNAPSHOT_FILES,
  snapshotAgeDays,
  snapshotBytes,
  snapshotHash,
  spdxBlock,
  TRANSFORM_GROUPS,
  verifySnapshot,
  WEBREF_MAX_AGE_DAYS,
  WEBREF_NAME,
  WEBREF_PINNED_ON,
  webrefManifest,
} from "../src/queereye/webref.ts"

// Duck-typed spec fixtures (the same shape specs.ts ships): the play harness
// links snippets from whichever catalog it is handed.
const tuiRows = () => DOWNGRADE_ROWS.map((row) => ({ ...row }))

const BUTTON_SPEC = {
  name: "button",
  csf: { component: "Button", title: "Queereye/Button" },
  slots: { label: {}, icon: {}, spinner: {} },
  variants: {
    variant: ["default", "outline", "ghost", "destructive", "secondary", "link"],
    size: ["default", "xs", "sm", "lg", "icon"],
  },
  states: {
    loading: "Spinner replaces icon; label unchanged.",
    empty: "Icon-only buttons require aria-label.",
    error: "Destructive variant; error text adjacent.",
    disabled: "aria-disabled + no activation.",
  },
  snippets: {
    web: '<button class="btn" data-variant="default" data-size="default">Save</button>',
    tui: "[ Save ]  (focused: >[ Save ]< with inverted border)",
  },
  tui_rows: tuiRows(),
}

const DIALOG_SPEC = {
  name: "dialog",
  csf: { component: "Dialog", title: "Queereye/Dialog" },
  slots: { title: {}, description: {} },
  states: {},
  snippets: {
    web: '<div role="dialog" aria-modal="true" class="dialog">Title</div>',
    tui: "[ Dialog title ]  focus list pinned; status line plain text",
  },
  tui_rows: tuiRows(),
}

const FORM_INPUT_SPEC = {
  name: "form-input",
  csf: { component: "FormInput", title: "Queereye/FormInput" },
  slots: { label: {}, hint: {}, error: {} },
  states: { empty: "No value entered.", error: "Invalid value.", disabled: "Field disabled." },
  snippets: {
    web: '<input class="form-input" type="text" aria-label="Label" />',
    tui: "[ Label: value ]  (error line printed below field; hint text)",
  },
  tui_rows: tuiRows(),
}

const SPEC_CATALOG = { button: BUTTON_SPEC, dialog: DIALOG_SPEC, "form-input": FORM_INPUT_SPEC }

describe("CSF meta validation (d66328c TestCsfGate / TestF4CsfHardened)", () => {
  test("component and id are required hardened strings", () => {
    expect(validateCsfMeta({ id: "x", component: "Button" })).toEqual([])
    expect(validateCsfMeta({ id: "x", title: "No component" }).some((error) => error.includes("component"))).toBe(true)
    expect(validateCsfMeta({ id: "x", component: "   " }).some((error) => error.includes("component"))).toBe(true)
    expect(validateCsfMeta({ id: "\u200b", component: "Button" }).some((error) => error.includes("'id'"))).toBe(true)
    expect(validateCsfMeta({ component: "Button" }).some((error) => error.includes("'id'"))).toBe(true)
    expect(
      validateCsfMeta({ id: "x", component: "Button", args: "evil" }).some((error) => error.includes("args")),
    ).toBe(true)
    expect(validateCsfMeta({ id: "x", component: "Button", args: null }).some((error) => error.includes("args"))).toBe(
      true,
    )
    expect(validateCsfMeta("evil")).toEqual(["csf story must be an object"])
  })

  test("every exemplar story validates and the inventory is pinned", () => {
    expect(Object.keys(EXEMPLAR_STORIES).sort()).toEqual(["button", "dialog", "form-input"])
    expect(allExemplarStories()).toHaveLength(7)
    const results = validateAllStories()
    expect(Object.keys(results)).toEqual([
      "button--default",
      "button--loading",
      "button--destructive",
      "dialog--closed",
      "dialog--open",
      "form-input--empty",
      "form-input--error",
    ])
    for (const [id, errors] of Object.entries(results)) expect(errors, id).toEqual([])
  })
})

describe("headless play harness (d66328c TestCsfGate / TestF4 / TestFinalHardening7)", () => {
  test("the default exemplar suite passes headlessly at rate 1.0", () => {
    const { results, passRate } = runPlaySuite()
    expect(passRate).toBe(1)
    for (const [id, result] of Object.entries(results)) {
      expect(result.failures, id).toEqual([])
      expect(result.passed.length, id).toBeGreaterThan(0)
    }
  })

  test("an injected spec catalog drives the same suite through data", () => {
    const { results, passRate } = runPlaySuite(allExemplarStories(), SPEC_CATALOG)
    expect(passRate).toBe(1)
    expect(Object.keys(results)).toHaveLength(7)
    for (const result of Object.values(results)) expect(result.failures).toEqual([])
  })

  test("a story with no linked spec renders no snippet markers and fails the play gate", () => {
    const story = { id: "orphan", component: "Orphan", args: { label: "Save" } }
    const frame = renderStory(story, undefined, {})
    expect(frame).not.toContain("<!--web:")
    expect(frame).not.toContain("<!--tui:")
    const { failures } = runPlay(story, undefined, {})
    expect(failures.some((failure) => failure.includes("no spec linked"))).toBe(true)
  })

  test("blank or gibberish snippets are refused", () => {
    const blank = { ...BUTTON_SPEC, snippets: { web: "   ", tui: BUTTON_SPEC.snippets.tui } }
    const blankRun = runPlay({ component: "Button", args: { label: "Save" } }, blank)
    expect(blankRun.failures.some((failure) => failure.includes("blank"))).toBe(true)

    const gibberish = { ...BUTTON_SPEC, snippets: { web: "x".repeat(20), tui: "y".repeat(20) } }
    const gibberishRun = runPlay({ component: "Button", args: { label: "Save" } }, gibberish)
    expect(
      gibberishRun.failures.some((failure) => failure.includes("low-entropy") || failure.includes("reference")),
    ).toBe(true)
  })

  test("empty components, empty args and whitespace values fail", () => {
    expect(runPlay({ component: "", args: {} }).failures).not.toEqual([])
    expect(runPlay({ component: "   ", args: { a: "b" } }).failures).not.toEqual([])
    const emptyArgs = runPlay({ component: "Button", args: {} }, BUTTON_SPEC)
    expect(emptyArgs.failures.some((failure) => failure.includes("args"))).toBe(true)
    const whitespace = runPlay({ component: "Button", args: { label: "   " } }, BUTTON_SPEC)
    expect(whitespace.failures.some((failure) => failure.includes("whitespace") || failure.includes("args"))).toBe(true)
  })

  test("exact tag matching refuses substrings and marker laundering", () => {
    const frame = renderStory({ component: "Button", args: { label: "Save" } })
    expect(playAssertionsFor({ component: "utton", args: { label: "Save" } })[0]!(frame).ok).toBe(false)
    expect(playAssertionsFor({ component: "Button", args: { label: "Save" } })[0]!(frame).ok).toBe(true)

    const linkedFrame = renderStory({ component: "Button", args: { label: "Save" } }, BUTTON_SPEC)
    expect(linkedFrame).toContain("<!--web:<button")
    const lowered = playAssertionsFor({ component: "button", args: { label: "Save" } })[0]!(linkedFrame)
    expect(lowered.ok).toBe(false)
    expect(lowered.message).toContain("outer")
  })

  test("loading requires the loading token, not the True tautology", () => {
    const { failures } = runPlay({ component: "Button", args: { variant: "default", loading: true } }, BUTTON_SPEC)
    expect(failures).toEqual([])
    const assertions = playAssertionsFor({ component: "Button", args: { loading: true } }, BUTTON_SPEC)
    const frameWithoutLoading = '<Button variant="default">x</Button><!--web:dummy--><!--tui:dummy-->'
    expect(assertions[2]!(frameWithoutLoading).ok).toBe(false)
  })

  test("visual regression compares rendered-frame hashes", () => {
    const frame = renderStory({ component: "Button", args: { label: "Save" } })
    const same = visualRegressionCheck(frame, frame)
    expect(same.equal).toBe(true)
    expect(same.hash_a).toBe(same.hash_b)

    const differs = visualRegressionCheck(frame, `${frame} `)
    expect(differs.equal).toBe(false)
    expect(differs.hash_a).not.toBe(differs.hash_b)
  })
})

describe("spec-vs-render divergence gate (d66328c TestSpecVsRender)", () => {
  const filledSlots = Object.keys(BUTTON_SPEC.slots)

  test("in sync when slots are filled, TUI coverage holds and the ref is fresh", () => {
    expect(specVsRenderCheck(BUTTON_SPEC, filledSlots, true)).toEqual([])
  })

  test("an unfilled slot diverges", () => {
    const errors = specVsRenderCheck(BUTTON_SPEC, ["label"], true)
    expect(errors.some((error) => error.includes("not filled"))).toBe(true)
    expect(errors.some((error) => error.includes("'spinner'"))).toBe(true)
  })

  test("a stale pinned webref diverges; freshness is strict true", () => {
    expect(specVsRenderCheck(BUTTON_SPEC, filledSlots, false).some((error) => error.includes("stale"))).toBe(true)
    expect(specVsRenderCheck(BUTTON_SPEC, filledSlots, "yes").some((error) => error.includes("stale"))).toBe(true)
    expect(specVsRenderCheck(BUTTON_SPEC, filledSlots, 1).some((error) => error.includes("stale"))).toBe(true)
    expect(specVsRenderCheck(BUTTON_SPEC, filledSlots, true)).toEqual([])
  })

  test("missing renderedSlots is an error, never a default pass", () => {
    const omitted = specVsRenderCheck(BUTTON_SPEC)
    expect(omitted.some((error) => error.includes("rendered_slots"))).toBe(true)
    expect(omitted.some((error) => error.includes("not filled"))).toBe(true)
    const nulled = specVsRenderCheck(BUTTON_SPEC, null, true)
    expect(nulled.some((error) => error.includes("rendered_slots"))).toBe(true)
  })

  test("TUI coverage is delegated: a missing downgrade row fails the joint gate", () => {
    const bad = { ...BUTTON_SPEC, tui_rows: BUTTON_SPEC.tui_rows.filter((row) => row.state !== "focus-trap") }
    const errors = specVsRenderCheck(bad, Object.keys(bad.slots), true)
    expect(errors.some((error) => error.includes("focus-trap"))).toBe(true)
  })

  test("a non-object spec is refused", () => {
    expect(specVsRenderCheck("evil", [], true)).toEqual(["spec must be an object"])
  })
})

describe("webref pinned snapshot (d66328c TestWebRefPin / TestF3WebrefForgeClosed)", () => {
  test("manifest is MIT and content-addressed; hashes are deterministic", () => {
    const manifest = webrefManifest()
    expect(manifest.spdx).toBe("MIT")
    expect(manifest.license).toBe("MIT")
    expect(manifest.name).toBe(WEBREF_NAME)
    expect(manifest.snapshot_hash).toBe(snapshotHash())
    expect(snapshotHash()).toBe(snapshotHash())
    expect(new TextDecoder().decode(snapshotBytes())).toBe(new TextDecoder().decode(snapshotBytes()))
    expect(verifySnapshot(manifest)).toEqual([])
  })

  test("the SPDX block carries the content hash and pin date", () => {
    expect(spdxBlock()).toContain("SPDX-License-Identifier: MIT")
    expect(spdxBlock()).toContain(`Content-SHA256: ${snapshotHash()}`)
    expect(spdxBlock()).toContain(`Pinned-On: ${WEBREF_PINNED_ON}`)
  })

  test("file and transform-group inventories are sorted and complete", () => {
    const manifest = webrefManifest()
    expect(manifest.files).toEqual(["button-variants.js", "button.html"])
    expect(manifest.transform_groups).toEqual(["android-style", "css-vars", "scss"])
    for (const group of ["css-vars", "scss", "android-style"]) {
      const detail = TRANSFORM_GROUPS[group]!
      expect(detail.platform).toBeTruthy()
      expect(detail.transforms.length).toBeGreaterThan(0)
      expect(detail.attribution).toBeTruthy()
    }
    for (const [name, content] of Object.entries(SNAPSHOT_FILES)) {
      expect(content.includes("http://"), name).toBe(false)
      expect(content.includes("https://"), name).toBe(false)
    }
  })

  test("tampering with bytes or the pinned hash is caught", () => {
    const manifest = webrefManifest()
    expect(
      verifySnapshot({ ...manifest, snapshot_hash: "0".repeat(64) }).some((error) => error.includes("mismatch")),
    ).toBe(true)
    const scripted = { ...SNAPSHOT_FILES, "button.html": `${SNAPSHOT_FILES["button.html"]}<script>alert(1)</script>\n` }
    expect(verifySnapshot(manifest, scripted).some((error) => error.includes("mismatch"))).toBe(true)
    expect(snapshotHash(scripted)).not.toBe(snapshotHash())
    // Non-string contents are structured errors, never a crash.
    expect(verifySnapshot(manifest, { "button.html": 123 }).some((error) => error.includes("must be a string"))).toBe(
      true,
    )
  })

  test("live URLs are refused, case-insensitively and protocol-relative", () => {
    const manifest = webrefManifest()
    const https = { ...SNAPSHOT_FILES, "button.html": `${SNAPSHOT_FILES["button.html"]}HTTPS://evil.com/x\n` }
    expect(verifySnapshot(manifest, https).some((error) => error.includes("live URL"))).toBe(true)
    const relative = {
      ...SNAPSHOT_FILES,
      "button-variants.js": `//evil.com/x.js\n${SNAPSHOT_FILES["button-variants.js"]}`,
    }
    expect(verifySnapshot(manifest, relative).some((error) => error.includes("live URL"))).toBe(true)
    // `// comment` (space after the slashes) is not a live URL.
    const comment = { ...SNAPSHOT_FILES, "button.html": `${SNAPSHOT_FILES["button.html"]}// comment line\n` }
    expect(verifySnapshot(webrefManifest(comment), comment)).toEqual([])
  })

  test("the rot probe leaves the vendored hash intact", () => {
    const before = snapshotHash()
    const probe = "https://example.com/rot-probe"
    expect(probe).toContain("example.com")
    expect(snapshotHash()).toBe(before)
    const rotted = { ...SNAPSHOT_FILES, "button.html": `${SNAPSHOT_FILES["button.html"]}<!-- rot -->\n` }
    expect(snapshotHash(rotted)).not.toBe(before)
  })
})

describe("webref license gate (d66328c TestLicenseGate / TestF5F6ZeroRisk / TestFixup2QAB17)", () => {
  test("the four permissive ids clear vendor and depend", () => {
    expect([...LICENSE_WHITELIST].sort()).toEqual(["Apache-2.0", "BSD-3-Clause", "ISC", "MIT"])
    for (const id of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"]) {
      expect(licenseGate(id, "vendor"), id).toEqual([])
      expect(licenseGate(id, "depend"), id).toEqual([])
    }
    expect(licenseGate("mit", "vendor")).toEqual([])
    expect(licenseGate("ISC", "skip")).toEqual([])
  })

  test("copyleft is blocked from vendor/depend/skip with a clean-room reason", () => {
    expect([...COPYLEFT_IDS]).toContain("GPL-3.0-only")
    for (const id of COPYLEFT_IDS) {
      expect(
        licenseGate(id, "vendor").some((error) => error.includes("clean-room")),
        id,
      ).toBe(true)
      expect(
        licenseGate(id, "depend").some((error) => error.includes("clean-room")),
        id,
      ).toBe(true)
      expect(
        licenseGate(id, "skip").some((error) => error.includes("clean-room")),
        id,
      ).toBe(true)
      expect(licenseGate(id, "clean-room"), id).toEqual([])
    }
  })

  test("MPL and unknown ids are refused for every action, with a reason", () => {
    expect(licenseGate("MPL-2.0", "vendor").some((error) => error.includes("unknown license"))).toBe(true)
    expect(licenseGate("MPL-2.0", "clean-room").some((error) => error.includes("unknown license"))).toBe(true)
    expect(licenseGate("EVIL", "skip").some((error) => error.includes("unknown license"))).toBe(true)
    expect(licenseGate("GPLX", "vendor")[0]).toContain("clean-room-only")
  })

  test("empty and proprietary clean-room/skip are refused; short/gibberish notes fail", () => {
    expect(licenseGate("", "clean-room")).not.toEqual([])
    expect(licenseGate("   ", "skip")).not.toEqual([])
    expect(licenseGate("PROPRIETARY", "clean-room")).not.toEqual([])
    expect(licenseGate("PROPRIETARY", "skip")).not.toEqual([])
    expect(licenseGate("MIT", "clean-room", "x")).not.toEqual([])
    expect(licenseGate("MIT", "clean-room", "xxxx xxxxx")).not.toEqual([])
    expect(
      licenseGate(
        "GPL-3.0-only",
        "clean-room",
        "GPL behavior rebuilt from spec, no bytes vendored; upstream cited by name",
      ),
    ).toEqual([])
  })

  test("semantic phrase checks refuse gibberish and accept prose", () => {
    expect(noteHasSemanticPhrase("xxxx xxxxx")).toBe(false)
    expect(noteHasSemanticPhrase("cccc dddd eeee")).toBe(false)
    expect(noteHasSemanticPhrase("short note")).toBe(false)
    expect(noteHasSemanticPhrase("GPL behavior rebuilt from spec, no bytes vendored")).toBe(true)
  })

  test("unknown actions are refused", () => {
    expect(licenseGate("MIT", "teleport")).not.toEqual([])
  })
})

describe("webref freshness (d66328c TestSnapshotFreshness / TestF3WebrefForgeClosed)", () => {
  test("age is exact at the budget boundary", () => {
    expect(WEBREF_PINNED_ON).toBe("2026-10-05")
    expect(WEBREF_MAX_AGE_DAYS).toBe(180)
    expect(snapshotAgeDays("2026-10-05")).toBe(0)
    expect(snapshotAgeDays("2027-01-01")).toBe(88)
    expect(snapshotAgeDays("2027-04-03")).toBe(180)
    expect(snapshotAgeDays("2027-04-04")).toBe(181)
    expect(snapshotAgeDays("2027-06-01")).toBe(239)
  })

  test("fresh within budget; stale beyond; a future pin is not fresh", () => {
    expect(isWebrefFresh("2026-10-05")).toBe(true)
    expect(isWebrefFresh("2027-01-01")).toBe(true)
    expect(isWebrefFresh("2027-04-03")).toBe(true)
    expect(isWebrefFresh("2027-04-04")).toBe(false)
    expect(isWebrefFresh("2027-06-01")).toBe(false)
    expect(isWebrefFresh("2026-10-04")).toBe(false)
  })

  test("a forged budget is capped to the pin", () => {
    expect(isWebrefFresh("2027-06-01", 99999)).toBe(false)
    expect(isWebrefFresh("2026-10-05", 99999)).toBe(true)
    expect(isWebrefFresh("2026-10-05", -1)).toBe(false)
  })
})

describe("TUI lowering notes (d66328c TestTuiCoverage / TestF2TuiCoverageHardened)", () => {
  test("the catalog, primitives and negative knowledge are pinned", () => {
    expect(Object.keys(CONSTRAINT_CATALOG).sort()).toEqual([
      "event-focus-routing",
      "hover",
      "keybindings",
      "motion",
      "palette-depth",
      "region-geometry",
    ])
    expect(Object.keys(WEB_ONLY_PRIMITIVES).sort()).toEqual([
      "esc-close",
      "focus-trap",
      "pointer-outside",
      "sr-announcement",
    ])
    for (const [name, row] of Object.entries(WEB_ONLY_PRIMITIVES)) {
      expect(row.web, name).toBeTruthy()
      expect(row.tui, name).toBeTruthy()
    }
    expect(NEGATIVE_KNOWLEDGE).toHaveLength(3)
    for (const note of NEGATIVE_KNOWLEDGE) expect(note).toContain("NEGATIVE_KNOWLEDGE")
    expect(EVENT_LOOP_NOTE).toContain("event loop")
  })

  test("every downgrade row is covered: removing any one fails", () => {
    expect(validateTuiCoverage({ tui_rows: tuiRows() })).toEqual([])
    for (const row of DOWNGRADE_ROWS) {
      const spec = {
        tui_rows: DOWNGRADE_ROWS.filter((item) => item.state !== row.state).map((item) => ({ ...item })),
      }
      expect(
        validateTuiCoverage(spec).some((error) => error.includes(row.state)),
        row.state,
      ).toBe(true)
    }
    expect(DOWNGRADE_ROWS.map((row) => row.state)).toContain("focus")
    expect(DOWNGRADE_ROWS.map((row) => row.state)).toContain("empty")
    expect(DOWNGRADE_ROWS.map((row) => row.state)).toContain("error")
  })

  test("missing primitives, blank lowerings and non-object specs are refused", () => {
    const noTrap = { tui_rows: tuiRows().filter((row) => row.state !== "focus-trap") }
    expect(validateTuiCoverage(noTrap).some((error) => error.includes("focus-trap"))).toBe(true)
    const noHoverFocus = { tui_rows: tuiRows().filter((row) => row.state !== "hover" && row.state !== "focus") }
    const errors = validateTuiCoverage(noHoverFocus)
    expect(errors.some((error) => error.includes("hover"))).toBe(true)
    expect(errors.some((error) => error.includes("focus"))).toBe(true)
    const blank = { tui_rows: tuiRows().map((row) => (row.state === "blur" ? { ...row, tui: "   " } : row)) }
    expect(validateTuiCoverage(blank).some((error) => error.includes("empty"))).toBe(true)
    expect(validateTuiCoverage({ tui_rows: [] })).not.toEqual([])
    expect(validateTuiCoverage("evil")).toEqual(["spec must be an object"])
  })

  test("states need rows or an explicit semantic waiver; bad waivers fail", () => {
    const covered = { tui_rows: tuiRows(), states: { hover: "x", empty: "x" } }
    expect(validateTuiCoverage(covered)).toEqual([])

    const missing = { tui_rows: tuiRows(), states: { "mystery-state": "x" } }
    expect(validateTuiCoverage(missing).some((error) => error.includes("mystery-state"))).toBe(true)

    const badReason = { tui_rows: tuiRows(), states: { "mystery-state": "x" }, tui_waivers: { "mystery-state": "x" } }
    expect(validateTuiCoverage(badReason).some((error) => error.includes("semantic") || error.includes("waiver"))).toBe(
      true,
    )

    const waived = {
      tui_rows: tuiRows(),
      states: { "mystery-state": "x" },
      tui_waivers: { "mystery-state": "button hover not applicable; explicit border row covers focus" },
    }
    expect(validateTuiCoverage(waived)).toEqual([])

    const nonDictStates = { tui_rows: tuiRows(), states: "evil" }
    expect(validateTuiCoverage(nonDictStates).some((error) => error.includes("states must be an object"))).toBe(true)

    const emptyStateMissing = {
      tui_rows: tuiRows().filter((row) => row.state !== "empty"),
      tui_waivers: { empty: "button empty is icon-only aria-label; no downgrade row applicable" },
    }
    expect(validateTuiCoverage(emptyStateMissing).some((error) => error.includes("'empty'"))).toBe(false)
  })

  test("waiver notes need a semantic phrase", () => {
    expect(waiverHasSemanticPhrase("x")).toBe(false)
    expect(waiverHasSemanticPhrase("xxxx xxxxx")).toBe(false)
    expect(waiverHasSemanticPhrase("cccc dddd eeee")).toBe(false)
    expect(waiverHasSemanticPhrase("button empty is icon-only aria-label; no downgrade row applicable")).toBe(true)
  })

  test("lowering is deterministic with a conservative fallback", () => {
    const hover = loweringFor("hover")
    expect(hover.web).toBe("pointer hover tint")
    expect(hover.tui).toBe("focus-visible border (no pointer)")
    expect(loweringFor("  HOVER ")).toEqual(hover)
    const fallback = loweringFor("mystery-state")
    expect(fallback.web).toBe("unspecified web state")
    expect(fallback.tui).toContain("fallback")
    expect(fallback.state).toBe("mystery-state")
  })

  test("renderTuiNotes is byte-stable and carries every row and note", () => {
    const notes = renderTuiNotes()
    expect(renderTuiNotes()).toBe(notes)
    expect(notes.startsWith("# TUI notes — deterministic lowering\n")).toBe(true)
    expect(notes.endsWith("required before any row may claim pixel fidelity.\n")).toBe(true)
    for (const row of DOWNGRADE_ROWS) expect(notes).toContain(`| ${row.state} | ${row.web} | ${row.tui} |`)
    for (const name of Object.keys(CONSTRAINT_CATALOG)) expect(notes).toContain(`| ${name} |`)
    for (const note of NEGATIVE_KNOWLEDGE) expect(notes).toContain(`- ${note}`)
    expect(notes).toContain("```text")
  })
})
