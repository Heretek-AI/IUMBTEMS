// Heterogeneous multi-model policy (#170): the programmer and QA seats must
// not run on the same model provider/family, or they share systematic blind
// spots. Resolved per seat (agents override > role key > tier), enforced at
// build initiation and at seat launch. Unset seats are unverified, refused
// only under models.requireDiversity.
import { describe, expect, test } from "bun:test"
import {
  assertModelDiversity,
  checkModelDiversity,
  ModelDiversityError,
  resolveSeatModels,
} from "../src/agents/models.ts"
import { recordApproval } from "../src/approval/index.ts"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { Factory, FactoryError } from "../src/factory/index.ts"
import { type Fixture, frontier, gitRepo, writeReport, writeSpecs } from "./helpers.ts"

describe("resolveSeatModels", () => {
  test("role keys resolve the programmer and both QA seats", () => {
    const resolved = resolveSeatModels({
      programmer: "anthropic/claude-3-5-sonnet",
      qa: "google/gemini-1.5-pro",
      auditor: "openai/gpt-4o",
    })
    expect(resolved["es-programmer"]).toBe("anthropic/claude-3-5-sonnet")
    expect(resolved["es-qa-functional"]).toBe("google/gemini-1.5-pro")
    expect(resolved["es-qa-adversarial"]).toBe("google/gemini-1.5-pro")
    expect(resolved["es-auditor-thesis"]).toBe("openai/gpt-4o")
    expect(resolved["es-auditor-antithesis"]).toBe("openai/gpt-4o")
  })

  test("agents overrides win over role keys, role keys win over tiers", () => {
    const resolved = resolveSeatModels({
      balanced: "acme/base",
      programmer: "acme/role",
      agents: { "es-programmer": "acme/override" },
    })
    expect(resolved["es-programmer"]).toBe("acme/override")
    // QA seats fall back to the shared balanced tier.
    expect(resolved["es-qa-functional"]).toBe("acme/base")
    expect(resolved["es-qa-adversarial"]).toBe("acme/base")
  })

  test("unset seats stay unresolved", () => {
    const resolved = resolveSeatModels({})
    expect(resolved["es-programmer"]).toBeUndefined()
    expect(resolved["es-qa-functional"]).toBeUndefined()
  })
})

describe("checkModelDiversity", () => {
  test("different providers are diverse", () => {
    const check = checkModelDiversity({ programmer: "anthropic/claude-3-5-sonnet", qa: "google/gemini-1.5-pro" })
    expect(check.status).toBe("diverse")
  })

  test("the same provider with different models still shares blind spots", () => {
    const check = checkModelDiversity({ programmer: "anthropic/claude-a", qa: "anthropic/claude-b" })
    expect(check.status).toBe("violation")
    expect(check.detail).toMatch(/anthropic/i)
  })

  test("a shared tier fallback is a violation, not an accident", () => {
    expect(checkModelDiversity({ balanced: "acme/base" }).status).toBe("violation")
  })

  test("provider comparison is case-insensitive", () => {
    expect(checkModelDiversity({ programmer: "Anthropic/x", qa: "anthropic/y" }).status).toBe("violation")
  })

  test("one colliding QA seat is enough", () => {
    const check = checkModelDiversity({
      programmer: "anthropic/x",
      agents: { "es-qa-adversarial": "anthropic/y", "es-qa-functional": "google/z" },
    })
    expect(check.status).toBe("violation")
  })

  test("an agents override cannot launder a collision through the role key", () => {
    const check = checkModelDiversity({
      programmer: "anthropic/x",
      qa: "google/y",
      agents: { "es-programmer": "google/sneaky" },
    })
    expect(check.status).toBe("violation")
  })

  test("the auditor may share the programmer provider (only QA is enforced)", () => {
    const check = checkModelDiversity({
      programmer: "anthropic/x",
      qa: "google/y",
      auditor: "anthropic/z",
    })
    expect(check.status).toBe("diverse")
  })

  test("unset seats are unverified, not diverse", () => {
    expect(checkModelDiversity({}).status).toBe("unverified")
    expect(checkModelDiversity({ programmer: "anthropic/x" }).status).toBe("unverified")
  })
})

describe("assertModelDiversity", () => {
  test("violations throw with remediation", () => {
    expect(() => assertModelDiversity({ programmer: "anthropic/x", qa: "anthropic/y" })).toThrow(ModelDiversityError)
    expect(() => assertModelDiversity({ programmer: "anthropic/x", qa: "anthropic/y" })).toThrow(
      /models\.(programmer|qa)/,
    )
  })

  test("diverse configs pass silently", () => {
    expect(() => assertModelDiversity({ programmer: "anthropic/x", qa: "google/y" })).not.toThrow()
    expect(() => assertModelDiversity(undefined)).not.toThrow()
  })

  test("unverified configs pass unless requireDiversity is set", () => {
    expect(() => assertModelDiversity({})).not.toThrow()
    expect(() => assertModelDiversity({}, { requireDiversity: true })).toThrow(ModelDiversityError)
    expect(() => assertModelDiversity({ requireDiversity: true })).toThrow(ModelDiversityError)
    expect(() =>
      assertModelDiversity({ programmer: "anthropic/x", qa: "google/y", requireDiversity: true }),
    ).not.toThrow()
  })
})

describe("build initiation refuses shared weights", () => {
  const PASSPHRASE = "test-passphrase-1234"

  const toSpec = async (models: ConstructorParameters<typeof Factory>[1]["models"]) => {
    const fx: Fixture = await gitRepo("es-diversity-")
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

  test("a same-provider programmer/QA refuses startBuild before any branch moves", async () => {
    const { fx, factory } = await toSpec({ programmer: "anthropic/x", qa: "anthropic/y" })
    try {
      await expect(factory.startBuild("factory")).rejects.toThrow(FactoryError)
      await expect(factory.startBuild("factory")).rejects.toThrow(/same model provider/)
      const state = await factory.read()
      expect(state?.stage).toBe("SPEC")
    } finally {
      await fx.cleanup()
    }
  })

  test("diverse providers and unset models start the build", async () => {
    for (const models of [{ programmer: "anthropic/x", qa: "google/y" }, undefined, {}] as const) {
      const { fx, factory } = await toSpec(models)
      try {
        const state = await factory.startBuild("factory")
        expect(state.stage).toBe("BUILD")
      } finally {
        await fx.cleanup()
      }
    }
  })

  test("requireDiversity refuses unverified builds", async () => {
    const { fx, factory } = await toSpec({ requireDiversity: true })
    try {
      await expect(factory.startBuild("factory")).rejects.toThrow(/unproven|diversity/)
    } finally {
      await fx.cleanup()
    }
  })
})
