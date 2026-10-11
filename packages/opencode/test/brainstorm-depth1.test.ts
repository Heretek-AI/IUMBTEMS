// Callable brainstorm at depth 1, proof gaps for #191 (follow-up #269).
// Fresh host: the grill fans out two lenses itself (depth 1, foreground,
// one message), records, scores via the critic, and completes with the
// shortlist JSON — while the human's default run stays untouched (no plan,
// no ideas, no result). Lens and critic seats cannot nest a subagent call:
// their registry `spawns` are empty, so the host denies it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readIdeas, readPlan, readResult } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(import.meta.dir, "..")
const call = (name: string, args: Record<string, unknown> = {}) => `@@CALL ${name} ${JSON.stringify(args)}@@`
const delegate = (agent: string, prompt: string) => call("subagent", { agent, description: `${agent} step`, prompt })

let state: string
let h: Harness
beforeAll(async () => {
  state = await mkdtemp(path.join(tmpdir(), "es-brainstorm-depth1-"))
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

describe("brainstorm depth-1 callable (#191, #269)", () => {
  test("grill runs a 2-lens brainstorm at depth 1; the human default run is untouched", async () => {
    const run = "grill-depth1"
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

    // Depth 1: the calling primary seat fans out both lens subagents itself,
    // in the foreground, in one message.
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

    // The callable run landed under its own id; the human default run is untouched.
    expect(await readResult(h.directory, run)).toBeDefined()
    expect(await readResult(h.directory)).toBeUndefined()
    expect(await readPlan(h.directory)).toBeUndefined()
    expect(await readIdeas(h.directory)).toEqual([])
  })

  test("a lens seat cannot nest a subagent call (#269)", async () => {
    const nested = await h.run(
      call("subagent", { agent: "es-lens-scamper", description: "nested lens", prompt: "nest deeper" }),
      { agent: "es-lens-inversion" },
    )
    expect(nested.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:error"])
  })

  test("the critic seat cannot nest a subagent call (#269)", async () => {
    const nested = await h.run(
      call("subagent", { agent: "es-lens-inversion", description: "nested lens", prompt: "nest deeper" }),
      { agent: "es-brainstorm-critic" },
    )
    expect(nested.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:error"])
  })
})
