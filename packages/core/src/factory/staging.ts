// Autonomous staging pipeline with human release veto (#166, Phase 7).
//
// Integration branches land on `staging/autonomous` once their gate proof is
// green; the fire suites (regression + compatibility) run there; a release
// cut opens a consolidated draft PR ONLY under a human Ed25519 signature.
// The veto is a mechanism, not a promise: `openReleasePr` refuses unsigned
// cuts, and `countersignReleaseCut` refuses machine-shaped signers. A
// genuine signature is exercised by a human with the passphrase at a
// terminal — no agent path mints one.
//
// The proof shape mirrors `GateProofBundle` (#164) field-for-field, so once
// both land a machine proof passes here structurally with zero adaptation.

import { randomInt } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as Git from "../worktree/git.ts"

export class StagingError extends Error {}

/** The autonomous integration branch. Humans never commit here by hand. */
export const STAGING_BRANCH = "staging/autonomous"

/** Gate evidence a landing must carry (structural mirror of #164's GateProofBundle). */
export interface StagingGateProof {
  readonly tiers: {
    readonly tier1: { readonly passed: number; readonly total: number }
    readonly tier2: { readonly passed: number; readonly total: number }
    readonly tier3: { readonly passed: number; readonly total: number }
  }
  readonly unwaivedSecrets: number
  readonly unwaivedVulnerabilities: number
  readonly specsVerified: boolean
  readonly schemasVerified: boolean
  readonly commit: string
  readonly branch: string
}

/** Every way a landing proof can fail the green bar, in audit order. */
export function stagingProofProblems(proof: StagingGateProof): string[] {
  const problems: string[] = []
  for (const tier of ["tier1", "tier2", "tier3"] as const) {
    const result = proof.tiers[tier]
    if (!result || result.total <= 0 || result.passed !== result.total)
      problems.push(`${tier} is not 100% passing (passed ${result?.passed ?? "?"} of ${result?.total ?? "?"})`)
  }
  if (proof.unwaivedSecrets > 0) problems.push(`${proof.unwaivedSecrets} un-waived secret(s)`)
  if (proof.unwaivedVulnerabilities > 0)
    problems.push(`${proof.unwaivedVulnerabilities} un-waived dependency vulnerability(ies)`)
  if (!proof.specsVerified) problems.push("spec hashes are not verified")
  if (!proof.schemasVerified) problems.push("schema hashes are not verified")
  if (!/^[0-9a-f]{40}$/.test(proof.commit)) problems.push("proof commit is not a 40-hex SHA")
  return problems
}

export interface LandOptions {
  /** Integration branch to land (proof.branch must equal this). */
  readonly branch: string
  readonly proof: StagingGateProof
  /** Post-merge verification in the merged tree. Defaults to marker/JSON sanity. */
  readonly runTests?: (dir: string) => Promise<boolean>
  /**
   * AST-aware conflict resolution, e.g. #165's resolveConflict. Without one,
   * a conflicting landing fails and staging stays untouched.
   */
  readonly resolveConflict?: (file: string, oursText: string, theirsText: string) => string | undefined
  readonly scratchDir?: string
}

export interface LandResult {
  readonly ok: boolean
  readonly previousSha?: string
  readonly newSha?: string
  readonly reason?: string
}

const IDENTITY = ["-c", "user.name=Epistemic Swarm", "-c", "user.email=factory@epistemic-swarm.local"] as const

const unmerged = async (dir: string): Promise<string[]> => {
  const status = (await Git.git(dir, ["status", "--porcelain=v1", "-uall"])).stdout
  return status
    .split("\n")
    .filter((line) => line.startsWith("UU "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
}

/**
 * Land `branch` on staging/autonomous: merge in a scratch worktree, run
 * tests, and move the staging ref only on green. Staging is never touched
 * before the verdict, so failures leave it exactly as found.
 */
export async function landOnStaging(root: string, options: LandOptions): Promise<LandResult> {
  if (options.proof.branch !== options.branch)
    return { ok: false, reason: `proof branch "${options.proof.branch}" does not match "${options.branch}"` }
  const problems = stagingProofProblems(options.proof)
  if (problems.length) return { ok: false, reason: `gate proof is not green: ${problems.join("; ")}` }
  const tip = await Git.revParse(root, options.branch)
  if (tip !== options.proof.commit)
    return { ok: false, reason: `proof commit ${options.proof.commit} is not the branch tip ${tip}` }
  const stagingExists = await Git.branchExists(root, STAGING_BRANCH)
  const previousSha = stagingExists ? await Git.revParse(root, STAGING_BRANCH) : undefined
  const scratch = await mkdtemp(path.join(options.scratchDir ?? tmpdir(), "es-staging-"))
  const worktree = path.join(scratch, "tree")
  const fail = async (reason: string): Promise<LandResult> => {
    await Git.removeWorktree(root, worktree).catch(() => undefined)
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, ...(previousSha ? { previousSha } : {}), reason }
  }
  try {
    await Git.git(root, [
      "worktree",
      "add",
      "-B",
      `es-staging-scratch-${Date.now()}-${randomInt(1_000_000)}`,
      worktree,
      stagingExists ? STAGING_BRANCH : options.branch,
    ])
    if (stagingExists) {
      const merged = await mergeBranchIntoStaging(worktree, options.branch, options.resolveConflict)
      if ("reason" in merged) return fail(merged.reason)
    }
    const newTip = await Git.headCommit(worktree)
    // Default verification: the merge settled (no unmerged paths) and is
    // whitespace-clean. Full gate suites inject via `runTests`.
    const runTests =
      options.runTests ??
      (async (dir: string) => {
        if ((await unmerged(dir)).length) return false
        return (await Git.git(dir, ["diff", "--check", newTip], { allowFail: true })).code === 0
      })
    if (!(await runTests(worktree))) return fail("post-merge tests failed: staging stays untouched")
    await Git.setBranch(root, STAGING_BRANCH, newTip)
    await Git.removeWorktree(root, worktree)
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    return { ok: true, ...(previousSha ? { previousSha } : {}), newSha: newTip }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** Read both merge stages for every conflicted file in parallel. */
async function readMergeStages(
  worktree: string,
  files: readonly string[],
): Promise<Array<{ readonly file: string; readonly ours: string; readonly theirs: string } | undefined>> {
  return Promise.all(
    files.map(async (file) => {
      const [ours, theirs] = await Promise.all([
        Git.git(worktree, ["show", `:2:${file}`], { allowFail: true }),
        Git.git(worktree, ["show", `:3:${file}`], { allowFail: true }),
      ])
      if (ours.code !== 0 || theirs.code !== 0) return undefined
      return { file, ours: ours.stdout, theirs: theirs.stdout }
    }),
  )
}

/** Resolve every conflicted file with the injected resolver and commit. */
async function resolveMergeConflicts(
  worktree: string,
  files: readonly string[],
  resolveConflict: (file: string, oursText: string, theirsText: string) => string | undefined,
): Promise<{ done: true } | { reason: string }> {
  const stages = await readMergeStages(worktree, files)
  const merged = new Map<string, string>()
  for (let i = 0; i < files.length; i++) {
    const stage = stages[i]
    if (!stage) return { reason: `conflicting landing in ${files[i]}: stages unreadable` }
    const resolved = resolveConflict(stage.file, stage.ours, stage.theirs)
    if (resolved === undefined) return { reason: `conflicting landing in ${stage.file}: resolver declined` }
    merged.set(stage.file, resolved)
  }
  // Independent files resolve concurrently; each write+stage pair is ordered within its file.
  await Promise.all(
    [...merged].map(async ([file, text]) => {
      await writeFile(path.join(worktree, file), text)
      await Git.git(worktree, ["add", "--", file])
    }),
  )
  const committed = await Git.git(worktree, [...IDENTITY, "-c", "core.editor=true", "commit", "--no-edit"], {
    allowFail: true,
  })
  if (committed.code !== 0 || (await unmerged(worktree)).length)
    return { reason: `conflict resolution did not settle: ${(committed.stderr || committed.stdout).trim()}` }
  return { done: true }
}

/**
 * Merge `branch` into the staging checkout. Returns `{ merged: true }` on a
 * clean merge, or a human-readable reason when it conflicts or fails.
 */
async function mergeBranchIntoStaging(
  worktree: string,
  branch: string,
  resolveConflict?: (file: string, oursText: string, theirsText: string) => string | undefined,
): Promise<{ merged: true } | { reason: string }> {
  const merged = await Git.git(
    worktree,
    [...IDENTITY, "-c", "core.editor=true", "merge", "--no-ff", "--no-edit", branch],
    {
      allowFail: true,
    },
  )
  if (merged.code === 0) return { merged: true }
  const uu = await unmerged(worktree)
  if (!uu.length) return { reason: `merge of ${branch} failed: ${(merged.stderr || merged.stdout).trim()}` }
  if (!resolveConflict) return { reason: `conflicting landing in ${uu.join(", ")} with no resolver: rebase by hand` }
  const settled = await resolveMergeConflicts(worktree, uu, resolveConflict)
  if ("reason" in settled) return settled
  return { merged: true }
}

export interface StagingFireSuite {
  /** Suite name ("regression" and "compatibility" are the standard pair). */
  readonly name: string
  readonly run: (dir: string) => Promise<{ readonly passed: boolean; readonly details?: string }>
}

export interface StagingReport {
  readonly ok: boolean
  readonly ref: string
  readonly sha: string
  readonly suites: ReadonlyArray<{ readonly name: string; readonly passed: boolean; readonly details?: string }>
}

/** Run the fire suites against staging/autonomous (read-only: staging never moves). */
export async function runStagingSuites(
  root: string,
  options: { readonly suites: readonly StagingFireSuite[]; readonly ref?: string; readonly scratchDir?: string },
): Promise<StagingReport> {
  const ref = options.ref ?? STAGING_BRANCH
  const sha = await Git.revParse(root, ref)
  // One detached checkout per suite: suites observe the same SHA in
  // parallel without sharing a working tree (no cross-suite interference).
  const runOne = async (
    suite: StagingFireSuite,
    index: number,
  ): Promise<{ readonly name: string; readonly passed: boolean; readonly details?: string }> => {
    const scratch = await mkdtemp(path.join(options.scratchDir ?? tmpdir(), `es-suite-${index}-`))
    const worktree = path.join(scratch, "tree")
    try {
      await Git.git(root, ["worktree", "add", "--detach", worktree, ref])
      const outcome = await suite.run(worktree)
      return { name: suite.name, passed: outcome.passed, ...(outcome.details ? { details: outcome.details } : {}) }
    } finally {
      await Git.removeWorktree(root, worktree).catch(() => undefined)
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  const suites = await Promise.all(options.suites.map((suite, index) => runOne(suite, index)))
  return { ok: suites.every((s) => s.passed), ref, sha, suites }
}

export interface ReleaseCut {
  readonly title: string
  readonly body: string
  readonly head: typeof STAGING_BRANCH
  /** Release targets stay human-governed: main (or legacy rewrite). */
  readonly base: "main" | "rewrite"
  /** The veto: true until a human Ed25519 signature lands. */
  readonly requiresHumanSignature: true
  readonly signed: boolean
  readonly signature?: { readonly alg: "ed25519"; readonly keyId: string; readonly sig: string }
  readonly signedBy?: string
}

/** Cut a consolidated release from staging. The cut is UNSIGNED: opening a PR requires countersigning. */
export function cutRelease(input: {
  readonly title: string
  readonly body: string
  readonly base?: "main" | "rewrite"
}): ReleaseCut {
  return {
    title: input.title,
    body: input.body,
    head: STAGING_BRANCH,
    base: input.base ?? "main",
    requiresHumanSignature: true as const,
    signed: false,
  }
}

interface HumanSignerLike {
  readonly keyId: string
  sign(record: Record<string, unknown>): { readonly alg: "ed25519"; readonly keyId: string; readonly sig: string }
}

/**
 * Countersign a release cut with the HUMAN key. The signer must be the
 * passphrase-unlocked HumanSigner (has sign(), has no machine key material):
 * machine-shaped signers (publicKeyPem, kind: "machine") are refused, so no
 * agent path can exercise the veto — a human does, at a terminal.
 */
export function countersignReleaseCut(cut: ReleaseCut, signer: HumanSignerLike): ReleaseCut {
  const shape = signer as unknown as Record<string, unknown>
  // Machine-shaped signers are refused first: no agent path exercises the veto.
  if (shape !== null && typeof shape === "object" && ("publicKeyPem" in shape || shape.kind === "machine"))
    throw new StagingError("machine signers cannot countersign a release: release approval is human-only")
  if (shape === null || typeof shape !== "object" || typeof shape.sign !== "function")
    throw new StagingError("a release cut needs a human signer (this object cannot sign)")
  if (typeof shape.keyId !== "string" || !shape.keyId)
    throw new StagingError("a release cut needs a human signer with a key id")
  const unsigned = { title: cut.title, body: cut.body, head: cut.head, base: cut.base }
  const signature = (signer as HumanSignerLike).sign(unsigned)
  if (signature?.alg !== "ed25519" || typeof signature.sig !== "string" || signature.keyId !== shape.keyId)
    throw new StagingError("the human signature is malformed; the cut stays unsigned")
  return { ...cut, signed: true, signature, signedBy: `human:${String(shape.keyId)}` }
}

export interface ReleasePrOpener {
  open(request: {
    readonly title: string
    readonly body: string
    readonly head: string
    readonly base: string
  }): Promise<{
    readonly url: string
  }>
}

/**
 * Open the consolidated draft PR. THE VETO: an unsigned cut is refused —
 * there is no path from staging to main/rewrite that bypasses the human
 * signature.
 */
export async function openReleasePr(
  cut: ReleaseCut,
  opener: ReleasePrOpener,
): Promise<{ readonly url: string; readonly base: string; readonly head: string }> {
  if (!cut.signed || !cut.signature)
    throw new StagingError(
      "unsigned release cut: it needs a human signature first (countersign with the Ed25519 human key)",
    )
  const { url } = await opener.open({ title: cut.title, body: cut.body, head: cut.head, base: cut.base })
  return { url, base: cut.base, head: cut.head }
}
