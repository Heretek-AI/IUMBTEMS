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
  findOneOffs,
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

describe("audit #193 pin: prototype-chain aliases (#266)", () => {
  test("an alias through the prototype chain validates clean today", () => {
    const tree = {
      color: {
        $type: "color",
        primitive: { ink: { $value: "#0f172a" } },
        semantic: { evil: { $value: "{__proto__.toString}" } },
      },
    }
    // FINDING (#266): the `in` operator in walkPath follows the prototype
    // chain, so this resolves to Object.prototype.toString and validates
    // with zero errors and zero one-offs.
    expect(validateTokens(tree)).toEqual([])
    expect(findOneOffs(tree)).toEqual([])
    expect(typeof resolveAlias(tree, "__proto__.toString")).toBe("function")
  })

  test("inherited Object members validate clean as bare aliases today", () => {
    for (const ref of ["toString", "valueOf"]) {
      const tree = {
        color: {
          $type: "color",
          primitive: { ink: { $value: "#0f172a" } },
          semantic: { evil: { $value: `{${ref}}` } },
        },
      }
      // FINDING (#266): same mechanism, single segment.
      expect(validateTokens(tree)).toEqual([])
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

describe("audit #193 pin: cite-gate with deleted probes.json (#270.1)", () => {
  test("deleted probes + guide re-rendered with [] verifies today", async () => {
    await completeInterview()
    await call("es_design_specs", {})
    await call("es_design_harvest", {})
    const receipt = await readFile(path.join(root, ".factory/design/cite-gate-demo.md"), "utf8")

    await rm(designPaths(root).probes, { force: true })
    expect(await readProbes(root)).toBeUndefined()
    const tokens = await readTokens(root)
    await writeFile(designPaths(root).guide, renderGuide(tokens, []))

    // FINDING (#270.1): readProbes defaults a missing file to [] (store.ts),
    // so the drift gate is green and the cite-gate verifies with zero
    // contrast pairs — the contrast QA leg is vacuous on missing probes.
    expect(await checkDrift(root)).toEqual({ drifted: [], missing: [], tokenErrors: [] })
    expect(await verifyCiteGate(receipt, root)).toEqual([])
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
