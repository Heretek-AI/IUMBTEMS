// MachineKeyStore + proof-carrying stage transitions (#164, Phase 7).
// The machine key signs GRILL/SPEC exits on topic branches ONLY when a
// GateProofBundle proves green tiers, zero un-waived findings and verified
// artifact hashes. It can never sign release merges or main updates: those
// stay human-only (Ed25519 human key + passphrase).
import { describe, expect, test } from "bun:test"
import {
  createMachineKeyStore,
  type GateProofBundle,
  MachineKeyError,
  signStageTransition,
  verifyMachineTransition,
} from "../src/approval/machine.ts"

const green = (overrides: Partial<GateProofBundle> = {}): GateProofBundle => ({
  tiers: {
    tier1: { passed: 120, total: 120 },
    tier2: { passed: 48, total: 48 },
    tier3: { passed: 12, total: 12 },
  },
  unwaivedSecrets: 0,
  unwaivedVulnerabilities: 0,
  specsVerified: true,
  schemasVerified: true,
  commit: "a".repeat(40),
  branch: "integration/phase-7-keys",
  ...overrides,
})

describe("MachineKeyStore (proof-carrying transitions)", () => {
  test("a green proof on an integration/* branch signs and verifies", async () => {
    const store = createMachineKeyStore()
    const record = signStageTransition(store, {
      branch: "integration/phase-7-keys",
      target: "integration/phase-7-keys",
      kind: "stage-transition",
      stage: "SPEC",
      proof: green(),
    })
    expect(record.keyId).toBe(store.keyId)
    expect(await verifyMachineTransition(record, store.publicKeyPem)).toBe(true)
  })

  test("a green proof on a factory/* branch signs and verifies", async () => {
    const store = createMachineKeyStore()
    const record = signStageTransition(store, {
      branch: "factory/run-1/phase-p1",
      target: "factory/run-1/integration",
      kind: "stage-transition",
      stage: "GRILL",
      proof: green({ branch: "factory/run-1/phase-p1" }),
    })
    expect(await verifyMachineTransition(record, store.publicKeyPem)).toBe(true)
  })

  test("a failing tier cannot obtain a machine approval", () => {
    const store = createMachineKeyStore()
    const proof = green({
      tiers: {
        tier1: { passed: 120, total: 120 },
        tier2: { passed: 47, total: 48 },
        tier3: { passed: 12, total: 12 },
      },
    })
    expect(() =>
      signStageTransition(store, {
        branch: "integration/x",
        target: "integration/x",
        kind: "stage-transition",
        stage: "SPEC",
        proof,
      }),
    ).toThrow(MachineKeyError)
  })

  test("an un-waived secret blocks the machine approval", () => {
    const store = createMachineKeyStore()
    expect(() =>
      signStageTransition(store, {
        branch: "integration/x",
        target: "integration/x",
        kind: "stage-transition",
        stage: "SPEC",
        proof: green({ branch: "integration/x", unwaivedSecrets: 1 }),
      }),
    ).toThrow(/secret/i)
  })

  test("an un-waived dependency vulnerability blocks the machine approval", () => {
    const store = createMachineKeyStore()
    expect(() =>
      signStageTransition(store, {
        branch: "integration/x",
        target: "integration/x",
        kind: "stage-transition",
        stage: "SPEC",
        proof: green({ branch: "integration/x", unwaivedVulnerabilities: 2 }),
      }),
    ).toThrow(/vulnerabilit/i)
  })

  test("unverified spec or schema hashes block the machine approval", () => {
    const store = createMachineKeyStore()
    const input = {
      branch: "integration/x",
      target: "integration/x",
      kind: "stage-transition",
      stage: "SPEC",
    } as const
    expect(() =>
      signStageTransition(store, { ...input, proof: green({ branch: "integration/x", specsVerified: false }) }),
    ).toThrow(MachineKeyError)
    expect(() =>
      signStageTransition(store, { ...input, proof: green({ branch: "integration/x", schemasVerified: false }) }),
    ).toThrow(MachineKeyError)
  })

  test("branches outside integration/* and factory/* are out of scope", () => {
    const store = createMachineKeyStore()
    for (const branch of ["main", "feature/shiny", "staging/autonomous", "rewrite"]) {
      expect(() =>
        signStageTransition(store, {
          branch,
          target: branch,
          kind: "stage-transition",
          stage: "SPEC",
          proof: green({ branch }),
        }),
      ).toThrow(/scope/i)
    }
  })

  test("release merges are forbidden even with a green proof", () => {
    const store = createMachineKeyStore()
    expect(() =>
      signStageTransition(store, {
        branch: "integration/x",
        target: "main",
        kind: "release-merge",
        stage: "RELEASE",
        proof: green(),
      }),
    ).toThrow(/release/i)
  })

  test("updates targeting main are forbidden even with a green proof", () => {
    const store = createMachineKeyStore()
    expect(() =>
      signStageTransition(store, {
        branch: "integration/x",
        target: "main",
        kind: "stage-transition",
        stage: "RELEASE",
        proof: green(),
      }),
    ).toThrow(/main/i)
  })

  test("a tampered record does not verify (forged proof rejected)", async () => {
    const store = createMachineKeyStore()
    const record = signStageTransition(store, {
      branch: "integration/x",
      target: "integration/x",
      kind: "stage-transition",
      stage: "SPEC",
      proof: green({ branch: "integration/x" }),
    })
    // Tamper: claim a different (failing) proof under the same signature.
    const forged = { ...record, proof: green({ unwaivedSecrets: 5 }) }
    expect(await verifyMachineTransition(forged, store.publicKeyPem)).toBe(false)
  })

  test("a record does not verify under a different machine key", async () => {
    const a = createMachineKeyStore()
    const b = createMachineKeyStore()
    const record = signStageTransition(a, {
      branch: "integration/x",
      target: "integration/x",
      kind: "stage-transition",
      stage: "SPEC",
      proof: green({ branch: "integration/x" }),
    })
    expect(await verifyMachineTransition(record, b.publicKeyPem)).toBe(false)
  })

  test("destroyed stores cannot sign again", () => {
    const store = createMachineKeyStore()
    store.destroy()
    expect(() =>
      signStageTransition(store, {
        branch: "integration/x",
        target: "integration/x",
        kind: "stage-transition",
        stage: "SPEC",
        proof: green(),
      }),
    ).toThrow(MachineKeyError)
  })
})
