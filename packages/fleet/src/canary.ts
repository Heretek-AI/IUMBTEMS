// Canary self-compilation and hot-swap harness (#176).
//
// A candidate version builds in an isolated staging sandbox, serves shadow
// jobs beside the live worker, and takes over the active symlink only when
// green — rolling back to the recorded target instantly when red.
//
// FAIL-CLOSED and HUMAN-GATED by construction:
// - The runner is OFF by default: `create` without `enabled: true` AND a
//   recorded human approval (approver + timestamp + reason) throws, so no
//   autonomous path can cut a canary.
// - The rollback mechanism is immutable: the rollback target is frozen at
//   construction, candidates built inside the rollback tree are refused, and
//   every canary write through `canaryWrite` is denied when it resolves
//   under the rollback tree, to the active link, or outside the staging
//   sandbox. Promote/rollback swap the active symlink atomically
//   (temp symlink + rename under a lock).
// - The build/spawn/shadow pipeline is an explicit seam: production wires
//   the real fleet worker spawner (a human exercise, marked at `runCanary`).
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { withLock } from "@heretek-ai/es-core"
import { FleetError } from "./lifecycle.ts"

export class CanaryError extends FleetError {
  constructor(message: string) {
    super(message)
    this.name = "CanaryError"
  }
}

/** Recorded human approval enabling one canary run. */
export interface CanaryApproval {
  readonly approver: string
  readonly signedAt: string
  readonly reason: string
}

export interface CanaryBuild {
  readonly versionDir: string
  readonly log: string
}

export interface CanaryWorker {
  readonly pid: number
  readonly endpoint: string
}

export interface ShadowResult {
  readonly pass: boolean
  readonly log: string
}

/**
 * The build/spawn/shadow pipeline. Injected so tests drive it
 * deterministically; production wires the real fleet worker spawner — a
 * human exercise, since cutting a canary spends money and swaps binaries.
 */
export interface CanaryPipeline {
  /** Build the candidate from source inside the given isolated sandbox dir. */
  readonly build: (sourceDir: string, sandboxDir: string) => Promise<CanaryBuild>
  /** Start a parallel worker running the candidate version. */
  readonly spawnWorker: (versionDir: string) => Promise<CanaryWorker>
  /** Route a shadow job to the canary worker and report green/red. */
  readonly runShadow: (worker: CanaryWorker) => Promise<ShadowResult>
}

export interface CanaryOptions {
  /** Explicit human enablement: anything but `true` refuses. */
  readonly enabled?: boolean
  readonly approval?: CanaryApproval
  /** Symlink atomically re-pointed on promote/rollback. */
  readonly activeLink: string
  /** Immutable rollback destination recorded at construction. */
  readonly rollbackTarget: string
  readonly stagingDir: string
  readonly pipeline: CanaryPipeline
}

export interface CanaryResult {
  readonly promoted: boolean
  readonly versionDir: string
  readonly log: string
  /** The recorded human approval that enabled this run (audit trail). */
  readonly approvedBy: string
}

const validApproval = (approval: CanaryApproval | undefined): approval is CanaryApproval =>
  approval !== undefined &&
  approval.approver.trim().length > 0 &&
  approval.reason.trim().length > 0 &&
  !Number.isNaN(Date.parse(approval.signedAt))

export class CanaryRunner {
  readonly enabled = true as const
  readonly activeLink: string
  readonly rollbackTarget: string
  private readonly stagingDir: string
  private readonly pipeline: CanaryPipeline
  private readonly approval: CanaryApproval

  private constructor(options: {
    activeLink: string
    rollbackTarget: string
    stagingDir: string
    pipeline: CanaryPipeline
    approval: CanaryApproval
  }) {
    this.activeLink = options.activeLink
    this.rollbackTarget = options.rollbackTarget
    this.stagingDir = options.stagingDir
    this.pipeline = options.pipeline
    this.approval = options.approval
    // Frozen: the canary cannot re-point its own rollback mechanism.
    Object.freeze(this)
  }

  /**
   * Explicit human enablement only. Anything but `enabled: true` with a
   * recorded approval (identity + timestamp + reason) throws: the canary is
   * OFF by default and no autonomous path can switch it on.
   */
  static create(options: CanaryOptions): CanaryRunner {
    if (options.enabled !== true)
      throw new CanaryError(
        "canary self-compilation is OFF by default; a human must enable it explicitly (enabled: true with a recorded approval)",
      )
    if (!validApproval(options.approval))
      throw new CanaryError("canary self-compilation needs a recorded human approval (approver, signedAt, reason)")
    if (!options.activeLink || !options.rollbackTarget || !options.stagingDir)
      throw new CanaryError("canary self-compilation needs activeLink, rollbackTarget and stagingDir")
    if (!options.pipeline)
      throw new CanaryError("canary self-compilation needs an explicit build/spawn/shadow pipeline")
    return new CanaryRunner({
      activeLink: options.activeLink,
      rollbackTarget: options.rollbackTarget,
      stagingDir: options.stagingDir,
      pipeline: options.pipeline,
      approval: options.approval,
    })
  }

  /** Atomically re-point the active symlink (temp link + rename under a lock). */
  private async pointActive(target: string): Promise<void> {
    await withLock(this.activeLink, async () => {
      const tmp = `${this.activeLink}.canary-${process.pid}`
      await mkdir(path.dirname(this.activeLink), { recursive: true })
      await rm(tmp, { force: true })
      await symlink(target, tmp)
      await rename(tmp, this.activeLink)
    })
  }

  /**
   * Guarded canary write: allowed only inside the staging sandbox, and never
   * to the rollback tree, the active link, or outside paths. The canary
   * cannot modify its own rollback mechanism. Symlink confinement: the
   * nearest existing ancestor is realpath-resolved and re-checked, so a
   * staging symlink into the rollback tree (or out of the sandbox) is
   * refused even though it resolves lexically inside staging.
   */
  async canaryWrite(file: string, content: string): Promise<void> {
    const resolved = path.resolve(file)
    const staging = `${path.resolve(this.stagingDir)}${path.sep}`
    const rollback = `${path.resolve(this.rollbackTarget)}${path.sep}`
    if (resolved === path.resolve(this.rollbackTarget) || resolved.startsWith(rollback))
      throw new CanaryError(`refusing canary write to the rollback tree: ${file}`)
    if (resolved === path.resolve(this.activeLink))
      throw new CanaryError(`refusing canary write to the active link: ${file}`)
    if (!resolved.startsWith(staging))
      throw new CanaryError(`refusing canary write outside the staging sandbox: ${file}`)
    const real = await this.realTarget(resolved)
    if (real === path.resolve(this.rollbackTarget) || real.startsWith(rollback))
      throw new CanaryError(`refusing canary write through a symlink into the rollback tree: ${file}`)
    if (real === path.resolve(this.activeLink))
      throw new CanaryError(`refusing canary write through a symlink to the active link: ${file}`)
    if (!real.startsWith(staging))
      throw new CanaryError(`refusing canary write through a symlink outside the staging sandbox: ${file}`)
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, content)
  }

  /** Realpath of the nearest existing ancestor, with the missing suffix re-attached. */
  private async realTarget(resolved: string): Promise<string> {
    let ancestor = resolved
    for (;;) {
      try {
        await lstat(ancestor)
        break
      } catch {
        const parent = path.dirname(ancestor)
        if (parent === ancestor) return resolved
        ancestor = parent
      }
    }
    let real: string
    try {
      real = await realpath(ancestor)
    } catch {
      return resolved
    }
    const suffix = path.relative(ancestor, resolved)
    return suffix ? path.join(real, suffix) : real
  }

  /**
   * Build the candidate in a fresh isolated sandbox, shadow-test it beside
   * the live worker, and promote (green) or roll back (red) atomically. A
   * candidate built inside the rollback tree is refused before anything swaps.
   */
  async runCanary(sourceDir: string): Promise<CanaryResult> {
    await mkdir(this.stagingDir, { recursive: true })
    const sandbox = await mkdtemp(path.join(this.stagingDir, "sandbox-"))
    const built = await this.pipeline.build(sourceDir, sandbox)
    const candidate = path.resolve(built.versionDir)
    const rollbackRoot = path.resolve(this.rollbackTarget)
    if (candidate === rollbackRoot || candidate.startsWith(`${rollbackRoot}${path.sep}`)) {
      await this.pointActive(this.rollbackTarget)
      throw new CanaryError(`refusing canary built inside the rollback tree: ${built.versionDir}`)
    }
    const worker = await this.pipeline.spawnWorker(candidate)
    const shadow = await this.pipeline.runShadow(worker)
    const approvedBy = `${this.approval.approver} at ${this.approval.signedAt}: ${this.approval.reason}`
    if (!shadow.pass) {
      await this.pointActive(this.rollbackTarget)
      return { promoted: false, versionDir: candidate, log: shadow.log, approvedBy }
    }
    await this.pointActive(candidate)
    return { promoted: true, versionDir: candidate, log: shadow.log, approvedBy }
  }
}

export interface CanaryCycleRequest {
  /** Explicit human enablement; anything but `enabled: true` with a recorded approval runs nothing. */
  readonly canary?: CanaryOptions | undefined
  readonly sourceDir: string
}

export type CanaryCycleOutcome = { readonly ran: false } | { readonly ran: true; readonly result: CanaryResult }

/**
 * Scheduler seam (#346): run one canary cycle when a human explicitly
 * enabled it, otherwise do nothing. Enablement reuses `CanaryRunner.create`,
 * so `enabled: true` without a recorded human approval throws fail-closed
 * before anything builds; runner semantics (sandbox build, atomic promote,
 * instant red rollback, frozen rollback target) are unchanged.
 */
export async function maybeRunCanaryCycle(request: CanaryCycleRequest): Promise<CanaryCycleOutcome> {
  const canary = request.canary
  if (canary?.enabled !== true) return { ran: false }
  const runner = CanaryRunner.create(canary)
  return { ran: true, result: await runner.runCanary(request.sourceDir) }
}
