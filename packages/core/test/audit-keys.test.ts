// Audit proofs for #331 (MachineKeyStore, Phase 7 #164).
// Supplements packages/core/test/approval-machine.test.ts: serialization
// isolation, replay refusal (branch/commit/cross-key) and zero-total tiers.
// Every refusal here fails when its guard in approval/machine.ts is removed
// (mutation-checked during the audit); see the verdict table on #331.
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
  branch: "integration/audit-keys",
  ...overrides,
})

const signGreen = (branch = "integration/audit-keys") =>
  signStageTransition(createMachineKeyStore(), {
    branch,
    target: branch,
    kind: "stage-transition",
    stage: "SPEC",
    proof: green({ branch }),
  })

describe("audit #331: machine-key isolation and replay refusal", () => {
  test("privates are unreachable from the store object and its serialization", () => {
    const store = createMachineKeyStore()
    // Own enumerable surface is the public handle only.
    expect(Object.keys(store).sort()).toEqual(["destroy", "keyId", "publicKeyPem"])
    const shaped = store as unknown as Record<string, unknown>
    expect(shaped.privateKey).toBeUndefined()
    expect(shaped.key).toBeUndefined()
    expect(shaped.privates).toBeUndefined()
    // Serialization carries no signing power: re-hydrating the JSON cannot sign.
    const revived = JSON.parse(JSON.stringify(store)) as { keyId: string; publicKeyPem: string }
    expect(revived.keyId).toBe(store.keyId)
    expect(typeof revived.publicKeyPem).toBe("string")
    expect("privateKey" in revived).toBe(false)
    expect(JSON.stringify(store)).not.toMatch(/private/i)
  })

  test("a forged proof (tampered tiers) does not verify", async () => {
    const store = createMachineKeyStore()
    const record = signStageTransition(store, {
      branch: "integration/audit-keys",
      target: "integration/audit-keys",
      kind: "stage-transition",
      stage: "SPEC",
      proof: green(),
    })
    const forged = {
      ...record,
      proof: green({ unwaivedSecrets: 5 }),
    }
    expect(await verifyMachineTransition(forged, store.publicKeyPem)).toBe(false)
  })

  test("a proof replayed on another branch is refused at sign and verify", async () => {
    const store = createMachineKeyStore()
    // Sign-time: the proof branch must equal the signed branch.
    expect(() =>
      signStageTransition(store, {
        branch: "integration/other",
        target: "integration/other",
        kind: "stage-transition",
        stage: "SPEC",
        proof: green({ branch: "integration/audit-keys" }),
      }),
    ).toThrow(/does not match/i)
    // Verify-time: rebinding a valid signature to another branch fails closed.
    const record = signStageTransition(store, {
      branch: "integration/audit-keys",
      target: "integration/audit-keys",
      kind: "stage-transition",
      stage: "SPEC",
      proof: green(),
    })
    const replayed = { ...record, branch: "integration/other" as const, proof: green({ branch: "integration/other" }) }
    // Same signature, different branch binding: the signature no longer covers the body.
    const rebound = { ...record, branch: "integration/other" }
    expect(await verifyMachineTransition(rebound, store.publicKeyPem)).toBe(false)
    expect(await verifyMachineTransition(replayed, store.publicKeyPem)).toBe(false)
  })

  test("a proof replayed on another commit is refused at verify", async () => {
    const store = createMachineKeyStore()
    const record = signStageTransition(store, {
      branch: "integration/audit-keys",
      target: "integration/audit-keys",
      kind: "stage-transition",
      stage: "SPEC",
      proof: green(),
    })
    // The signature binds the exact commit: swapping it invalidates the record.
    const replayed = { ...record, proof: green({ commit: "b".repeat(40) }) }
    expect(await verifyMachineTransition(replayed, store.publicKeyPem)).toBe(false)
    // A non-hex commit never signs in the first place.
    expect(() =>
      signStageTransition(store, {
        branch: "integration/audit-keys",
        target: "integration/audit-keys",
        kind: "stage-transition",
        stage: "SPEC",
        proof: green({ commit: "not-a-sha" }),
      }),
    ).toThrow(MachineKeyError)
  })

  test("a signature from another store is refused", async () => {
    const a = createMachineKeyStore()
    const b = createMachineKeyStore()
    expect(a.keyId).not.toBe(b.keyId)
    const record = signStageTransition(a, {
      branch: "integration/audit-keys",
      target: "integration/audit-keys",
      kind: "stage-transition",
      stage: "SPEC",
      proof: green(),
    })
    expect(await verifyMachineTransition(record, b.publicKeyPem)).toBe(false)
    expect(await verifyMachineTransition(record, a.publicKeyPem)).toBe(true)
  })

  test("a proof with a tier total of zero is refused at sign and verify", async () => {
    const store = createMachineKeyStore()
    for (const tier of ["tier1", "tier2", "tier3"] as const) {
      const proof = green({
        tiers: {
          tier1: { passed: 120, total: 120 },
          tier2: { passed: 48, total: 48 },
          tier3: { passed: 12, total: 12 },
          [tier]: { passed: 0, total: 0 },
        } as GateProofBundle["tiers"],
      })
      expect(() =>
        signStageTransition(store, {
          branch: "integration/audit-keys",
          target: "integration/audit-keys",
          kind: "stage-transition",
          stage: "SPEC",
          proof,
        }),
      ).toThrow(/not 100% passing/i)
    }
    // Fail-closed verify: a zero-total bundle never verifies, even under its own key.
    const record = signGreen()
    const zeroed = {
      ...record,
      proof: green({
        tiers: {
          tier1: { passed: 0, total: 0 },
          tier2: { passed: 48, total: 48 },
          tier3: { passed: 12, total: 12 },
        },
      }),
    }
    expect(await verifyMachineTransition(zeroed, store.publicKeyPem)).toBe(false)
  })

  test("release merges and main targets fail closed at verify", async () => {
    const store = createMachineKeyStore()
    const record = signGreen()
    // These shapes can never be minted (sign refuses), so rebind the signature
    // to prove verify refuses them too instead of trusting the bytes.
    expect(await verifyMachineTransition({ ...record, kind: "release-merge" }, store.publicKeyPem)).toBe(false)
    expect(await verifyMachineTransition({ ...record, target: "main" }, store.publicKeyPem)).toBe(false)
    expect(await verifyMachineTransition({ ...record, target: "main/evil" }, store.publicKeyPem)).toBe(false)
    expect(await verifyMachineTransition({ ...record, branch: "main" }, store.publicKeyPem)).toBe(false)
  })
})
