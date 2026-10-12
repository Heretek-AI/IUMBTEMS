// Anti-Goodhart preset defaults (#347; HUMAN DECISION RECORDED: ON in the
// self-dogfood preset): the preset enables the mutation gate and requires
// programmer/QA provider diversity, while a plain install stays opt-in for
// both. Capability-matrix detail wording is proposed to the Director —
// packages/core/src/capabilities.ts is not owned here.
import { describe, expect, test } from "bun:test"
import { EsConfigSchema, GatesConfigSchema, readPreset } from "../src/index.ts"

describe("self-dogfood preset turns the anti-Goodhart gates on (#347)", () => {
  test("the preset enables the mutation gate", async () => {
    const preset = await readPreset("self-dogfood")
    const gates = GatesConfigSchema.parse(JSON.parse(preset.gates))
    expect(gates.mutation.enabled).toBe(true)
    expect(gates.mutation.threshold).toBe(0.8)
  })

  test("the preset requires programmer/QA provider diversity", async () => {
    const preset = await readPreset("self-dogfood")
    const config = EsConfigSchema.parse(JSON.parse(preset.config))
    expect(config.models?.requireDiversity).toBe(true)
  })
})

describe("plain-install defaults stay opt-in (#347)", () => {
  test("the mutation gate defaults to off", () => {
    expect(GatesConfigSchema.parse({}).mutation.enabled).toBe(false)
  })

  test("model diversity defaults to unverified (no refusal without opt-in)", () => {
    expect(EsConfigSchema.parse({}).models?.requireDiversity ?? false).toBe(false)
  })
})
