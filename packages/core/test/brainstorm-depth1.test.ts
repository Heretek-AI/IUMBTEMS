// Brainstorm current-behavior pins for #191 (wording follow-up #263 is for
// the parent; behavior stays as is) plus the unit-level run-isolation proof
// for #269: a callable run never clobbers the human default run.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { brainstormTools, buildPlan, LENSES, readIdeas, readPlan, readResult, selectShortlist } from "../src/index.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-brainstorm-depth1-"))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const runCall = (name: string, input: Record<string, unknown>, agent: string) => {
  const tool = brainstormTools({ root }).find((item) => item.name === name)!
  return tool.execute(input, { agent })
}
const idea = (n: number) => ({
  title: `Direction ${n}: cache mechanics`,
  text: `Idea ${n} replaces the current mechanism with a cache so that the outcome changes measurably. The smallest test: measure the outcome before and after on one fixture.`,
})

describe("brainstorm current behavior (#191, #263)", () => {
  test("eight-lens registry; human default six, callable lean four", async () => {
    expect(LENSES).toHaveLength(8)
    expect(new Set(LENSES.map((lens) => lens.id)).size).toBe(8)

    const human = buildPlan({ idea: "Make onboarding instant" })
    expect(human.lenses).toHaveLength(6)
    expect(human.plan.ideasPerLens).toBe(5)
    expect(human.plan.shortlistSize).toBe(7)

    await runCall("es_brainstorm_plan", { idea: "Cheap options", run: "lean-pin" }, "grill")
    expect(await readPlan(root, "lean-pin")).toMatchObject({ ideasPerLens: 3, shortlistSize: 5 })
    expect((await readPlan(root, "lean-pin"))?.lenses).toHaveLength(4)

    await runCall("es_brainstorm_plan", { idea: "Full options", run: "full-pin" }, "brainstormer")
    expect(await readPlan(root, "full-pin")).toMatchObject({ ideasPerLens: 5, shortlistSize: 7 })
    expect((await readPlan(root, "full-pin"))?.lenses).toHaveLength(6)
  })

  test("forced outlier whenever the shortlist has >= 2 slots; never for one", () => {
    expect(selectShortlist([{ id: "b001", total: 12 }], new Map([["b001", "only idea"]]), 3)).toEqual([
      { id: "b001", total: 12, outlier: false },
    ])
    const ranked = [
      { id: "b001", total: 19 },
      { id: "b002", total: 18 },
      { id: "b003", total: 17 },
      { id: "b004", total: 12 },
    ]
    const texts = new Map([
      ["b001", "cache the responses to make repeated reads instant for every user"],
      ["b002", "cache responses so repeated reads are fast for users"],
      ["b003", "stream partial results while the full answer is computed"],
      ["b004", "replace the service with a signed static export that runs offline"],
    ])
    const shortlist = selectShortlist(ranked, texts, 3)
    expect(shortlist).toHaveLength(3)
    expect(shortlist.filter((entry) => entry.outlier)).toHaveLength(1)
    expect(shortlist.find((entry) => entry.outlier)?.reason).toContain("forced outlier")
  })
})

describe("callable runs do not clobber the default run (#191, #269)", () => {
  test("a grill run leaves the default plan, ideas and result exactly as they were", async () => {
    await runCall("es_brainstorm_plan", { idea: "human brief", lenses: ["inversion"] }, "brainstormer")
    await runCall("es_brainstorm_record", { lens: "inversion", ideas: [idea(1)] }, "brainstormer")
    const survivor = (await readIdeas(root)).find((item) => !item.duplicateOf)!
    await runCall(
      "es_brainstorm_score",
      { scores: [{ id: survivor.id, novelty: 4, upside: 4, feasibility: 4, fit: 4 }] },
      "es-brainstorm-critic",
    )
    await runCall("es_brainstorm_complete", { allowPartial: true }, "brainstormer")
    const beforePlan = JSON.stringify(await readPlan(root))
    const beforeIdeas = JSON.stringify(await readIdeas(root))
    const beforeResult = JSON.stringify(await readResult(root))
    expect(await readResult(root)).toBeDefined()

    await runCall(
      "es_brainstorm_plan",
      { idea: "grill brief", lenses: ["scamper"], ideasPerLens: 1, shortlistSize: 2, run: "grill-pin" },
      "grill",
    )
    await runCall("es_brainstorm_record", { lens: "scamper", ideas: [idea(2)], run: "grill-pin" }, "grill")
    const grillSurvivor = (await readIdeas(root, "grill-pin")).find((item) => !item.duplicateOf)!
    await runCall(
      "es_brainstorm_score",
      { scores: [{ id: grillSurvivor.id, novelty: 3, upside: 3, feasibility: 3, fit: 3 }], run: "grill-pin" },
      "es-brainstorm-critic",
    )
    await runCall("es_brainstorm_complete", { run: "grill-pin", allowPartial: true }, "grill")
    expect(await readResult(root, "grill-pin")).toBeDefined()

    expect(JSON.stringify(await readPlan(root))).toBe(beforePlan)
    expect(JSON.stringify(await readIdeas(root))).toBe(beforeIdeas)
    expect(JSON.stringify(await readResult(root))).toBe(beforeResult)
  })
})
