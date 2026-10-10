import { describe, expect, test } from "bun:test"
import { AGENTS, ALL_ES_TOOLS, loadPrompt, loadSkills } from "../src/index.ts"
import { sha256 } from "../src/util/hash.ts"

describe("agent assets", () => {
  test("every registry agent has a prompt whose frontmatter matches its seat", async () => {
    for (const agent of AGENTS) {
      const prompt = await loadPrompt(agent.prompt)
      expect(prompt.meta.seat).toBe(agent.seat)
      expect(prompt.body.length).toBeGreaterThan(300)
    }
  })

  test("prompts mention every tool their seat may call", async () => {
    for (const agent of AGENTS) {
      const { body } = await loadPrompt(agent.prompt)
      for (const tool of agent.tools.filter((name) => name !== "es_status" && name !== "es_gates_run"))
        expect(`${agent.id}: ${body.includes(tool)}`).toBe(`${agent.id}: true`)
    }
  })

  test("skills load and every skill referenced by an agent exists", async () => {
    const skills = await loadSkills()
    const names = skills.map((skill) => skill.name)
    for (const agent of AGENTS) for (const skill of agent.skills) expect(names).toContain(skill)
  })

  test("the deep-researcher prompt carries the coordinator flow both surfaces load", async () => {
    // The headless job (cli/jobs.ts) and /research (opencode/server.ts)
    // single-source this flow from core instead of pasting it twice.
    const { body } = await loadPrompt("deep-researcher")
    for (const marker of [
      "plan note",
      "es-research-alpha",
      "es-research-beta",
      "in parallel",
      "foreground",
      "es-research-synthesizer",
      "es_research_audit",
      "es_research_complete",
    ])
      expect(body).toContain(marker)
  })

  test("prompt snapshot: a changed prompt must bump its version", async () => {
    const snapshot = Object.fromEntries(
      await Promise.all(
        AGENTS.map(async (agent) => {
          const prompt = await loadPrompt(agent.prompt)
          return [agent.prompt, `v${prompt.meta.version}:${sha256(prompt.body).slice(0, 16)}`]
        }),
      ),
    )
    expect(snapshot).toMatchSnapshot()
  })

  test("the tool catalog is the union of seat tools", () => {
    expect(ALL_ES_TOOLS).toContain("es_complete")
    expect(ALL_ES_TOOLS).toContain("es_qa_verdict")
    expect(ALL_ES_TOOLS).not.toContain("es_approve")
  })
})
