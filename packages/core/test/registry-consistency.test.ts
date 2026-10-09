// Registry consistency (#101): the registry is the single source of truth,
// so the tools the factories produce, the seats the tools admit, and the
// subagent spawns must all agree with it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AGENTS,
  ALL_ES_TOOLS,
  brainstormTools,
  codeAuditTools,
  designTools,
  esTools,
  Factory,
  gateRunner,
  harvestTools,
  researchTools,
  scoutTools,
} from "../src/index.ts"

let root: string
let state: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-consistency-"))
  state = await mkdtemp(path.join(tmpdir(), "es-consistency-state-"))
})
afterEach(() => Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]))

const opsContext = () => {
  const factory = new Factory(root, { gates: gateRunner({ stateDir: state }), stateDir: state })
  return { root, factory, stateDir: state }
}
const allFactoryTools = () => [
  ...esTools(opsContext()),
  ...codeAuditTools(opsContext()),
  ...researchTools({ root, policy: async () => ({ root }), stateDir: state }),
  ...scoutTools({ root }),
  ...brainstormTools({ root }),
  ...harvestTools({ root }),
  ...designTools({ root }),
]

describe("item 1: every registry tool is produced by exactly one core factory", () => {
  test("the factory union equals ALL_ES_TOOLS, each name exactly once", () => {
    const names = allFactoryTools().map((tool) => tool.name)
    expect([...new Set(names)].sort()).toEqual([...ALL_ES_TOOLS].sort())
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
    expect(duplicates).toEqual([])
  })
})

describe("item 2: in-tool seat lists equal the registry grants", () => {
  const grantedSeats = (tool: string) => AGENTS.filter((agent) => agent.tools.includes(tool)).map((agent) => agent.seat)

  test("es_request_approval admits exactly the registry seats (factory, grill)", async () => {
    expect(grantedSeats("es_request_approval").sort()).toEqual(["factory", "grill"])
    const approval = esTools(opsContext()).find((tool) => tool.name === "es_request_approval")!
    // The manager seat is refused at the seat gate, not later at the artifacts.
    await expect(approval.execute({ stage: "frontier" }, { agent: "es-manager" })).rejects.toThrow(
      "Only the factory or grill seat may request approvals.",
    )
    // Granted seats pass the seat gate (then fail on the missing frontier).
    for (const agent of ["factory", "grill"])
      await expect(approval.execute({ stage: "frontier" }, { agent })).rejects.toThrow("Not ready for approval")
  })

  test("single-seat tools admit exactly their one registry seat", async () => {
    const probes: Array<{ tool: string; args: Record<string, unknown> }> = [
      {
        tool: "es_harvest_plan",
        args: { objective: "x", candidates: [] },
      },
    ]
    for (const { tool, args } of probes) {
      const seats = grantedSeats(tool)
      expect([tool, seats.length]).toEqual([tool, 1])
      const def = allFactoryTools().find((item) => item.name === tool)!
      await expect(def.execute(args, { agent: "factory" } as any)).rejects.toThrow(`Only the ${seats[0]} seat`)
    }
    const scoutPlan = scoutTools({ root }).find((item) => item.name === "es_scout_plan")!
    expect(grantedSeats("es_scout_plan")).toEqual(["scout"])
    await expect(scoutPlan.execute({ objective: "x", candidates: [] }, { agent: "harvester" } as any)).rejects.toThrow(
      "Only the scout seat",
    )
  })

  test("callable brainstorm tools admit exactly their registry seats (#108)", async () => {
    for (const tool of ["es_brainstorm_plan", "es_brainstorm_record", "es_brainstorm_complete"])
      expect([tool, grantedSeats(tool).sort()]).toEqual([tool, ["brainstormer", "factory", "grill"]])
    const def = allFactoryTools().find((item) => item.name === "es_brainstorm_plan")!
    await expect(def.execute({ idea: "x" }, { agent: "es-programmer" } as any)).rejects.toThrow(
      "Only the brainstormer seat",
    )
    // Granted seats pass the seat gate (the plan lands in the default run).
    for (const agent of ["grill", "factory"])
      await expect(def.execute({ idea: `from ${agent}`, force: true }, { agent } as any)).resolves.toContain(
        'run "default"',
      )
  })
})

describe("item 6: depth 1 holds because subagent seats spawn nothing", () => {
  test("every mode:subagent spec has empty spawns", () => {
    const spawners = AGENTS.filter((agent) => agent.mode === "subagent" && agent.spawns.length > 0)
    expect(spawners.map((agent) => agent.id)).toEqual([])
  })
})
