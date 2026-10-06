import { mkdir } from "node:fs/promises"
import path from "node:path"
import { runCommand } from "../util/proc.ts"

export interface PhaseWorktree {
  readonly worktreePath: string
  readonly branch: string
}

export interface DiffStats {
  readonly added: number
  readonly removed: number
  readonly files: readonly string[]
}

export async function createPhaseWorktree(
  rootDir: string,
  phaseId: string,
  options: { baseRef?: string } = {},
): Promise<PhaseWorktree> {
  const worktreesBase = path.join(rootDir, ".factory", "worktrees")
  await mkdir(worktreesBase, { recursive: true })

  const branch = `factory/phase-${phaseId}`
  const worktreePath = path.join(worktreesBase, `phase-${phaseId}`)
  const baseRef = options.baseRef ?? "HEAD"

  // git worktree add -B <branch> <path> <baseRef>
  const res = await runCommand(`git worktree add -B ${branch} ${worktreePath} ${baseRef}`, {
    cwd: rootDir,
    timeoutMs: 30000,
  })

  if (res.code !== 0) {
    throw new Error(`Failed to create worktree for phase ${phaseId}: ${res.stderr || res.stdout}`)
  }

  return {
    worktreePath,
    branch,
  }
}

export async function removePhaseWorktree(
  rootDir: string,
  phaseId: string,
  options: { deleteBranch?: boolean } = {},
): Promise<void> {
  const worktreePath = path.join(rootDir, ".factory", "worktrees", `phase-${phaseId}`)
  const branch = `factory/phase-${phaseId}`

  // git worktree remove --force <path>
  const res = await runCommand(`git worktree remove --force ${worktreePath}`, {
    cwd: rootDir,
    timeoutMs: 30000,
  })

  // If worktree directory is already gone, that is ok
  if (res.code !== 0 && !res.stderr.includes("is not a working tree")) {
    throw new Error(`Failed to remove worktree for phase ${phaseId}: ${res.stderr || res.stdout}`)
  }

  if (options.deleteBranch) {
    await runCommand(`git branch -D ${branch}`, {
      cwd: rootDir,
      timeoutMs: 10000,
    })
  }
}

export async function getWorktreeDiffStats(worktreePath: string): Promise<DiffStats> {
  // Use git diff --numstat HEAD against the base of branch or previous commit
  const res = await runCommand("git diff --numstat HEAD", {
    cwd: worktreePath,
    timeoutMs: 15000,
  })

  if (res.code !== 0) {
    return { added: 0, removed: 0, files: [] }
  }

  let added = 0
  let removed = 0
  const files: string[] = []

  const lines = res.stdout.trim().split("\n").filter(Boolean)
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts.length >= 3) {
      const a = parseInt(parts[0] || "0", 10)
      const r = parseInt(parts[1] || "0", 10)
      const file = parts.slice(2).join(" ")
      if (!Number.isNaN(a)) added += a
      if (!Number.isNaN(r)) removed += r
      files.push(file)
    }
  }

  return { added, removed, files }
}
