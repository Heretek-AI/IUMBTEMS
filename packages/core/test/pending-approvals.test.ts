// Concurrent approval requests must not lost-update pending-approvals.json (#219).
import { describe, expect, test } from "bun:test"
import { Factory } from "../src/factory/index.ts"
import { pendingApprovals } from "../src/factory/pending.ts"
import { esTools } from "../src/ops/tools.ts"
import { type Fixture, frontier, gitRepo, writeSpecs } from "./helpers.ts"

describe("pending approvals under concurrency (#219)", () => {
  test("two concurrent approval requests for different stages keep both entries", async () => {
    const fx: Fixture = await gitRepo("es-pending-")
    try {
      const factory = new Factory(fx.root, {
        gates: async () => ({ passed: true, findings: [], summary: "green" }),
        stateDir: fx.state,
      })
      await factory.begin("human:tester")
      await factory.writeFrontier("grill", frontier())
      await writeSpecs(fx.root, ["alpha"])
      const tools = esTools({ root: fx.root, factory, stateDir: fx.state })
      const request = tools.find((tool) => tool.name === "es_request_approval")!
      // Repeat the race several times: without a lock, the read-modify-write
      // interleaves and one stage's entry is lost.
      for (let round = 0; round < 8; round++) {
        const { writeJson } = await import("../src/util/fs.ts")
        const { factoryLayout } = await import("../src/layout.ts")
        await writeJson(factoryLayout(fx.root).pending, [])
        await Promise.all([
          request.execute({ stage: "frontier", note: `r${round}` }, { agent: "factory" }),
          request.execute({ stage: "spec", note: `r${round}` }, { agent: "factory" }),
        ])
        const pending = await pendingApprovals(fx.root)
        expect(pending.map((item) => item.stage).sort()).toEqual(["frontier", "spec"])
      }
    } finally {
      await fx.cleanup()
    }
  })
})
