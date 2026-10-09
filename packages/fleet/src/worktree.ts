// Fleet worktree coordinator (#124, clean-room): one isolated git worktree
// per task on its own branch, a locked registry in the state dir, salvage
// before destructive cleanup, orphan gc, and gated transactional landing
// onto an integration branch. The base branch is never checked out, reset,
// or merged into: every assertion the suite makes is `tip(main)`-stable.
//
// Concurrency discipline: the registry lock serializes check-then-act in two
// phases (check under lock, git work under the per-repo admin lock, commit
// under lock with a re-check), and all `git worktree` administration takes
// the per-repo lock so concurrent allocators cannot corrupt the worktree
// index.
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  addWorktree,
  branchExists,
  GitError,
  git as gitRun,
  headCommit,
  readJson,
  removeWorktree,
  revParse,
  withLock,
  writeJson,
} from "@heretek-ai/es-core"
import { z } from "zod"
import { FleetError } from "./lifecycle.ts"
import { fleetPaths } from "./state.ts"

const SLUG = /^[a-z0-9][a-z0-9-]*$/

const checkSlug = (kind: string, value: string): void => {
  if (!SLUG.test(value) || value.length > 64)
    throw new FleetError(`Invalid ${kind} ${JSON.stringify(value)}: lowercase alphanumerics and dashes only.`)
}

/** Branch carrying one task's work. Never the base branch. */
export const fleetBranch = (taskId: string): string => {
  checkSlug("task id", taskId)
  return `fleet/${taskId}`
}

/** Integration branch receiving a DAG's gated merges. */
export const integrationBranch = (dagId: string): string => {
  checkSlug("dag id", dagId)
  return `fleet/integration/${dagId}`
}

/** Worktree checkout dir for a task (inside the repo, gitignored). */
export const fleetWorktreeDir = (repoRoot: string, taskId: string): string => {
  checkSlug("task id", taskId)
  return path.join(repoRoot, ".fleet", "worktrees", taskId)
}

export const WorktreeStatusSchema = z.enum(["allocated", "merged", "abandoned"])
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>

export const WorktreeRecordSchema = z.object({
  taskId: z.string().min(1),
  dir: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().regex(/^[0-9a-f]{40}$/),
  createdAt: z.string().datetime(),
  status: WorktreeStatusSchema,
})
export type WorktreeRecord = z.infer<typeof WorktreeRecordSchema>

export const REGISTRY_VERSION = 1 as const

export const WorktreeRegistrySchema = z.object({
  v: z.literal(REGISTRY_VERSION),
  worktrees: z.record(z.string(), WorktreeRecordSchema),
})
export type WorktreeRegistry = z.infer<typeof WorktreeRegistrySchema>

export const emptyRegistry = (): WorktreeRegistry => ({ v: REGISTRY_VERSION, worktrees: {} })

/** Load the registry; undefined when missing, corrupt, or versioned away. */
export async function loadRegistry(stateRoot: string): Promise<WorktreeRegistry | undefined> {
  let raw: unknown
  try {
    raw = await readJson(fleetPaths(stateRoot).worktrees)
  } catch {
    return undefined
  }
  if (raw === undefined) return undefined
  const parsed = WorktreeRegistrySchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

async function persistRegistry(paths: ReturnType<typeof fleetPaths>, registry: WorktreeRegistry): Promise<void> {
  await writeJson(paths.worktrees, registry)
}

/** Throwing git: like core's `git` but without the allow-fail escape hatch. */
async function git(root: string, args: readonly string[]) {
  return gitRun(root, args)
}

/**
 * Per-repo administration mutex: every `git worktree` add/remove/prune and
 * every landing merge takes it, so concurrent fleet operations cannot corrupt
 * the worktree index.
 */
export async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  return withLock(path.join(repoRoot, ".fleet", "admin"), fn)
}

/**
 * Recursive copy without a shell (files, dirs, symlinks-as-symlinks).
 * Refuses to write into an existing destination.
 */
export async function mirrorDir(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true })
  try {
    await lstat(to)
    throw new FleetError(`mirrorDir refuses to overwrite existing ${to}.`)
  } catch (error) {
    if (error instanceof FleetError) throw error
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
  }
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isSymbolicLink()) await symlink(await readlink(src), dst)
    else if (entry.isDirectory()) await mirrorDir(src, dst)
    else if (entry.isFile()) await writeFile(dst, await readFile(src))
  }
}

const SKIP_DIRS = new Set([".git", "node_modules"])

/**
 * Rewrite absolute symlinks pointing inside `repoRoot` to point at the same
 * path under `worktreeDir` (monorepo symlink rebasing for fresh worktrees).
 * Returns the rewritten link paths.
 */
export async function rebaseSymlinks(worktreeDir: string, repoRoot: string): Promise<string[]> {
  const rewritten: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await readlink(full)
        if (path.isAbsolute(target)) {
          const relative = path.relative(repoRoot, target)
          if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
            await rm(full)
            await symlink(path.join(worktreeDir, relative), full)
            rewritten.push(full)
          }
        }
      } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        await walk(full)
      }
    }
  }
  await walk(worktreeDir)
  return rewritten.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export interface AllocateOptions {
  /** Commit the branch starts from (recorded; defaults to HEAD). */
  readonly base?: string
  /** Stamp override (tests, determinism). */
  readonly now?: string
}

/**
 * Allocate a task worktree: two-phase under the registry lock (check, then
 * git work under the repo lock, then commit with a re-check). A live record
 * or an existing dir refuses with FleetError.
 */
export async function allocateWorktree(
  repoRoot: string,
  stateRoot: string,
  taskId: string,
  options: AllocateOptions = {},
): Promise<WorktreeRecord> {
  checkSlug("task id", taskId)
  const paths = fleetPaths(stateRoot)
  const dir = fleetWorktreeDir(repoRoot, taskId)
  const branch = fleetBranch(taskId)
  const now = options.now ?? new Date().toISOString()
  // Phase 1: check.
  await withLock(paths.lock, async () => {
    const registry = (await loadRegistry(stateRoot)) ?? emptyRegistry()
    if (registry.worktrees[taskId]?.status === "allocated")
      throw new FleetError(`Task ${JSON.stringify(taskId)} already has a worktree allocated.`)
  })
  try {
    await lstat(dir)
    throw new FleetError(`Worktree dir ${dir} already exists; refusing to reuse it.`)
  } catch (error) {
    if (error instanceof FleetError) throw error
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
  }
  // Git work under the per-repo admin lock.
  const base = options.base ?? (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim()
  await withRepoLock(repoRoot, async () => {
    await addWorktree(repoRoot, dir, branch, base)
  })
  await rebaseSymlinks(dir, repoRoot)
  // Phase 2: commit with a re-check (a concurrent allocator may have won).
  let record: WorktreeRecord | undefined
  await withLock(paths.lock, async () => {
    const registry = (await loadRegistry(stateRoot)) ?? emptyRegistry()
    if (registry.worktrees[taskId]?.status === "allocated") {
      record = registry.worktrees[taskId]
      return
    }
    record = { taskId, dir, branch, base, createdAt: now, status: "allocated" as const }
    await persistRegistry(paths, { v: REGISTRY_VERSION, worktrees: { ...registry.worktrees, [taskId]: record } })
  })
  if (registryHadRaced(record!, taskId, dir)) {
    // We lost the race after creating the worktree: tear ours down.
    await withRepoLock(repoRoot, async () => {
      await removeWorktree(repoRoot, dir)
    })
    throw new FleetError(`Task ${JSON.stringify(taskId)} was allocated concurrently; refusing a second worktree.`)
  }
  return record!
}

const registryHadRaced = (record: WorktreeRecord, taskId: string, dir: string): boolean =>
  record.dir !== dir || record.taskId !== taskId

export type ReleaseKind = "merged" | "abandoned"

/**
 * Release a task worktree: remove the checkout, then mark the record. An
 * abandoned branch is salvaged (anchored at `refs/fleet-salvage/<taskId>`)
 * before its branch is deleted; a merged branch is kept.
 */
export async function releaseWorktree(
  repoRoot: string,
  stateRoot: string,
  taskId: string,
  kind: ReleaseKind,
): Promise<{ released: boolean }> {
  const paths = fleetPaths(stateRoot)
  const current = await withLock(paths.lock, () => loadRegistry(stateRoot)).then(
    (registry) => registry?.worktrees[taskId],
  )
  if (current?.status !== "allocated") return { released: false }
  await withRepoLock(repoRoot, async () => {
    try {
      await removeWorktree(repoRoot, current.dir)
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      await git(repoRoot, ["worktree", "remove", "--force", current.dir])
    }
    if (kind === "abandoned") {
      await salvageBranch(repoRoot, current.branch, taskId)
      await git(repoRoot, ["branch", "-D", current.branch])
    }
  })
  await withLock(paths.lock, async () => {
    const registry = (await loadRegistry(stateRoot)) ?? emptyRegistry()
    const record = registry.worktrees[taskId]
    if (record && record.status === "allocated")
      await persistRegistry(paths, {
        v: REGISTRY_VERSION,
        worktrees: { ...registry.worktrees, [taskId]: { ...record, status: kind } },
      })
  })
  return { released: true }
}

/**
 * Anchor a branch tip at `refs/fleet-salvage/<taskId>` before destructive
 * cleanup, so abandoned or orphaned work is never silently lost. Returns the
 * anchored tip, or undefined when the branch is gone.
 */
export async function salvageBranch(repoRoot: string, branch: string, taskId: string): Promise<string | undefined> {
  checkSlug("task id", taskId)
  if (!(await branchExists(repoRoot, branch))) return undefined
  const tip = await revParse(repoRoot, branch)
  await git(repoRoot, ["update-ref", `refs/fleet-salvage/${taskId}`, tip])
  return tip
}

export type GateCheck = (worktreeDir: string) => Promise<{ ok: true } | { ok: false; reason?: string }>

export type LandResult =
  | { readonly landed: true; readonly integration: string; readonly tip: string }
  | { readonly landed: false; readonly reason: string; readonly conflict?: boolean }

/**
 * Land a task branch onto the integration branch, transactionally:
 * gates first (no state change on failure), then a `--no-ff` merge in a
 * throwaway worktree with the pre-merge tip captured; a conflict aborts the
 * merge, verifies the rollback, and reports `conflict: true` so the caller
 * can mark the task `waiting-human`. The base branch is never touched.
 */
export async function landTask(
  repoRoot: string,
  stateRoot: string,
  taskId: string,
  dagId: string,
  checkGates: GateCheck,
): Promise<LandResult> {
  checkSlug("task id", taskId)
  const record = (await loadRegistry(stateRoot))?.worktrees[taskId]
  if (record?.status !== "allocated")
    return { landed: false, reason: `no allocated worktree for task ${JSON.stringify(taskId)}` }
  const gates = await checkGates(record.dir)
  if (!gates.ok) return { landed: false, reason: gates.reason ?? "gates failed" }
  const integration = integrationBranch(dagId)
  return withRepoLock(repoRoot, async () => {
    if (!(await branchExists(repoRoot, integration))) await git(repoRoot, ["branch", integration, record.base])
    const before = await revParse(repoRoot, integration)
    const taskTip = await revParse(repoRoot, record.branch)
    if (await isMerged(repoRoot, taskTip, integration)) return { landed: true, integration, tip: before }
    // Merge in a throwaway worktree: no checkout in the repo ever moves.
    const tmp = path.join(repoRoot, ".fleet", "tmp", `land-${taskId}-${process.pid}`)
    await rm(tmp, { recursive: true, force: true })
    try {
      await addWorktree(repoRoot, tmp, `_fleet-land-${taskId}`, integration)
      const merged = await gitRun(tmp, ["merge", "--no-ff", "--no-edit", record.branch], { allowFail: true })
      if (merged.code !== 0) {
        await git(tmp, ["merge", "--abort"])
        const rolledBack = await revParse(repoRoot, integration)
        if (rolledBack !== before) await git(repoRoot, ["update-ref", `refs/heads/${integration}`, before])
        return { landed: false, reason: `merge conflict landing ${record.branch} onto ${integration}`, conflict: true }
      }
      // The temp worktree's HEAD is the merge; fast-forward the real branch.
      const mergedTip = await headCommit(tmp)
      await git(repoRoot, ["update-ref", `refs/heads/${integration}`, mergedTip])
      return { landed: true, integration, tip: mergedTip }
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", tmp])
    }
  })
}

async function isMerged(repoRoot: string, commit: string, into: string): Promise<boolean> {
  const base = await git(repoRoot, ["merge-base", commit, into])
  return base.stdout.trim() === commit
}

export interface GcReport {
  /** Worktree dirs removed. */
  readonly removed: readonly string[]
  /** Branches anchored at refs/fleet-salvage/*. */
  readonly salvaged: readonly string[]
  /** Stale registry records dropped. */
  readonly dropped: readonly string[]
}

/** List current worktrees (porcelain): [[path, branch]]. */
async function listedWorktrees(repoRoot: string): Promise<Array<{ dir: string; branch: string }>> {
  const out = (await git(repoRoot, ["worktree", "list", "--porcelain"])).stdout
  const found: Array<{ dir: string; branch: string }> = []
  let dir = ""
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length).trim()
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim()
      if (dir) found.push({ dir, branch: ref.replace(/^refs\/heads\//, "") })
      dir = ""
    } else if (line.trim() === "") dir = ""
  }
  return found
}

/**
 * Collect orphans: worktree dirs under `.fleet/worktrees/` with no allocated
 * record are salvaged (when their branch has commits) and removed; records
 * whose dir and branch are both gone are dropped. The base branch never moves.
 */
export async function gcWorktrees(repoRoot: string, stateRoot: string): Promise<GcReport> {
  const paths = fleetPaths(stateRoot)
  const removed: string[] = []
  const salvaged: string[] = []
  const dropped: string[] = []
  await withRepoLock(repoRoot, async () => {
    const registry = (await loadRegistry(stateRoot)) ?? emptyRegistry()
    const live = new Set(
      Object.values(registry.worktrees)
        .filter((record) => record.status === "allocated")
        .map((record) => record.dir),
    )
    for (const entry of await listedWorktrees(repoRoot)) {
      const inside = path.relative(path.join(repoRoot, ".fleet", "worktrees"), entry.dir)
      if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) continue
      if (!live.has(entry.dir)) {
        const taskId = entry.branch.replace(/^fleet\//, "")
        if (SLUG.test(taskId) && (await branchExists(repoRoot, entry.branch))) {
          const tip = await salvageBranch(repoRoot, entry.branch, taskId)
          if (tip) salvaged.push(entry.branch)
          await git(repoRoot, ["branch", "-D", entry.branch]).catch(() => undefined)
        }
        await git(repoRoot, ["worktree", "remove", "--force", entry.dir])
        removed.push(entry.dir)
      }
    }
    // Drop records whose dir is gone from git and disk and whose branch is gone.
    const next = { ...registry.worktrees }
    for (const [id, record] of Object.entries(registry.worktrees)) {
      if (record.status !== "allocated") continue
      const dirGone = !(await listedWorktrees(repoRoot)).some((entry) => entry.dir === record.dir)
      let onDisk = true
      try {
        await lstat(record.dir)
      } catch {
        onDisk = false
      }
      if (dirGone && !onDisk && !(await branchExists(repoRoot, record.branch))) {
        delete next[id]
        dropped.push(id)
      }
    }
    await withLock(paths.lock, () => persistRegistry(paths, { v: REGISTRY_VERSION, worktrees: next }))
  })
  return { removed, salvaged, dropped }
}
