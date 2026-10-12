// Audit proofs for #333 (staging pipeline + human release veto, Phase 7 #166).
// Supplements packages/core/test/factory-staging.test.ts: the distinguisher
// for machine-shaped signers, malformed look-human signers refused, and the
// green-only + off-branch landing guarantee (failing verification leaves
// staging/autonomous exactly as found).
// NOTE (BUG-CANDIDATE to Director): a well-formed look-human stub
// ({keyId, sign() -> {alg ed25519, matching keyId}}) still passes
// countersignReleaseCut — the distinguisher is shape-only (publicKeyPem /
// kind:"machine"), not a cryptographic verify against the sealed human key.
// The existing "mechanism shape" test in factory-staging.test.ts documents
// that plumbing. A genuine human signature is exercised by a human with the
// passphrase at a terminal; no agent path mints one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  countersignReleaseCut,
  cutRelease,
  landOnStaging,
  runStagingSuites,
  STAGING_BRANCH,
  type StagingGateProof,
} from "../src/factory/staging.ts"
import * as Git from "../src/worktree/git.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

let fx: Fixture
beforeEach(async () => {
  fx = await gitRepo("es-au-st-")
})
afterEach(() => fx.cleanup())

const green = (overrides: Partial<StagingGateProof> = {}): StagingGateProof => ({
  tiers: {
    tier1: { passed: 120, total: 120 },
    tier2: { passed: 48, total: 48 },
    tier3: { passed: 12, total: 12 },
  },
  unwaivedSecrets: 0,
  unwaivedVulnerabilities: 0,
  specsVerified: true,
  schemasVerified: true,
  commit: "b".repeat(40),
  branch: "integration/audit-staging",
  ...overrides,
})

const commitFile = async (file: string, text: string, message: string) => {
  await mkdir(path.dirname(path.join(fx.root, file)), { recursive: true })
  await writeFile(path.join(fx.root, file), text)
  return Git.commitAll(fx.root, message)
}

const stageBranch = async (file: string, text: string, branch: string): Promise<string> => {
  await commitFile(file, text, branch)
  await Git.git(fx.root, ["branch", branch, "HEAD"])
  await Git.git(fx.root, ["checkout", "-q", "main"])
  return Git.revParse(fx.root, branch)
}

const proofFor = async (branch: string): Promise<StagingGateProof> =>
  green({ branch, commit: await Git.revParse(fx.root, branch) })

describe("audit #333: the human release veto", () => {
  test("machine-shaped signers are refused (the distinguisher)", () => {
    const cut = cutRelease({ title: "Release 2.1.0", body: "Phase 7." })
    // Distinguisher in countersignReleaseCut (staging.ts): "publicKeyPem" in
    // shape || shape.kind === "machine" -> StagingError before sign is read.
    const withPem = { keyId: "m", publicKeyPem: "pem", sign: () => ({ alg: "ed25519", keyId: "m", sig: "s" }) }
    const withKind = { keyId: "m", kind: "machine", sign: () => ({ alg: "ed25519", keyId: "m", sig: "s" }) }
    expect(() => countersignReleaseCut(cut, withPem as never)).toThrow(/machine/i)
    expect(() => countersignReleaseCut(cut, withKind as never)).toThrow(/machine/i)
  })

  test("a look-human signer without the unlocked key is refused", () => {
    const cut = cutRelease({ title: "Release 2.1.0", body: "Phase 7." })
    // Has a human-like keyId but no sign function: cannot sign.
    expect(() => countersignReleaseCut(cut, { keyId: "human-lookalike" } as never)).toThrow(/cannot sign/i)
    // sign is not a function.
    expect(() => countersignReleaseCut(cut, { keyId: "x", sign: "not-a-function" } as never)).toThrow(/cannot sign/i)
    // Empty keyId.
    expect(() =>
      countersignReleaseCut(cut, { keyId: "", sign: () => ({ alg: "ed25519", keyId: "", sig: "s" }) } as never),
    ).toThrow(/key id/i)
    // Signature keyId does not match the signer's keyId.
    expect(() =>
      countersignReleaseCut(cut, { keyId: "x", sign: () => ({ alg: "ed25519", keyId: "y", sig: "s" }) } as never),
    ).toThrow(/malformed/i)
    // Wrong algorithm.
    expect(() =>
      countersignReleaseCut(cut, { keyId: "x", sign: () => ({ alg: "other", keyId: "x", sig: "s" }) } as never),
    ).toThrow(/malformed/i)
    // Missing signature string.
    expect(() =>
      countersignReleaseCut(cut, { keyId: "x", sign: () => ({ alg: "ed25519", keyId: "x" }) } as never),
    ).toThrow(/malformed/i)
  })

  test("a failing post-merge verification leaves staging/autonomous where it was", async () => {
    // First landing creates staging; the second (green proof, red tests)
    // must leave it untouched — staging moves only on green.
    await stageBranch("one.txt", "one\n", "integration/ticket-1")
    await Git.git(fx.root, ["reset", "-q", "--hard", "HEAD~1"])
    await stageBranch("two.txt", "two\n", "integration/ticket-2")
    const first = await landOnStaging(fx.root, {
      branch: "integration/ticket-1",
      proof: await proofFor("integration/ticket-1"),
    })
    expect(first.ok).toBe(true)
    const before = await Git.revParse(fx.root, STAGING_BRANCH)
    const failed = await landOnStaging(fx.root, {
      branch: "integration/ticket-2",
      proof: await proofFor("integration/ticket-2"),
      runTests: async () => false,
    })
    expect(failed.ok).toBe(false)
    expect(failed.reason).toMatch(/staging stays untouched/i)
    expect(await Git.revParse(fx.root, STAGING_BRANCH)).toBe(before)
    expect(failed.previousSha).toBe(before)
  })

  test("a failing verification on first landing never creates staging", async () => {
    const tip = await stageBranch("feat.txt", "work\n", "integration/ticket-1")
    const result = await landOnStaging(fx.root, {
      branch: "integration/ticket-1",
      proof: green({ branch: "integration/ticket-1", commit: tip }),
      runTests: async () => false,
    })
    expect(result.ok).toBe(false)
    expect(await Git.branchExists(fx.root, STAGING_BRANCH)).toBe(false)
  })

  test("a failing staging suite leaves staging/autonomous where it was", async () => {
    await stageBranch("feat.txt", "work\n", "integration/ticket-1")
    await landOnStaging(fx.root, { branch: "integration/ticket-1", proof: await proofFor("integration/ticket-1") })
    const before = await Git.revParse(fx.root, STAGING_BRANCH)
    // runStagingSuites is read-only by design: suites observe isolated
    // scratch checkouts, so even a red suite cannot move the ref.
    const report = await runStagingSuites(fx.root, {
      suites: [{ name: "regression", run: async () => ({ passed: false, details: "1 failure" }) }],
    })
    expect(report.ok).toBe(false)
    expect(await Git.revParse(fx.root, STAGING_BRANCH)).toBe(before)
  })
})
