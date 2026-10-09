// Brainstorm on the real host: the brainstormer seat plans, records and
// completes; the critic (and only the critic) scores; the grill and the
// factory run callable brainstorms at depth 1; artifacts land under
// .factory/brainstorm/runs/<run>/ (the human's /brainstorm is "default").
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readIdeas, readPlan, readResult } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness, lastAgentRequest } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const delegate = (agent: string, prompt: string) => call("subagent", { agent, description: `${agent} step`, prompt })

let state: string
let h: Harness
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-brainstorm-host-"))
  h = await boot({
    git: true,
    script: directiveScript,
    plugins: [{ path: pluginDir, options: { stateDir: state, pr: "off" } }],
    files: { "README.md": "# b\n" },
  })
}, 60_000)

afterAll(async () => {
  await h?.close()
  await rm(state, { recursive: true, force: true })
})

describe("brainstorm on the real host", () => {
  test("only the brainstormer seat is advertised the brainstorm tools", async () => {
    await h.run("hello")
    const plain = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(plain).not.toContain("es_brainstorm_plan")
    expect(plain).not.toContain("es_brainstorm_score")
    await h.run("hello", { agent: "brainstormer" })
    const tools = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(tools).toContain("es_brainstorm_plan")
    expect(tools).toContain("es_brainstorm_record")
    expect(tools).toContain("es_brainstorm_complete")
    expect(tools).not.toContain("es_brainstorm_score")
    // The grill is advertised the callable tools (but never the critic's).
    await h.run("hello", { agent: "grill" })
    const grill = (lastAgentRequest(h.llm.requests)?.tools ?? []).map((tool) => tool.function.name)
    expect(grill).toContain("es_brainstorm_plan")
    expect(grill).toContain("es_brainstorm_record")
    expect(grill).toContain("es_brainstorm_complete")
    expect(grill).not.toContain("es_brainstorm_score")
  })

  test("plan → record → critic scores → complete, with artifacts on disk", async () => {
    const planned = await h.run(
      call("es_brainstorm_plan", { idea: "Make onboarding instant", lenses: ["inversion"] }),
      { agent: "brainstormer" },
    )
    expect(planned.tools[0]?.status).toBe("completed")
    expect(planned.tools[0]?.text).toContain("es-lens-inversion")

    const recorded = await h.run(
      call("es_brainstorm_record", {
        lens: "inversion",
        ideas: [
          {
            title: "Instant sandbox on first visit",
            text: "Every new visitor gets a disposable sandbox with sample data before any sign-up, so value arrives in seconds.",
          },
        ],
      }),
      { agent: "brainstormer" },
    )
    expect(recorded.tools[0]?.status).toBe("completed")
    expect((await readIdeas(h.directory)).length).toBe(1)

    // The brainstormer cannot score; the critic seat can.
    const wrongSeat = await h.run(
      call("es_brainstorm_score", { scores: [{ id: "b001", novelty: 4, upside: 4, feasibility: 4, fit: 4 }] }),
      { agent: "brainstormer" },
    )
    expect(wrongSeat.tools[0]?.status).toBe("error")

    const scored = await h.run(
      call("es_brainstorm_score", { scores: [{ id: "b001", novelty: 4, upside: 4, feasibility: 4, fit: 5 }] }),
      { agent: "es-brainstorm-critic" },
    )
    expect(scored.tools[0]?.status).toBe("completed")
    expect(scored.tools[0]?.text).toContain("17/20")

    const completed = await h.run(call("es_brainstorm_complete"), { agent: "brainstormer" })
    expect(completed.tools[0]?.status).toBe("completed")
    expect(completed.tools[0]?.text).toContain("Shortlist")

    expect((await readPlan(h.directory))?.lenses).toEqual(["inversion"])
    const result = await readResult(h.directory)
    expect(result?.shortlist).toHaveLength(1)
    expect(result?.ranked[0]).toEqual({ id: "b001", total: 17 })
    expect(await Bun.file(path.join(h.directory, ".factory/brainstorm/runs/default/BRAINSTORM.md")).exists()).toBe(true)
  })

  test("a lens subagent cannot record, and the critic cannot complete", async () => {
    const lens = await h.run(
      call("es_brainstorm_record", {
        lens: "inversion",
        ideas: [{ title: "Nope", text: "Nope nope nope nope nope nope nope nope." }],
      }),
      { agent: "es-lens-inversion" },
    )
    expect(lens.tools[0]?.status).toBe("error")
    const critic = await h.run(call("es_brainstorm_complete"), { agent: "es-brainstorm-critic" })
    expect(critic.tools[0]?.status).toBe("error")
  })

  test("#108: the grill runs a 2-lens brainstorm at depth 1 and gets the shortlist JSON", async () => {
    const run = "grill-fanout"
    const planned = await h.run(
      call("es_brainstorm_plan", {
        idea: "Make onboarding instant",
        lenses: ["inversion", "scamper"],
        ideasPerLens: 1,
        shortlistSize: 2,
        run,
      }),
      { agent: "grill" },
    )
    expect(planned.tools[0]?.status).toBe("completed")
    expect(planned.tools[0]?.text).toContain(`run "${run}"`)

    // Fan-out: both lens subagents launched in one message, in the foreground.
    const fanout = await h.run(
      `@@PARALLEL@@ ${delegate("es-lens-inversion", "Diverge on instant onboarding: inversion lens, one idea.")} ${delegate("es-lens-scamper", "Diverge on instant onboarding: scamper lens, one idea.")}`,
      { agent: "grill" },
    )
    expect(fanout.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual([
      "subagent:completed",
      "subagent:completed",
    ])

    for (const [lens, title, text] of [
      [
        "inversion",
        "Delete onboarding entirely",
        "Remove every onboarding step and let the product configure itself from the first user action, so there is nothing to complete and nothing to abandon.",
      ],
      [
        "scamper",
        "Substitute the tutorial with a live template",
        "Swap the click-through tutorial for a working project template the visitor already owns, so learning happens inside real usage instead of a sandbox.",
      ],
    ] as const) {
      const recorded = await h.run(call("es_brainstorm_record", { lens, ideas: [{ title, text }], run }), {
        agent: "grill",
      })
      expect(recorded.tools[0]?.status).toBe("completed")
    }

    // Only the critic scores, through its own seat.
    const scored = await h.run(
      delegate(
        "es-brainstorm-critic",
        `Score the surviving ideas @@CHILD es_brainstorm_score {"run":"${run}","scores":[{"id":"b001","novelty":4,"upside":4,"feasibility":4,"fit":4},{"id":"b002","novelty":4,"upside":4,"feasibility":4,"fit":4}]}@@ done`,
      ),
      { agent: "grill" },
    )
    expect(scored.tools[0]?.status).toBe("completed")

    const completed = await h.run(call("es_brainstorm_complete", { run }), { agent: "grill" })
    expect(completed.tools[0]?.status).toBe("completed")
    const json = /--- shortlist \(JSON\) ---\n(\{[\s\S]*\})[\s]*$/.exec(completed.tools[0]?.text ?? "")?.[1]
    expect(json).toBeDefined()
    const parsed = JSON.parse(json!) as { run: string; shortlist: Array<{ id: string; outlier: boolean }> }
    expect(parsed.run).toBe(run)
    expect(parsed.shortlist.map((entry) => entry.id).sort()).toEqual(["b001", "b002"])
    // The human's default run is untouched by the grill's run.
    expect(await readResult(h.directory, run)).toBeDefined()
  })
})
