// Atomic worktree lease manager (#160): replaces shell `flock
// .worktrees/.git_lock` coordination for human-process worktrees under
// `<root>/.worktrees/`.
//
// A lease is a JSON file at `<root>/.worktrees/.leases/<slug>.json` carrying
// the holder's pid/host, a random token, and a heartbeat timestamp.
// Acquisition creates the file with `open(O_CREAT | O_EXCL)` ("wx"), so
// exactly one racer wins even across processes; every mutation also holds
// core's advisory dir lock so `prune` and acquirers serialize. A lease is
// live while its heartbeat is fresher than its TTL (default 120s) and its
// holder is alive; otherwise any manager may reclaim it. Only the token
// holder may heartbeat or release, so a stale holder can never drop a
// reclaimer's lease. `prune` drops dead leases and force-removes registered
// git worktrees under the managed root that no live lease covers. Branches
// are never deleted by prune: abandoned work is kept reachable.
import { randomBytes } from "node:crypto"
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { atomicWrite, insideRoot, withLock } from "../util/fs.ts"
import { git, removeWorktree } from "./git.ts"

export class LeaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LeaseError"
  }
}

/** Default heartbeat TTL: a lease older than this is reclaimable. */
export const DEFAULT_LEASE_TTL_MS = 120_000

/** On-disk lease format version (bump on any incompatible change). */
export const LEASE_VERSION = 1 as const

const SLUG = /^[a-z0-9][a-z0-9-]*$/

export interface LeaseInfo {
  /** Branch the worktree is (or will be) on. */
  readonly branch: string
  /** Worktree checkout dir, inside `<root>/.worktrees/`. */
  readonly dir: string
}

export interface LeaseRecord extends LeaseInfo {
  readonly v: typeof LEASE_VERSION
  readonly slug: string
  readonly pid: number
  readonly host: string
  /** Random per-acquisition token: only the holder may heartbeat/release. */
  readonly token: string
  readonly acquiredAt: string
  readonly heartbeatAt: string
  readonly ttlMs: number
}

export interface LeaseManagerOptions {
  /** Lease file dir (default `<root>/.worktrees/.leases`). */
  readonly leaseDir?: string
  /** Heartbeat TTL in ms (default 120s). */
  readonly ttlMs?: number
  /** Clock override (tests, determinism). */
  readonly now?: () => number
}

const checkSlug = (slug: string): void => {
  if (!SLUG.test(slug) || slug.length > 64)
    throw new LeaseError(`Invalid lease ${JSON.stringify(slug)}: lowercase alphanumerics and dashes only, ≤64 chars.`)
}

const isRecord = (raw: unknown): raw is LeaseRecord => {
  if (typeof raw !== "object" || raw === null) return false
  const record = raw as Record<string, unknown>
  return (
    record.v === LEASE_VERSION &&
    typeof record.slug === "string" &&
    typeof record.pid === "number" &&
    typeof record.host === "string" &&
    typeof record.token === "string" &&
    typeof record.branch === "string" &&
    typeof record.dir === "string" &&
    typeof record.acquiredAt === "string" &&
    typeof record.heartbeatAt === "string" &&
    typeof record.ttlMs === "number"
  )
}

function holderAlive(record: LeaseRecord): boolean {
  // A foreign host's pids cannot be signalled: the heartbeat alone governs.
  if (record.host !== hostname()) return true
  try {
    process.kill(record.pid, 0)
    return true
  } catch (error: any) {
    return error?.code === "EPERM"
  }
}

/**
 * Heartbeat-based file leases over `<root>/.worktrees/`, one manager per
 * process (a manager only heartbeats/releases leases it acquired itself).
 */
export class WorktreeLeaseManager {
  private readonly leaseDir: string
  private readonly worktreeRoot: string
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly tokens = new Map<string, string>()

  constructor(
    readonly repoRoot: string,
    options: LeaseManagerOptions = {},
  ) {
    this.worktreeRoot = path.join(repoRoot, ".worktrees")
    this.leaseDir = options.leaseDir ?? path.join(this.worktreeRoot, ".leases")
    this.ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS
    if (!(this.ttlMs > 0) || !Number.isFinite(this.ttlMs))
      throw new LeaseError(`Lease TTL must be positive (got ${this.ttlMs}).`)
    this.now = options.now ?? Date.now
  }

  private file(slug: string): string {
    return path.join(this.leaseDir, `${slug}.json`)
  }

  private checkInfo(info: LeaseInfo): string {
    if (!info.branch) throw new LeaseError("A lease needs a branch.")
    try {
      return insideRoot(this.worktreeRoot, info.dir)
    } catch {
      throw new LeaseError(`Lease dir ${JSON.stringify(info.dir)} escapes ${this.worktreeRoot}.`)
    }
  }

  private live(record: LeaseRecord): boolean {
    if (this.now() - Date.parse(record.heartbeatAt) >= record.ttlMs) return false
    return holderAlive(record)
  }

  /** Judge a lease by heartbeat and holder only (no token: for `prune`). */
  isLive(record: LeaseRecord): boolean {
    return this.live(record)
  }

  private async read(slug: string): Promise<LeaseRecord | undefined> {
    let text: string
    try {
      text = await readFile(this.file(slug), "utf8")
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined
      throw error
    }
    try {
      const raw: unknown = JSON.parse(text)
      return isRecord(raw) ? raw : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Acquire the lease, atomically: the file is created with
   * `O_CREAT | O_EXCL`, so exactly one concurrent acquirer wins. A stale
   * (expired or dead-holder) lease is reclaimed through a remove-and-retry
   * loop, which preserves the one-winner guarantee among reclaimers.
   */
  async acquire(slug: string, info: LeaseInfo): Promise<LeaseRecord> {
    checkSlug(slug)
    const dir = this.checkInfo(info)
    const stamp = () => new Date(this.now()).toISOString()
    await mkdir(this.leaseDir, { recursive: true })
    return withLock(this.leaseDir, async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const token = randomBytes(16).toString("hex")
        const record: LeaseRecord = {
          v: LEASE_VERSION,
          slug,
          pid: process.pid,
          host: hostname(),
          token,
          branch: info.branch,
          dir,
          acquiredAt: stamp(),
          heartbeatAt: stamp(),
          ttlMs: this.ttlMs,
        }
        let handle: import("node:fs/promises").FileHandle | undefined
        try {
          handle = await open(this.file(slug), "wx", 0o644)
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error
          const current = await this.read(slug)
          if (current && this.live(current))
            throw new LeaseError(
              `Worktree ${JSON.stringify(slug)} is leased by pid ${current.pid} on ${current.host} (heartbeat ${current.heartbeatAt}).`,
            )
          // Stale (or corrupt): drop it and retry the atomic create, so two
          // reclaimers still elect exactly one winner. A live lease that
          // appeared between the read and now is caught on the next pass.
          await rm(this.file(slug), { force: true })
          await sleep(5)
          continue
        }
        try {
          await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`)
          await handle.sync()
        } finally {
          await handle.close()
        }
        this.tokens.set(slug, token)
        return record
      }
      // Ten consecutive reclaim races lost: someone else keeps winning, which
      // means the lease is effectively live again.
      throw new LeaseError(`Worktree ${JSON.stringify(slug)} is contended; refusing to take it by force.`)
    })
  }

  /** Refresh the heartbeat; only the holding manager may call this. */
  async heartbeat(slug: string): Promise<LeaseRecord> {
    checkSlug(slug)
    return withLock(this.leaseDir, async () => {
      const current = await this.read(slug)
      const token = this.tokens.get(slug)
      if (!current || token === undefined || current.token !== token)
        throw new LeaseError(`No live lease ${JSON.stringify(slug)} is held by this process.`)
      const next: LeaseRecord = { ...current, heartbeatAt: new Date(this.now()).toISOString() }
      await atomicWrite(this.file(slug), `${JSON.stringify(next, null, 2)}\n`)
      return next
    })
  }

  /** Release the lease; only the holding manager may call this. */
  async release(slug: string): Promise<void> {
    checkSlug(slug)
    await withLock(this.leaseDir, async () => {
      const current = await this.read(slug)
      const token = this.tokens.get(slug)
      this.tokens.delete(slug)
      if (!current || token === undefined || current.token !== token)
        throw new LeaseError(`No live lease ${JSON.stringify(slug)} is held by this process.`)
      await rm(this.file(slug), { force: true })
    })
  }

  /** All well-formed leases, oldest heartbeat first (corrupt files read as absent). */
  async list(): Promise<LeaseRecord[]> {
    const names = await readdir(this.leaseDir).catch((error: any) => {
      if (error?.code === "ENOENT") return [] as string[]
      throw error
    })
    const records: LeaseRecord[] = []
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue
      const record = await this.read(name.slice(0, -".json".length))
      if (record) records.push(record)
    }
    return records.sort((a, b) => (a.heartbeatAt < b.heartbeatAt ? -1 : 1))
  }

  /**
   * Acquire, heartbeat for the duration of `fn` (every third of the TTL),
   * then release. A failed heartbeat fails the whole call: running unleased
   * is worse than stopping, so the heartbeat error replaces the result.
   */
  async withLease<T>(slug: string, info: LeaseInfo, fn: (lease: LeaseRecord) => Promise<T>): Promise<T> {
    const lease = await this.acquire(slug, info)
    const every = Math.max(10, Math.floor(lease.ttlMs / 3))
    let beatError: unknown
    const timer = setInterval(() => {
      void this.heartbeat(slug).catch((error: unknown) => {
        beatError = error
      })
    }, every)
    try {
      const value = await fn(lease)
      clearInterval(timer)
      await this.release(slug)
      if (beatError !== undefined) throw beatError
      return value
    } catch (error) {
      clearInterval(timer)
      await this.release(slug).catch(() => undefined)
      if (beatError !== undefined) throw beatError
      throw error
    }
  }
}

export interface PruneReport {
  /** Stale lease slugs dropped. */
  readonly dropped: readonly string[]
  /** Orphaned worktree dirs force-removed. */
  readonly removed: readonly string[]
  /** Live lease slugs left untouched. */
  readonly kept: readonly string[]
}

/** Registered git worktrees (porcelain): [[dir, branch]]. */
async function listedWorktrees(repoRoot: string): Promise<Array<{ dir: string; branch: string }>> {
  const result = await git(repoRoot, ["worktree", "list", "--porcelain"], { allowFail: true })
  if (result.code !== 0) return []
  const found: Array<{ dir: string; branch: string }> = []
  let dir = ""
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length).trim()
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim()
      if (dir) found.push({ dir, branch: ref.replace(/^refs\/heads\//, "") })
      dir = ""
    } else if (line.trim() === "") dir = ""
  }
  return found
}

const underRoot = (root: string, dir: string): boolean => {
  const relative = path.relative(root, dir)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/**
 * Garbage-collect one checkout's `.worktrees/`: drop expired and
 * dead-holder leases, then force-remove every registered git worktree under
 * the managed root that no live lease covers. Stray (unregistered) dirs and
 * all branches are left alone: prune deletes checkouts, never history.
 * Agent-safe: called by `es worktree prune` and on factory startup.
 */
export async function pruneWorktrees(repoRoot: string, options: LeaseManagerOptions = {}): Promise<PruneReport> {
  const manager = new WorktreeLeaseManager(repoRoot, options)
  const dropped: string[] = []
  const removed: string[] = []
  const kept: string[] = []
  const leaseDir = path.join(repoRoot, ".worktrees", ".leases")
  await withLock(options.leaseDir ?? leaseDir, async () => {
    const leases = await manager.list()
    const live = new Map<string, LeaseRecord>()
    for (const lease of leases) {
      if (manager.isLive(lease)) {
        live.set(lease.dir, lease)
        kept.push(lease.slug)
      } else {
        await rm(path.join(options.leaseDir ?? leaseDir, `${lease.slug}.json`), { force: true })
        dropped.push(lease.slug)
      }
    }
    const root = path.join(repoRoot, ".worktrees")
    for (const entry of await listedWorktrees(repoRoot)) {
      if (!underRoot(root, entry.dir)) continue
      if (!live.has(entry.dir)) {
        await removeWorktree(repoRoot, entry.dir).catch(async () => {
          await git(repoRoot, ["worktree", "remove", "--force", entry.dir])
        })
        removed.push(entry.dir)
      }
    }
  })
  dropped.sort()
  removed.sort()
  kept.sort()
  return { dropped, removed, kept }
}
