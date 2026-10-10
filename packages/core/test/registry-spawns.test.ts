// Registry spawn coverage (#195.2): the static precondition behind the
// live-host spawn matrix — every hidden seat has at least one allowed parent,
// every spawns entry resolves, and hidden means subagent mode.
import { describe, expect, test } from "bun:test"
import { AGENTS } from "../src/index.ts"

const byId = new Map(AGENTS.map((agent) => [agent.id, agent]))
const hidden = AGENTS.filter((agent) => agent.hidden)
const spawnersOf = (seat: string) => AGENTS.filter((agent) => agent.spawns.includes(seat)).map((agent) => agent.id)

describe("registry spawn coverage (#195)", () => {
  test("hidden seats are exactly the subagent-mode agents", () => {
    expect(hidden.map((agent) => agent.id).sort()).toEqual(
      AGENTS.filter((agent) => agent.mode === "subagent")
        .map((agent) => agent.id)
        .sort(),
    )
  })

  test("every spawns entry resolves to a registry agent; no seat spawns itself", () => {
    for (const agent of AGENTS) {
      for (const target of agent.spawns) expect([agent.id, target, byId.has(target)]).toEqual([agent.id, target, true])
      expect([agent.id, agent.spawns.includes(agent.id)]).toEqual([agent.id, false])
    }
  })

  test("every hidden seat has at least one allowed parent", () => {
    for (const seat of hidden)
      expect([seat.id, spawnersOf(seat.id).length > 0, spawnersOf(seat.id)]).toEqual([
        seat.id,
        true,
        spawnersOf(seat.id),
      ])
  })

  test("the research seats are reachable from the factory and the deep researcher; the synthesizer only from the latter", () => {
    expect(spawnersOf("es-research-alpha").sort()).toEqual(["deep-researcher", "factory"])
    expect(spawnersOf("es-research-beta").sort()).toEqual(["deep-researcher", "factory"])
    expect(spawnersOf("es-research-synthesizer")).toEqual(["deep-researcher"])
  })
})
