// Queereye: DTCG token validation, the WCAG contrast gate, the 7-axis
// interview loop (repairs, smuggling, contradiction, resume), the pure guide
// render with its drift gate, the filesystem contract and the seat-scoped
// tools.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AXES,
  aliasReuseRatio,
  aliasToVarRef,
  ContradictionError,
  checkDrift,
  compileToCssVars,
  contrastRatio,
  designPaths,
  designTools,
  ensureRatio,
  FORMS,
  findOneOffs,
  gatePairs,
  iterTokens,
  loadInterview,
  parseHex,
  probeReport,
  renderGuide,
  resolveAlias,
  resolveInside,
  SlotLoop,
  SmuggledValueError,
  saveInterview,
  VagueAnswerError,
  validatePair,
  validateTokens,
  writeArtifacts,
  writeIfChanged,
} from "../src/index.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-queereye-"))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const tree = {
  color: {
    $type: "color",
    primitive: {
      "brand-500": { $value: "#1d4ed8" },
      paper: { $value: "#ffffff" },
    },
    semantic: {
      primary: { $value: "{color.primitive.brand-500}" },
      surface: { $value: "{color.primitive.paper}" },
    },
  },
}

describe("DTCG token validation", () => {
  test("group $type is inherited; alias chains resolve to raw values", () => {
    expect(validateTokens(tree)).toEqual([])
    expect(resolveAlias(tree, "color.semantic.primary")).toBe("#1d4ed8")
    expect([...iterTokens(tree)]).toHaveLength(4)
    expect(aliasReuseRatio(tree)).toEqual({ aliased: 2, total: 4, ratio: 0.5 })
  })

  test("circular and dangling aliases are errors, never warnings", () => {
    const circular = {
      a: { $type: "color", one: { $value: "{a.two}" }, two: { $value: "{a.one}" } },
    }
    const errors = validateTokens(circular)
    expect(errors.some((error) => error.includes("circular alias chain"))).toBe(true)
    const dangling = { a: { $type: "color", one: { $value: "{a.missing}" } } }
    expect(validateTokens(dangling).some((error) => error.includes("does not resolve"))).toBe(true)
  })

  test("missing $type, unknown $ keys and mixed values are refused", () => {
    expect(validateTokens({ a: { one: { $value: "#fff" } } })[0]).toContain("missing $type")
    expect(validateTokens({ a: { $type: "color", $meta: "x", one: { $value: "#fff" } } })[0]).toContain("unknown $ key")
    const listSmuggled = validateTokens({ a: { $type: "color", list: [{ $meta: "x" }] } })
    expect(listSmuggled.some((error) => error.includes("unknown $ key"))).toBe(true)
    const mixed = validateTokens({ a: { $type: "color", one: { $value: "#fff {a.two}" }, two: { $value: "#000" } } })
    expect(mixed.some((error) => error.includes("mixed raw + alias"))).toBe(true)
    expect(validateTokens({ a: { $type: "color", one: { $value: "#fff", $description: 7 } } })[0]).toContain(
      "$description",
    )
  })

  test("one-off mints are raw values outside an allowlisted primitive path", () => {
    const tree = {
      color: {
        $type: "color",
        primitive: { "brand-500": { $value: "#1d4ed8" } },
        semantic: { bad: { $value: "#ff0000" }, good: { $value: "{color.primitive.brand-500}" } },
      },
      evil: { $type: "color", primitive: { x: { $value: "#123456" } } },
      primitive: { y: { $value: "#123456" } },
    }
    const paths = findOneOffs(tree).map((oneOff) => oneOff.path)
    expect(paths).toContain("color.semantic.bad")
    expect(paths).toContain("evil.primitive.x")
    expect(paths).toContain("primitive.y")
    expect(paths).not.toContain("color.primitive.brand-500")
  })
})

describe("contrast gate", () => {
  test("hex parsing and ratios", () => {
    expect(parseHex("#abc")).toEqual([170, 187, 204])
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5)
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5)
    expect(() => parseHex("blue")).toThrow(/not a hex color/)
  })

  test("pairs below AA fail; decorative never excuses text", () => {
    const fail = validatePair("#999999", "#ffffff")
    expect(fail.ratio).toBeLessThan(4.5)
    expect(fail.errors[0]).toContain("below AA body text")
    expect(validatePair("#999999", "#ffffff", { decorative: true }).errors).toContain(
      "decorative exemption refused for a text pair",
    )
    expect(validatePair("#595959", "#ffffff").errors).toEqual([])
    const large = validatePair("#767676", "#ffffff", { largeText: true })
    expect(large.errors).toEqual([])
  })

  test("ratio-first generation reaches the target", () => {
    const nudged = ensureRatio("#ffff00", "#ffffff", 4.5)
    expect(contrastRatio(nudged, "#ffffff")).toBeGreaterThanOrEqual(4.5)
    expect(ensureRatio("#1d4ed8", "#ffffff")).toBe("#1d4ed8")
  })

  test("probe rows carry AA, AAA and pass fields", () => {
    const rows = probeReport([
      { name: "ok", fg: "#595959", bg: "#ffffff" },
      { name: "bad", fg: "#eeeeee", bg: "#ffffff" },
    ])
    expect(rows[0]).toMatchObject({ pass: true, aa_threshold: 4.5, aaa_enhanced: 7 })
    expect(rows[1]?.pass).toBe(false)
    expect(gatePairs([{ name: "bad", fg: "#eeeeee", bg: "#ffffff" }])).toHaveLength(1)
  })
})

describe("the interview loop", () => {
  test("axes run in order and every form is complete-able by skipping", () => {
    const loop = new SlotLoop()
    expect(AXES).toEqual(["brand", "color", "type", "layout", "effects", "dark_light", "a11y"])
    const first = loop.nextRequiredSlot()
    expect(first).toMatchObject({ axis: "brand", slot: "name" })
    for (const axis of AXES) for (const slot of FORMS[axis].requiredSlots) loop.skip(axis, slot)
    expect(loop.isComplete()).toBe(true)
    expect(loop.nextRequiredSlot()).toBeUndefined()
  })

  test("vague answers raise counter-questions; valid short answers do not", () => {
    const loop = new SlotLoop()
    expect(() => loop.submit("brand", "name", "whatever")).toThrow(VagueAnswerError)
    try {
      loop.submit("brand", "name", "?")
    } catch (error) {
      expect((error as VagueAnswerError).counterQuestion).toContain("Please")
    }
    loop.submit("layout", "grid", "8")
    loop.submit("a11y", "reduced_motion", "yes")
    expect(loop.effective("layout", "grid")).toBe("8")
  })

  test("skip words default a slot; unknown slots are refused", () => {
    const loop = new SlotLoop()
    loop.submit("brand", "voice", "skip")
    expect(loop.skipped.brand.has("voice")).toBe(true)
    expect(loop.effective("brand", "voice")).toBe("minimal")
    expect(() => loop.skip("brand", "nope")).toThrow(/unknown slot/)
  })

  test("pasted raw values are smuggling attempts", () => {
    const loop = new SlotLoop()
    expect(() => loop.submit("brand", "values", 'clarity and "#1d4ed8"')).toThrow(SmuggledValueError)
    expect(() => loop.submit("brand", "values", 'use "Inter" as the face')).toThrow(SmuggledValueError)
    expect(() => loop.submit("color", "primary", "#ff0000")).toThrow(SmuggledValueError)
  })

  test("repair hooks refuse unknown options and unsafe decoration", () => {
    const loop = new SlotLoop()
    expect(() => loop.submit("color", "primary", "magenta")).toThrow(ContradictionError)
    expect(() => loop.submit("type", "scale", "2.0")).toThrow(/unknown modular scale/)
    expect(() => loop.submit("effects", "decoration", "yes")).toThrow(/text-safe-only/)
    expect(() => loop.submit("a11y", "text_level", "none")).toThrow(/below AA is rejected/)
  })

  test("contradictions are repaired, not agreed with", () => {
    const a = new SlotLoop()
    expect(() => a.submit("brand", "values", "faint, subtle gray on white")).toThrow(ContradictionError)
    const b = new SlotLoop()
    b.submit("a11y", "text_level", "AA")
    expect(() => b.submit("brand", "values", "low contrast, barely visible")).toThrow(/low contrast/)
    // The cross-axis guard also covers state that predates the repair hook.
    const c = new SlotLoop()
    c.values.brand.set("values", "low contrast warmth")
    expect(() => c.submit("a11y", "text_level", "AAA")).toThrow(/contradiction with settled brand values/)
  })

  test("a completed interview emits a valid token tree with zero one-offs and passing pairs", () => {
    const loop = new SlotLoop()
    for (const axis of AXES) for (const slot of FORMS[axis].requiredSlots) loop.skip(axis, slot)
    const tokens = loop.toTokens()
    expect(validateTokens(tokens)).toEqual([])
    expect(findOneOffs(tokens)).toEqual([])
    expect(gatePairs(loop.probePairs())).toEqual([])
    expect(aliasReuseRatio(tokens).ratio).toBeGreaterThan(0.3)
  })

  test("AAA targets nudge the palette to 7:1; accent=none omits the accent pair", () => {
    const loop = new SlotLoop()
    loop.submit("a11y", "text_level", "AAA")
    loop.submit("color", "accent", "none")
    for (const axis of AXES)
      for (const slot of FORMS[axis].requiredSlots)
        if (!loop.values[axis].has(slot) && !loop.skipped[axis].has(slot)) loop.skip(axis, slot)
    const probes = loop.probePairs()
    expect(probes.map((pair) => pair.name)).not.toContain("accent large on paper")
    const body = probes.find((pair) => pair.name === "body on paper")!
    expect(contrastRatio(body.fg, body.bg)).toBeGreaterThanOrEqual(7)
    expect(gatePairs(probes)).toEqual([])
  })
})

describe("render and drift", () => {
  test("CSS vars compile deterministically; mixed values throw", () => {
    const css = compileToCssVars(tree)
    expect(css).toContain("--color-semantic-primary: var(--color-primitive-brand-500);")
    expect(css).toContain("--color-primitive-brand-500: #1d4ed8;")
    expect(compileToCssVars(tree)).toBe(css)
    expect(aliasToVarRef("{a.b}")).toBe("var(--a-b)")
    expect(() => aliasToVarRef("#fff {a.b}")).toThrow(/mixed raw \+ alias/)
  })

  test("the guide is a pure render; drift fails checkDrift", async () => {
    const loop = new SlotLoop()
    for (const axis of AXES) for (const slot of FORMS[axis].requiredSlots) loop.skip(axis, slot)
    const tokens = loop.toTokens()
    const probes = probeReport(loop.probePairs())
    const guide = renderGuide(tokens, probes)
    expect(renderGuide(tokens, probes)).toBe(guide)
    expect(guide).toContain("| body on paper |")
    expect(guide).toContain("One-off raw tokens outside primitive: 0")
    await writeArtifacts(root, { tokens, probes, guide, css: compileToCssVars(tokens) })
    expect((await checkDrift(root)).drifted).toEqual([])
    await writeFile(designPaths(root).guide, `${guide}\nhand edit`)
    expect((await checkDrift(root)).drifted).toEqual(["STYLE_GUIDE.md"])
  })
})

describe("the filesystem contract", () => {
  test("writes outside .factory/design are refused", () => {
    expect(resolveInside(root, "tokens.json")).toContain(path.join(".factory", "design"))
    expect(() => resolveInside(root, "../outside.json")).toThrow(/outside/)
    expect(() => resolveInside(root, "/tmp/absolute.json")).toThrow(/outside/)
  })

  test("writes are idempotent; user-owned files are backed up, never overwritten", async () => {
    const file = designPaths(root).guide
    expect((await writeIfChanged(file, "one")).wrote).toBe(true)
    expect((await writeIfChanged(file, "one")).wrote).toBe(false)
    const outcome = await writeIfChanged(file, "two", { userOwned: true })
    expect(outcome.wrote).toBe(false)
    expect(outcome.note).toContain("user-customized")
    expect(await readFile(file, "utf8")).toBe("one")
    expect(await readFile(outcome.backup!, "utf8")).toBe("one")
  })

  test("the interview resumes from disk after a kill", async () => {
    const first = new SlotLoop()
    first.submit("brand", "name", "Acme")
    first.submit("brand", "voice", "minimal")
    await saveInterview(root, first)
    const resumed = new SlotLoop()
    expect(await loadInterview(root, resumed)).toBe(true)
    expect(Object.fromEntries(resumed.values.brand)).toMatchObject({ name: "Acme", voice: "minimal" })
    expect(resumed.nextRequiredSlot()).toMatchObject({ axis: "brand", slot: "values" })
  })

  test("corrupt interview.json raises an actionable error", async () => {
    await mkdir(path.dirname(designPaths(root).interview), { recursive: true })
    await writeFile(designPaths(root).interview, "{not json")
    await expect(loadInterview(root, new SlotLoop())).rejects.toThrow(/corrupt interview.json.*restart/)
  })
})

describe("the design tools", () => {
  const tools = () => designTools({ root })
  const call = (name: string, input: Record<string, unknown>, agent: string) =>
    tools()
      .find((tool) => tool.name === name)!
      .execute(input, { agent })

  test("seats are enforced", async () => {
    await expect(call("es_design_status", {}, "es-programmer")).rejects.toThrow(/designer seat/)
    await expect(call("es_design_complete", {}, "brainstormer")).rejects.toThrow(/designer seat/)
  })

  test("answers, repairs, completion and drift through the tools", async () => {
    const repaired = await call(
      "es_design_answer",
      { axis: "brand", name: "x", slot: "name", value: "idk" },
      "designer",
    )
    expect(repaired).toContain("Not accepted (vague)")
    const smuggled = await call("es_design_answer", { axis: "color", slot: "primary", value: "#ff0000" }, "designer")
    expect(smuggled).toContain("Not accepted (smuggled)")

    await expect(call("es_design_complete", {}, "designer")).rejects.toThrow(/incomplete/)

    for (const axis of AXES)
      for (const slot of FORMS[axis].requiredSlots) await call("es_design_skip", { axis, slot }, "designer")
    const completed = await call("es_design_complete", {}, "designer")
    expect(completed).toContain("reuse ratio")
    expect(await readFile(designPaths(root).guide, "utf8")).toContain("STYLE_GUIDE")
    const check = await call("es_design_check", {}, "designer")
    expect(check).toContain("byte-match")
    expect(check).toContain("One-off mints: 0")
  })
})
