// Brainstorm: lens registry and plan caps, the deterministic engine (dedupe,
// ranking, diversified shortlist with a forced outlier), the seat-scoped tools
// and the artifacts they write.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { BrainstormIdea, BrainstormScore } from "../src/index.ts"
import {
  brainstormPaths,
  brainstormTools,
  buildPlan,
  collapseDuplicates,
  LENSES,
  rankIdeas,
  readIdeas,
  readPlan,
  readResult,
  readScores,
  renderBrainstorm,
  selectShortlist,
  similarity,
} from "../src/index.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-brainstorm-"))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const tools = () => brainstormTools({ root })
const call = (name: string, input: Record<string, unknown>, agent: string) => {
  const tool = tools().find((item) => item.name === name)!
  return tool.execute(input, { agent })
}
const idea = (n: number) => ({
  title: `Direction ${n}: ${["cache", "stream", "batch", "mirror", "fork", "trace"][n % 6]} mechanics`,
  text: `Idea ${n} replaces the current mechanism with ${["a cache", "a stream", "a batch job", "a mirror", "a fork", "a trace"][n % 6]} so that the outcome changes measurably. The smallest test: measure the outcome before and after on one fixture.`,
})

describe("lenses and plans", () => {
  test("eight built-in lenses with unique ids and real instructions", () => {
    expect(LENSES).toHaveLength(8)
    expect(new Set(LENSES.map((lens) => lens.id)).size).toBe(8)
    for (const lens of LENSES) {
      expect(lens.instruction.length).toBeGreaterThan(100)
      expect(lens.summary.length).toBeGreaterThan(10)
    }
  })

  test("buildPlan defaults to six lenses and clamps the caps", () => {
    const built = buildPlan({ idea: "Make onboarding instant" })
    expect(built.lenses).toHaveLength(6)
    expect(built.plan.lenses).toEqual(LENSES.slice(0, 6).map((lens) => lens.id))
    expect(built.plan.ideasPerLens).toBe(5)
    expect(built.plan.shortlistSize).toBe(7)
    expect(built.plan.dedupeThreshold).toBe(0.5)
    const clamped = buildPlan({ idea: "x" }, { ideasPerLens: 99, shortlistSize: 1 })
    expect(clamped.plan.ideasPerLens).toBe(10)
    expect(clamped.plan.shortlistSize).toBe(2)
  })

  test("an unknown lens is refused with the built-in ids", () => {
    expect(() => buildPlan({ idea: "x" }, { lenses: ["nope"] })).toThrow(/unknown lens "nope"/)
  })
})

describe("the deterministic engine", () => {
  const make = (id: string, title: string, text: string): BrainstormIdea => ({
    id,
    lens: "inversion",
    title,
    text,
    recordedAt: new Date().toISOString(),
  })

  test("similarity is high for paraphrases and low for different directions", () => {
    const a = "ship anonymous telemetry by default so nobody needs to opt in"
    expect(similarity(a, "ship anonymous telemetry by default so nobody has to opt in")).toBeGreaterThanOrEqual(0.5)
    expect(similarity(a, "replace the database with an append-only event log")).toBeLessThan(0.15)
  })

  test("duplicates collapse against the first idea of the cluster", () => {
    const ideas = [
      make(
        "b001",
        "Anonymous telemetry as the default",
        "Ship anonymous telemetry by default so users never opt in and data cannot be traced to a person.",
      ),
      make("b002", "Different", "Replace the database with an append-only event log that can be replayed."),
      make(
        "b003",
        "Anonymous telemetry by default",
        "Telemetry is anonymous by default, so users never opt in and data cannot be traced to a person.",
      ),
    ]
    const hits = collapseDuplicates(ideas, 0.55)
    expect(hits.map((hit) => hit.id)).toEqual(["b003"])
    expect(hits[0]?.duplicateOf).toBe("b001")
    expect(hits[0]!.similarity).toBeGreaterThanOrEqual(0.55)
  })

  test("ranking sorts by rubric total then id", () => {
    const ideas = [make("b001", "A", "one two three four five"), make("b002", "B", "six seven eight nine ten")]
    const score = (id: string, value: number): BrainstormScore => ({
      id,
      novelty: value,
      upside: value,
      feasibility: value,
      fit: value,
      scoredAt: new Date().toISOString(),
    })
    const scores = new Map([
      ["b001", score("b001", 3)],
      ["b002", score("b002", 4)],
    ])
    expect(rankIdeas(ideas, scores).map((item) => item.id)).toEqual(["b002", "b001"])
  })

  test("the shortlist keeps the outlier slot for the dissimilar idea", () => {
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
    expect(shortlist[0]?.id).toBe("b001")
    const outlier = shortlist.find((entry) => entry.outlier)
    expect(outlier?.id).toBe("b004")
    expect(outlier?.reason).toContain("forced outlier")
    // The near-duplicate b002 loses its slot to the dissimilar b003.
    expect(shortlist.some((entry) => entry.id === "b002")).toBe(false)
    expect(shortlist.some((entry) => entry.id === "b003")).toBe(true)
  })

  test("a single idea is not marked an outlier", () => {
    const shortlist = selectShortlist([{ id: "b001", total: 12 }], new Map([["b001", "only idea"]]), 3)
    expect(shortlist).toEqual([{ id: "b001", total: 12, outlier: false }])
  })
})

describe("the tool loop", () => {
  test("seats are enforced", async () => {
    await expect(call("es_brainstorm_plan", { idea: "x" }, "es-programmer")).rejects.toThrow(/brainstormer seat/)
    await expect(
      call("es_brainstorm_record", { lens: "inversion", ideas: [idea(1)] }, "es-programmer"),
    ).rejects.toThrow(/brainstormer seat/)
    await expect(call("es_brainstorm_score", { scores: [] }, "brainstormer")).rejects.toThrow(/brainstorm-critic seat/)
    await expect(call("es_brainstorm_complete", {}, "es-programmer")).rejects.toThrow(/brainstormer seat/)
  })

  test("plan → record → score → complete, with caps, dedupe, gaps and the outlier", async () => {
    const distinct = [
      {
        title: "Anonymous telemetry by default",
        text: "Ship anonymous telemetry by default so users never opt in and readings cannot be traced to a person.",
      },
      {
        title: "Stream partial answers early",
        text: "Stream partial results while the full answer is computed so the first useful token arrives sooner.",
      },
      {
        title: "Signed static export",
        text: "Replace the hosted service with a signed static export that runs offline and can be audited by anyone.",
      },
    ]
    const paraphrase = {
      title: "Telemetry anonymous by default",
      text: "Telemetry is anonymous by default, so users never opt in and readings cannot be traced to a person.",
    }
    const planned = await call(
      "es_brainstorm_plan",
      { idea: "Make onboarding instant", lenses: ["inversion", "scamper"] },
      "brainstormer",
    )
    expect(planned).toContain("es-lens-inversion")
    expect(await readPlan(root)).toMatchObject({ lenses: ["inversion", "scamper"], ideasPerLens: 5 })

    // Unknown lens and cap violations are refused.
    await expect(call("es_brainstorm_record", { lens: "nope", ideas: [idea(1)] }, "brainstormer")).rejects.toThrow(
      /not in this plan/,
    )
    const batch = Array.from({ length: 6 }, (_, index) => idea(index + 1))
    await expect(call("es_brainstorm_record", { lens: "inversion", ideas: batch }, "brainstormer")).rejects.toThrow(
      /exceeds the cap of 5/,
    )

    await call("es_brainstorm_record", { lens: "inversion", ideas: [distinct[0]!, distinct[1]!] }, "brainstormer")
    const recorded = await call(
      "es_brainstorm_record",
      { lens: "scamper", ideas: [distinct[2]!, paraphrase] },
      "brainstormer",
    )
    expect(recorded).toContain("duplicates")
    const ideas = await readIdeas(root)
    expect(ideas).toHaveLength(4)
    expect(ideas.filter((item) => item.duplicateOf)).toHaveLength(1)

    // The critic scores every surviving idea; duplicates and unknown ids are refused.
    const survivors = ideas.filter((item) => !item.duplicateOf)
    await expect(
      call(
        "es_brainstorm_score",
        { scores: [{ id: ideas.find((item) => item.duplicateOf)!.id, novelty: 3, upside: 3, feasibility: 3, fit: 3 }] },
        "es-brainstorm-critic",
      ),
    ).rejects.toThrow(/do not score duplicates/)
    await expect(
      call(
        "es_brainstorm_score",
        { scores: [{ id: "b999", novelty: 3, upside: 3, feasibility: 3, fit: 3 }] },
        "es-brainstorm-critic",
      ),
    ).rejects.toThrow(/Unknown idea id/)
    await expect(
      call(
        "es_brainstorm_score",
        { scores: [{ id: survivors[0]!.id, novelty: 9, upside: 3, feasibility: 3, fit: 3 }] },
        "es-brainstorm-critic",
      ),
    ).rejects.toThrow(/integer 1-5/)
    const scored = await call(
      "es_brainstorm_score",
      {
        scores: survivors.map((item, index) => ({
          id: item.id,
          novelty: 4,
          upside: 4,
          feasibility: 3,
          fit: 5,
          note: index === 0 ? "strong" : undefined,
        })),
      },
      "es-brainstorm-critic",
    )
    expect(scored).toContain("All surviving ideas are scored")

    const beforeComplete = await call("es_brainstorm_complete", {}, "brainstormer")
    expect(beforeComplete).toContain("Shortlist")

    const result = await readResult(root)
    expect(result).toBeDefined()
    expect(result!.stats).toMatchObject({ lenses: 2, ideas: 3, duplicates: 1, scored: 3 })
    expect(result!.duplicates[0]?.duplicateOf).toBe("b001")
    expect(result!.shortlist.length).toBe(3)
    expect(result!.shortlist.some((entry) => entry.outlier)).toBe(true)
    expect(result!.ranked[0]?.total).toBe(16)
    expect(renderBrainstorm(result!)).toContain("## Shortlist")
    expect(await Bun.file(brainstormPaths(root).report).text()).toContain("forced outlier")
    expect(beforeComplete).toContain("brainstorm.json")
  })

  test("complete refuses gaps unless allowPartial, and unscored survivors always", async () => {
    await call("es_brainstorm_plan", { idea: "x", lenses: ["inversion", "scamper"] }, "brainstormer")
    await call("es_brainstorm_record", { lens: "inversion", ideas: [idea(1)] }, "brainstormer")
    const gaps = await call("es_brainstorm_complete", {}, "brainstormer").catch((error: Error) => error.message)
    expect(String(gaps)).toContain("scamper")
    await expect(call("es_brainstorm_complete", { allowPartial: true }, "brainstormer")).rejects.toThrow(
      /Still unscored/,
    )
    const survivor = (await readIdeas(root)).find((item) => !item.duplicateOf)!
    await call(
      "es_brainstorm_score",
      { scores: [{ id: survivor.id, novelty: 3, upside: 3, feasibility: 3, fit: 3 }] },
      "es-brainstorm-critic",
    )
    const partial = await call("es_brainstorm_complete", { allowPartial: true }, "brainstormer")
    expect(partial).toContain("Shortlist")
    const result = await readResult(root)
    expect(result!.gaps).toEqual(["scamper"])
    expect(result!.shortlist).toHaveLength(1)
    expect(result!.shortlist[0]?.outlier).toBe(false)
  })

  test("a second plan replaces the run only with force", async () => {
    await call("es_brainstorm_plan", { idea: "first" }, "brainstormer")
    await call("es_brainstorm_record", { lens: "inversion", ideas: [idea(1)] }, "brainstormer")
    await expect(call("es_brainstorm_plan", { idea: "second" }, "brainstormer")).rejects.toThrow(/force:true/)
    await call("es_brainstorm_plan", { idea: "second", force: true, lenses: ["scamper"] }, "brainstormer")
    expect((await readPlan(root))?.brief.idea).toBe("second")
    expect(await readIdeas(root)).toEqual([])
    expect(await readScores(root)).toEqual([])
  })

  test("idea text bounds are enforced per the plan", async () => {
    await call("es_brainstorm_plan", { idea: "x", lenses: ["inversion"] }, "brainstormer")
    await expect(
      call(
        "es_brainstorm_record",
        { lens: "inversion", ideas: [{ title: "A valid title", text: "too short" }] },
        "brainstormer",
      ),
    ).rejects.toThrow(/too short/)
    await expect(
      call(
        "es_brainstorm_record",
        { lens: "inversion", ideas: [{ title: "A valid title", text: "x".repeat(700) }] },
        "brainstormer",
      ),
    ).rejects.toThrow(/exceeds 600 characters/)
  })
})
