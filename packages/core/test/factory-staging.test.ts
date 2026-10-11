// AutonomousStagingPipeline with human release veto (#166, Phase 7).
// Integration branches land on staging/autonomous on green gate proof;
// release cuts open a draft PR ONLY with a human Ed25519 signature — the
// veto is enforced in code (unsigned cuts never open; machine signers are
// refused). No test simulates a human signature: the stub signer below is a
// mechanism-shape check only, and true exercise needs the passphrase at a
// terminal.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  countersignReleaseCut,
  cutRelease,
  landOnStaging,
  openReleasePr,
  runStagingSuites,
  STAGING_BRANCH,
  type StagingGateProof,
} from "../src/factory/staging.ts"
import * as Git from "../src/worktree/git.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

let fx: Fixture
beforeEach(async () => {
  fx = await gitRepo("es-st-")
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
  branch: "integration/ticket-1",
  ...overrides,
})

const commitFile = async (file: string, text: string, message: string) => {
  await mkdir(path.dirname(path.join(fx.root, file)), { recursive: true })
  await writeFile(path.join(fx.root, file), text)
  return Git.commitAll(fx.root, message)
}

/** Commit one file and point `branch` at it, back on main. Returns the tip. */
const stageBranch = async (file: string, text: string, branch: string): Promise<string> => {
  await commitFile(file, text, branch)
  await Git.git(fx.root, ["branch", branch, "HEAD"])
  await Git.git(fx.root, ["checkout", "-q", "main"])
  return Git.revParse(fx.root, branch)
}

/** A green proof bound to `branch`'s live tip. */
const proofFor = async (branch: string): Promise<StagingGateProof> =>
  green({ branch, commit: await Git.revParse(fx.root, branch) })

/** Two tickets diverged on the same file: ticket-1 and ticket-2 both modify it. */
const conflictingPair = async (file: string, base: string, one: string, two: string) => {
  await commitFile(file, base, "base")
  await Git.git(fx.root, ["branch", "stack-base", "HEAD"])
  await commitFile(file, one, "ticket one")
  await Git.git(fx.root, ["branch", "integration/ticket-1", "HEAD"])
  await Git.git(fx.root, ["checkout", "-q", "stack-base"])
  await commitFile(file, two, "ticket two")
  await Git.git(fx.root, ["branch", "integration/ticket-2", "HEAD"])
  await Git.git(fx.root, ["checkout", "-q", "main"])
}

describe("landOnStaging", () => {
  test("a green proof lands the branch on staging/autonomous", async () => {
    const tip = await stageBranch("feat.txt", "work\n", "integration/ticket-1")
    const result = await landOnStaging(fx.root, { branch: "integration/ticket-1", proof: green({ commit: tip }) })
    expect(result.ok).toBe(true)
    expect(await Git.revParse(fx.root, STAGING_BRANCH)).toBe(tip)
    expect(result.newSha).toBe(tip)
  })

  test("a red proof never creates staging", async () => {
    await stageBranch("feat.txt", "work\n", "integration/ticket-1")
    const proof = green({
      tiers: { tier1: { passed: 1, total: 2 }, tier2: { passed: 1, total: 1 }, tier3: { passed: 1, total: 1 } },
    })
    const result = await landOnStaging(fx.root, { branch: "integration/ticket-1", proof })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/tier1/i)
    expect(await Git.branchExists(fx.root, STAGING_BRANCH)).toBe(false)
  })

  test("a proof for another branch is refused", async () => {
    await stageBranch("feat.txt", "work\n", "integration/ticket-1")
    const result = await landOnStaging(fx.root, {
      branch: "integration/ticket-1",
      proof: green({ branch: "integration/other" }),
    })
    expect(result.ok).toBe(false)
  })

  test("a second landing merges cleanly and keeps both tickets", async () => {
    const tip1 = await stageBranch("one.txt", "one\n", "integration/ticket-1")
    await Git.git(fx.root, ["reset", "-q", "--hard", "HEAD~1"])
    await stageBranch("two.txt", "two\n", "integration/ticket-2")
    const first = await landOnStaging(fx.root, { branch: "integration/ticket-1", proof: green({ commit: tip1 }) })
    expect(first.ok).toBe(true)
    const second = await landOnStaging(fx.root, {
      branch: "integration/ticket-2",
      proof: await proofFor("integration/ticket-2"),
    })
    expect(second.ok).toBe(true)
    const tree = (await Git.git(fx.root, ["ls-tree", "-r", "--name-only", STAGING_BRANCH])).stdout
    expect(tree).toContain("one.txt")
    expect(tree).toContain("two.txt")
  })

  test("a conflicting landing without a resolver fails with staging untouched", async () => {
    await conflictingPair("code.txt", "base\n", "one\n", "two\n")
    expect(
      (await landOnStaging(fx.root, { branch: "integration/ticket-1", proof: await proofFor("integration/ticket-1") }))
        .ok,
    ).toBe(true)
    const before = await Git.revParse(fx.root, STAGING_BRANCH)
    const result = await landOnStaging(fx.root, {
      branch: "integration/ticket-2",
      proof: await proofFor("integration/ticket-2"),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/conflict/i)
    expect(await Git.revParse(fx.root, STAGING_BRANCH)).toBe(before)
  })

  test("an injected resolver (e.g. #165) unblocks the conflicting landing", async () => {
    await conflictingPair("code.txt", "base\n", "one\n", "two\n")
    expect(
      (await landOnStaging(fx.root, { branch: "integration/ticket-1", proof: await proofFor("integration/ticket-1") }))
        .ok,
    ).toBe(true)
    const result = await landOnStaging(fx.root, {
      branch: "integration/ticket-2",
      proof: await proofFor("integration/ticket-2"),
      resolveConflict: () => "one and two\n",
    })
    expect(result.ok).toBe(true)
    expect((await Git.git(fx.root, ["show", `${STAGING_BRANCH}:code.txt`])).stdout).toBe("one and two\n")
  })
})

describe("runStagingSuites", () => {
  test("green suites report ok with per-suite outcomes", async () => {
    await stageBranch("feat.txt", "work\n", "integration/ticket-1")
    await landOnStaging(fx.root, { branch: "integration/ticket-1", proof: await proofFor("integration/ticket-1") })
    const report = await runStagingSuites(fx.root, {
      suites: [
        { name: "regression", run: async () => ({ passed: true, details: "142/142" }) },
        { name: "compatibility", run: async () => ({ passed: true, details: "8/8 harnesses" }) },
      ],
    })
    expect(report.ok).toBe(true)
    expect(report.suites.map((s) => s.name)).toEqual(["regression", "compatibility"])
    expect(report.sha).toBe(await Git.revParse(fx.root, STAGING_BRANCH))
  })

  test("a failing suite flips the report without moving staging", async () => {
    await stageBranch("feat.txt", "work\n", "integration/ticket-1")
    await landOnStaging(fx.root, { branch: "integration/ticket-1", proof: await proofFor("integration/ticket-1") })
    const before = await Git.revParse(fx.root, STAGING_BRANCH)
    const report = await runStagingSuites(fx.root, {
      suites: [{ name: "regression", run: async () => ({ passed: false, details: "1 failure" }) }],
    })
    expect(report.ok).toBe(false)
    expect(await Git.revParse(fx.root, STAGING_BRANCH)).toBe(before)
  })
})

describe("release cut with human veto", () => {
  test("a fresh cut is unsigned and requires a human signature", () => {
    const cut = cutRelease({ title: "Release 2.1.0", body: "Phase 7." })
    expect(cut.signed).toBe(false)
    expect(cut.requiresHumanSignature).toBe(true)
    expect(cut.head).toBe(STAGING_BRANCH)
    expect(cut.base).toBe("main")
  })

  test("an unsigned cut never opens a PR (veto enforced)", async () => {
    const cut = cutRelease({ title: "Release 2.1.0", body: "Phase 7." })
    const opened: string[] = []
    await expect(
      openReleasePr(cut, {
        open: async (request) => {
          opened.push(request.title)
          return { url: "https://example.test/pr/1" }
        },
      }),
    ).rejects.toThrow(/human signature/i)
    expect(opened).toEqual([])
  })

  test("a machine-shaped signer is refused (never simulated)", () => {
    const cut = cutRelease({ title: "Release 2.1.0", body: "Phase 7." })
    const machine = { kind: "machine", keyId: "abc", publicKeyPem: "pem" }
    expect(() => countersignReleaseCut(cut, machine as never)).toThrow(/human-only|machine/i)
  })

  test("mechanism shape: a signer object attaches a signature record (stub, NOT a human signature)", async () => {
    // MECHANISM-ONLY: this stub proves the record plumbing; a genuine human
    // signature is exercised by a human with the passphrase at a terminal.
    const cut = cutRelease({ title: "Release 2.1.0", body: "Phase 7." })
    const stub = { keyId: "stub-key", sign: () => ({ alg: "ed25519", keyId: "stub-key", sig: "stub" }) }
    const signed = countersignReleaseCut(cut, stub as never)
    expect(signed.signed).toBe(true)
    expect(signed.signature?.keyId).toBe("stub-key")
    const opened = await openReleasePr(signed, {
      open: async () => ({ url: "https://example.test/pr/1" }),
    })
    expect(opened.url).toBe("https://example.test/pr/1")
  })
})
