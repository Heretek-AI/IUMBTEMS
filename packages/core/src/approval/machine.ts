// Machine key delegation for autonomous stage transitions (#164, Phase 7).
//
// The human key stays the only signer for release merges and `main` updates:
// those need the passphrase the human alone knows. The machine key below may
// sign GRILL/SPEC exits on topic branches (`integration/*`, `factory/*`)
// ONLY when the attached GateProofBundle proves all of:
//   - 100% passing Tier 1-3 tests,
//   - zero un-waived secrets and zero un-waived dependency vulnerabilities,
//   - verified hash integrity of specs and schemas.
// A forged or failing proof never mints a signature (adversarial tests in
// test/approval-machine.test.ts); verification re-checks scope, target and
// proof, so tampering after signing fails closed.
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto"
import { canonicalJson } from "../util/hash.ts"

export class MachineKeyError extends Error {}

/** Pass counts for one gate tier. Green means passed === total with total > 0. */
export interface TierResult {
  readonly passed: number
  readonly total: number
}

/** Cryptographic gate evidence a machine-signed transition must carry. */
export interface GateProofBundle {
  readonly tiers: { readonly tier1: TierResult; readonly tier2: TierResult; readonly tier3: TierResult }
  readonly unwaivedSecrets: number
  readonly unwaivedVulnerabilities: number
  readonly specsVerified: boolean
  readonly schemasVerified: boolean
  /** 40-hex commit the tiers ran against. */
  readonly commit: string
  /** Branch the tiers ran on (must equal the signed branch). */
  readonly branch: string
}

export type MachineTransitionKind = "stage-transition" | "release-merge"

export interface SignStageTransitionInput {
  /** Branch being signed (must be integration/* or factory/*). */
  readonly branch: string
  /** Branch the transition lands onto (never main). */
  readonly target: string
  readonly kind: MachineTransitionKind
  readonly stage: string
  readonly proof: GateProofBundle
}

export interface MachineTransitionApproval {
  readonly version: 1
  readonly alg: "ed25519"
  readonly keyId: string
  readonly branch: string
  readonly target: string
  readonly kind: MachineTransitionKind
  readonly stage: string
  readonly proof: GateProofBundle
  readonly signedAt: string
  readonly signature: { readonly alg: "ed25519"; readonly keyId: string; readonly sig: string }
}

export interface MachineKeyStore {
  readonly keyId: string
  readonly publicKeyPem: string
  /** Best-effort end of use: further sign calls throw. */
  destroy(): void
}

/** Branches the machine key is scoped to. Everything else is human-only. */
const MACHINE_BRANCH = /^(integration|factory)\//
const COMMIT_HEX = /^[0-9a-f]{40}$/

/**
 * The private halves live here, keyed by store identity — never as a
 * property on the store object, so a holder of the store (or its JSON)
 * cannot extract signing power. Only this module's sign path reads them.
 */
const PRIVATES = new WeakMap<object, { key: KeyObject; destroyed: boolean }>()

const keyIdOf = (publicKey: KeyObject) =>
  createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16)

/** Create an in-memory machine key pair (never sealed: it holds no human authority). */
export function createMachineKeyStore(): MachineKeyStore {
  const pair = generateKeyPairSync("ed25519")
  const keyId = keyIdOf(pair.publicKey)
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  const slot = { key: pair.privateKey, destroyed: false }
  const store: MachineKeyStore = {
    keyId,
    publicKeyPem,
    destroy: () => {
      slot.destroyed = true
    },
  }
  PRIVATES.set(store, slot)
  return store
}

const privateOf = (store: MachineKeyStore): KeyObject => {
  const slot = PRIVATES.get(store)
  if (!slot || slot.destroyed) throw new MachineKeyError("the machine key was destroyed; create a new store")
  return slot.key
}

/** Every way a proof bundle can fail the machine-signing bar, in audit order. */
export function proofProblems(proof: GateProofBundle): string[] {
  const problems: string[] = []
  for (const tier of ["tier1", "tier2", "tier3"] as const) {
    const result = proof.tiers[tier]
    if (!result || !(result.total > 0) || result.passed !== result.total)
      problems.push(`${tier} is not 100% passing (passed ${result?.passed ?? "?"} of ${result?.total ?? "?"})`)
  }
  if (proof.unwaivedSecrets > 0) problems.push(`${proof.unwaivedSecrets} un-waived secret(s)`)
  if (proof.unwaivedVulnerabilities > 0)
    problems.push(`${proof.unwaivedVulnerabilities} un-waived dependency vulnerability(ies)`)
  if (!proof.specsVerified) problems.push("spec hashes are not verified")
  if (!proof.schemasVerified) problems.push("schema hashes are not verified")
  if (!COMMIT_HEX.test(proof.commit)) problems.push("proof commit is not a 40-hex SHA")
  return problems
}

const signedBody = (record: Omit<MachineTransitionApproval, "signature">) => Buffer.from(canonicalJson(record))

/**
 * Mint a machine-signed stage transition. Throws MachineKeyError when the
 * branch is out of scope, the kind/target is human-only, the proof branch
 * disagrees with the signed branch, or the proof is anything but green.
 */
export function signStageTransition(
  store: MachineKeyStore,
  input: SignStageTransitionInput,
): MachineTransitionApproval {
  const privateKey = privateOf(store)
  if (!MACHINE_BRANCH.test(input.branch))
    throw new MachineKeyError(
      `branch "${input.branch}" is outside machine scope (integration/*, factory/*): a human must sign this transition`,
    )
  if (input.kind === "release-merge")
    throw new MachineKeyError("release merges are human-only: the machine key never signs them")
  if (input.target === "main" || input.target.startsWith("main/"))
    throw new MachineKeyError("updates targeting main are human-only: the machine key never signs them")
  if (input.proof.branch !== input.branch)
    throw new MachineKeyError(`proof branch "${input.proof.branch}" does not match the signed branch "${input.branch}"`)
  const problems = proofProblems(input.proof)
  if (problems.length) throw new MachineKeyError(`gate proof does not satisfy the machine bar: ${problems.join("; ")}`)
  const unsigned = {
    version: 1 as const,
    alg: "ed25519" as const,
    keyId: store.keyId,
    branch: input.branch,
    target: input.target,
    kind: input.kind,
    stage: input.stage,
    proof: input.proof,
    signedAt: new Date().toISOString(),
  }
  return {
    ...unsigned,
    signature: {
      alg: "ed25519",
      keyId: store.keyId,
      sig: sign(null, signedBody(unsigned), privateKey).toString("base64"),
    },
  }
}

/**
 * Verify a machine-signed transition against the machine public key. Fails
 * closed: out-of-scope branches, release merges, main targets, red proofs
 * and bad signatures all return false (verification never throws for these;
 * it throws only on a malformed key).
 */
export async function verifyMachineTransition(
  record: MachineTransitionApproval,
  publicKeyPem: string,
): Promise<boolean> {
  try {
    if (record.version !== 1 || record.signature?.alg !== "ed25519") return false
    if (!MACHINE_BRANCH.test(record.branch)) return false
    if (record.kind === "release-merge") return false
    if (record.target === "main" || record.target.startsWith("main/")) return false
    if (record.proof.branch !== record.branch) return false
    if (proofProblems(record.proof).length) return false
    const pub = createPublicKey(publicKeyPem)
    if (keyIdOf(pub) !== record.keyId || record.signature.keyId !== record.keyId) return false
    const { signature: _signature, ...unsigned } = record
    return verify(null, signedBody(unsigned), pub, Buffer.from(record.signature.sig, "base64"))
  } catch {
    return false
  }
}

/** Re-hydrate a store handle from a known public key (verify-only; cannot sign). */
export function machineKeyId(publicKeyPem: string): string {
  return keyIdOf(createPublicKey(publicKeyPem))
}
