// Issue #193 audit pins (bug-adjacent, behavior pinned — NOT fixed here).
//
// The defects below are tracked for the parent as bugs #266 (prototype-chain
// aliases validate clean) and #270 (vacuous QA gates: cite-gate on missing
// probes, spec-vs-render tautology). These tests pin the CURRENT behavior so
// the audit verdicts are executable; product code is intentionally untouched.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AXES,
  checkDrift,
  designPaths,
  designTools,
  FORMS,
  readProbes,
  readTokens,
  renderGuide,
  resolveAlias,
  validateTokens,
  verifyCiteGate,
} from "../src/index.ts"
import { specVsRenderCheck } from "../src/queereye/csf.ts"
import { EXEMPLARS } from "../src/queereye/specs.ts"
import { isWebrefFresh } from "../src/queereye/webref.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-audit193-"))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const call = (name: string, input: Record<string, unknown> = {}, agent = "designer") =>
  designTools({ root })
    .find((tool) => tool.name === name)!
    .execute(input, { agent })

/** Skip the whole interview through the tools so tokens.json exists. */
const completeInterview = async () => {
  for (const axis of AXES) for (const slot of FORMS[axis].requiredSlots) await call("es_design_skip", { axis, slot })
  await call("es_design_complete", {})
}

describe("audit #193 pin: prototype-chain aliases (#266 fixed)", () => {
  test("an alias through the prototype chain is refused", () => {
    const tree = {
      color: {
        $type: "color",
        primitive: { ink: { $value: "#0f172a" } },
        semantic: { evil: { $value: "{__proto__.toString}" } },
      },
    }
    // FIXED (#266): walkPath uses Object.hasOwn, so the alias cannot
    // resolve via the prototype chain and validates with a clear error.
    expect(validateTokens(tree)).toEqual([
      'color.semantic.evil: alias {__proto__.toString} does not resolve: missing "__proto__"',
    ])
    expect(() => resolveAlias(tree, "__proto__.toString")).toThrow('missing "__proto__"')
  })

  test("inherited Object members are refused as bare aliases", () => {
    for (const ref of ["toString", "valueOf"]) {
      const tree = {
        color: {
          $type: "color",
          primitive: { ink: { $value: "#0f172a" } },
          semantic: { evil: { $value: `{${ref}}` } },
        },
      }
      // FIXED (#266): same mechanism, single segment.
      expect(validateTokens(tree)).toEqual([`color.semantic.evil: alias {${ref}} does not resolve: missing "${ref}"`])
    }
  })

  test("control: a genuinely dangling alias is still refused", () => {
    const tree = {
      color: {
        $type: "color",
        primitive: { ink: { $value: "#0f172a" } },
        semantic: { evil: { $value: "{color.primitive.missing}" } },
      },
    }
    expect(validateTokens(tree).some((error) => error.includes("does not resolve"))).toBe(true)
  })
})

describe("audit #193 pin: cite-gate with deleted probes.json (#270.1 fixed)", () => {
  test("deleted probes are reported missing and the cite-gate refuses the vacuous pass", async () => {
    await completeInterview()
    await call("es_design_specs", {})
    await call("es_design_harvest", {})
    const receipt = await readFile(path.join(root, ".factory/design/cite-gate-demo.md"), "utf8")

    await rm(designPaths(root).probes, { force: true })
    expect(await readProbes(root)).toBeUndefined()
    const tokens = await readTokens(root)
    await writeFile(designPaths(root).guide, renderGuide(tokens, []))

    // FIXED (#270.1): a missing probes file is reported, not defaulted —
    // the drift gate names it and the cite-gate refuses the vacuous pass
    // instead of verifying with zero contrast pairs.
    expect(await checkDrift(root)).toEqual({ drifted: [], missing: ["probes.json"], tokenErrors: [] })
    const errors = await verifyCiteGate(receipt, root)
    expect(errors.some((error) => error.includes("probes.json is missing or empty"))).toBe(true)
    expect(errors.some((error) => error.includes("probes.json differs from the rendered output"))).toBe(true)
  })

  test("control: the receipt still binds tokens, so a stale tokens tree is refused", async () => {
    await completeInterview()
    await call("es_design_harvest", {})
    const receipt = await readFile(path.join(root, ".factory/design/cite-gate-demo.md"), "utf8")
    const tokens = (await readTokens(root)) as Record<string, unknown>
    tokens.$edited = true
    await writeFile(designPaths(root).tokens, `${JSON.stringify(tokens, null, 2)}\n`)
    expect(await verifyCiteGate(receipt, root)).toContainEqual(expect.stringContaining("stale/forged receipt refused"))
  })
})

describe("audit #193 pin: spec-vs-render check shape (#270.2)", () => {
  test("the leg CAN fail when fed actual render output", () => {
    const spec = EXEMPLARS.button as unknown as Record<string, unknown>
    const slots = Object.keys((spec.slots ?? {}) as Record<string, unknown>).sort()
    // Fed the real slot list it is green …
    expect(specVsRenderCheck(spec, slots, isWebrefFresh())).toEqual([])
    // … but a render missing slots fails the fill leg …
    const errors = specVsRenderCheck(spec, ["label"], true)
    expect(errors.some((error) => error.includes("not filled in render"))).toBe(true)
    // … and a missing render output is refused outright.
    expect(specVsRenderCheck(spec, null, true).some((error) => error.includes("must be supplied"))).toBe(true)
  })

  test("es_design_specs(check:true) feeds each spec its own slots, so the fill leg cannot fail", async () => {
    await call("es_design_specs", {})
    // FINDING (#270.2): ops.ts feeds Object.keys(spec.slots) as the
    // "render output", so every expected slot is trivially filled and the
    // tool check passes even though the leg is never exercised.
    for (const spec of Object.values(EXEMPLARS)) {
      const record = spec as unknown as Record<string, unknown>
      const ownSlots = Object.keys((record.slots ?? {}) as Record<string, unknown>).sort()
      expect(specVsRenderCheck(record, ownSlots, isWebrefFresh())).toEqual([])
    }
    expect(await call("es_design_specs", { check: true })).toContain("byte-match")
  })
})
