// Audit proofs for the heterogeneous multi-model policy (#335, built in #170).
//
// The five bypass vectors from #170's close comment, each exercised through
// the real host surface — a real git repo driven to SPEC, then a real
// `Factory.startBuild` (the same call the plugin, `es mcp` and the seat
// guard all funnel into). Plus the MCP wiring: `createMcpServer`
// (packages/cli/src/mcp.ts) passes its `models` option into the Factory, so
// a same-provider pair is refused on the MCP path exactly when the config
// was readable — replicated here through `es_build_start`, the tool the MCP
// `tools/call` envelope dispatches to.
import { describe, expect, test } from "bun:test"
import { assertModelDiversity, type SeatModelMap } from "../src/agents/models.ts"
import { recordApproval } from "../src/approval/index.ts"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { Factory, FactoryError } from "../src/factory/index.ts"
import { esTools } from "../src/ops/tools.ts"
import type { Fixture } from "./helpers.ts"
import { frontier, gitRepo, writeReport, writeSpecs } from "./helpers.ts"

const PASSPHRASE = "test-passphrase-1234"

// The five bypass vectors from #170's close comment.
const VECTORS: Readonly<Record<string, SeatModelMap>> = {
  // 1. Same provider, different model names: still shared weights.
  "same-provider-different-model": { programmer: "anthropic/claude-a", qa: "anthropic/claude-b" },
  // 2. One colliding QA seat is enough (the other QA seat is clean).
  "qa-seat-collision": {
    programmer: "anthropic/x",
    agents: { "es-qa-adversarial": "anthropic/y", "es-qa-functional": "google/z" },
  },
  // 3. A per-agent override cannot launder a collision through a clean role key.
  "agents-override-laundering": {
    programmer: "anthropic/x",
    qa: "google/y",
    agents: { "es-programmer": "google/sneaky" },
  },
  // 4. Provider comparison is case-insensitive.
  "case-insensitivity": { programmer: "Anthropic/x", qa: "anthropic/y" },
  // 5. A shared tier fallback resolves both sides to one provider.
  "tier-fallback": { balanced: "acme/base" },
}

async function toSpec(models: SeatModelMap | undefined): Promise<{ fx: Fixture; factory: Factory }> {
  const fx: Fixture = await gitRepo("es-audit-diversity-")
  await sealHumanKey(PASSPHRASE, fx.state)
  const signer: HumanSigner = await unlockHumanKey(PASSPHRASE, fx.state)
  const factory = new Factory(fx.root, {
    gates: (async () => ({ passed: true, findings: [], summary: "green" })) as never,
    stateDir: fx.state,
    ...(models ? { models } : {}),
  })
  await factory.begin("human:tester")
  await factory.writeFrontier("grill", frontier())
  await recordApproval(fx.root, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
  await factory.beginResearch("human:tester")
  await writeReport(fx.root, fx.state)
  await factory.completeResearch("factory")
  await writeSpecs(fx.root, ["alpha"])
  await recordApproval(fx.root, { stage: "spec", channel: "cli", approvedBy: "tester", signer })
  return { fx, factory }
}

describe("audit #335: bypass vectors refused at build start (real host)", () => {
  for (const [name, models] of Object.entries(VECTORS)) {
    test(`${name}: startBuild refuses before any branch moves`, async () => {
      const { fx, factory } = await toSpec(models)
      try {
        // The unit guard agrees with the host guard (same function the
        // plugin seat-launch guard calls).
        expect(() => assertModelDiversity(models)).toThrow(/same model provider/)
        await expect(factory.startBuild("factory")).rejects.toThrow(FactoryError)
        await expect(factory.startBuild("factory")).rejects.toThrow(/same model provider/)
        const state = await factory.read()
        expect(state?.stage).toBe("SPEC")
      } finally {
        await fx.cleanup()
      }
    })
  }
})

describe("audit #335: MCP path (models wired through, as in cli/src/mcp.ts)", () => {
  test("es_build_start through an MCP-wired factory refuses a same-provider pair", async () => {
    // createMcpServer passes options.models into `new Factory(...)`; when the
    // CLI resolved the config, that is the effective models map. Replicate
    // that wiring and dispatch the tool the MCP envelope calls.
    const { fx, factory } = await toSpec({ programmer: "anthropic/x", qa: "anthropic/y" })
    try {
      const tools = esTools({ root: fx.root, factory, stateDir: fx.state })
      const buildStart = tools.find((tool) => tool.name === "es_build_start")!
      await expect(buildStart.execute({}, { agent: "factory" })).rejects.toThrow(/same model provider/)
      const state = await factory.read()
      expect(state?.stage).toBe("SPEC")
    } finally {
      await fx.cleanup()
    }
  })

  test("unreadable config skips the MCP check (best-effort gap, candidate for the Director)", async () => {
    // cli/src/main.ts `es mcp`: `loadEsConfig(...).catch(() => undefined)` —
    // no models, no check. The Factory default (models undefined) is
    // `unverified`, which starts the build.
    const { fx, factory } = await toSpec(undefined)
    try {
      const state = await factory.startBuild("factory")
      expect(state.stage).toBe("BUILD")
    } finally {
      await fx.cleanup()
    }
  })
})
