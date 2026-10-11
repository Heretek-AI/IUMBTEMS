// Heterogeneous multi-model policy, plugin side (#170): role keys drive real
// seat models (so enforcement and reality cannot diverge), and launching a
// programmer/QA seat into a same-provider collision is refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { modelFor } from "../src/agents.ts"
import { seatModelRefusal } from "../src/seats.ts"

const programmer = { id: "es-programmer", seat: "programmer", tier: "balanced" } as const
const qaFunctional = { id: "es-qa-functional", seat: "qa-functional", tier: "balanced" } as const
const qaAdversarial = { id: "es-qa-adversarial", seat: "qa-adversarial", tier: "balanced" } as const
const auditor = { id: "es-auditor-thesis", seat: "auditor-thesis", tier: "deep" } as const

describe("modelFor with role keys", () => {
  test("the programmer role key applies when no agent override or tier is set", () => {
    expect(modelFor(programmer as any, { models: { programmer: "acme/prog" } } as any)).toEqual({
      providerID: "acme",
      id: "prog",
    })
  })

  test("the qa role key applies to both QA seats", () => {
    for (const seat of [qaFunctional, qaAdversarial])
      expect(modelFor(seat as any, { models: { qa: "acme/qa" } } as any)).toEqual({ providerID: "acme", id: "qa" })
  })

  test("precedence is agent override, then role key, then tier", () => {
    expect(
      modelFor(
        programmer as any,
        {
          models: { balanced: "acme/tier", programmer: "acme/role", agents: { "es-programmer": "acme/agent" } },
        } as any,
      ),
    ).toEqual({ providerID: "acme", id: "agent" })
    expect(modelFor(programmer as any, { models: { balanced: "acme/tier", programmer: "acme/role" } } as any)).toEqual({
      providerID: "acme",
      id: "role",
    })
    expect(modelFor(programmer as any, { models: { balanced: "acme/tier" } } as any)).toEqual({
      providerID: "acme",
      id: "tier",
    })
  })

  test("the auditor role key applies to auditor seats", () => {
    expect(modelFor(auditor as any, { models: { auditor: "acme/audit" } } as any)).toEqual({
      providerID: "acme",
      id: "audit",
    })
  })
})

describe("seatModelRefusal", () => {
  test("non-build seats are never refused", () => {
    expect(seatModelRefusal("factory", { programmer: "a/x", qa: "a/y" })).toBeUndefined()
    expect(seatModelRefusal("es-manager", { programmer: "a/x", qa: "a/y" })).toBeUndefined()
  })

  test("a same-provider collision refuses programmer and QA launches", () => {
    const models = { programmer: "anthropic/x", qa: "anthropic/y" }
    expect(seatModelRefusal("es-programmer", models)).toMatch(/anthropic/)
    expect(seatModelRefusal("es-qa-functional", models)).toMatch(/anthropic/)
    expect(seatModelRefusal("es-qa-adversarial", models)).toMatch(/anthropic/)
  })

  test("diverse and unverified configs launch", () => {
    expect(seatModelRefusal("es-programmer", { programmer: "a/x", qa: "b/y" })).toBeUndefined()
    expect(seatModelRefusal("es-programmer", {})).toBeUndefined()
    expect(seatModelRefusal("es-qa-functional", undefined)).toBeUndefined()
  })

  test("requireDiversity refuses unverified launches", () => {
    expect(seatModelRefusal("es-programmer", { requireDiversity: true })).not.toBeUndefined()
  })
})

const pluginDir = path.resolve(import.meta.dir, "..")

describe("colliding seat launches are refused on the real host", () => {
  let h: Harness
  let state: string
  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-diversity-state-"))
    h = await boot({
      git: true,
      script: directiveScript,
      plugins: [
        {
          path: pluginDir,
          options: {
            stateDir: state,
            pr: "off",
            models: { programmer: "fake/scripted", qa: "fake/scripted" },
          },
        },
      ],
      files: { "README.md": "# diversity\n" },
    })
  }, 120_000)
  afterAll(async () => {
    await h?.close()
    await rm(state, { recursive: true, force: true })
  })

  test("launching a QA seat on the programmer provider is refused with remediation", async () => {
    const { tools } = await h.run(
      'go @@CALL subagent {"agent":"es-qa-functional","description":"x","prompt":"check it"}@@',
      { agent: "factory" },
    )
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["subagent:error"])
    expect(tools[0]?.text).toMatch(/same model provider/)
    expect(tools[0]?.text).toContain("models.qa")
  })
})
