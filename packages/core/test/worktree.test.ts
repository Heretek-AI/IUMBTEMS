import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runCommand } from "../src/util/proc.ts"
import { createPhaseWorktree, getWorktreeDiffStats, removePhaseWorktree } from "../src/worktree/index.ts"

describe("worktree runner", () => {
  test("creates and cleans up git worktree per phase", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-worktree-test-"))
    try {
      // Initialize a test git repo
      await runCommand("git init", { cwd: tempDir })
      await runCommand('git config user.name "Test"', { cwd: tempDir })
      await runCommand('git config user.email "test@example.com"', { cwd: tempDir })
      await Bun.write(path.join(tempDir, "README.md"), "# Test Repo\n")
      await runCommand("git add README.md", { cwd: tempDir })
      await runCommand('git commit -m "initial commit"', { cwd: tempDir })

      // Create phase worktree
      const phase = await createPhaseWorktree(tempDir, "01-test")
      expect(phase.branch).toBe("factory/phase-01-test")
      expect(phase.worktreePath).toContain(".factory/worktrees/phase-01-test")

      // Add a change in the worktree
      await Bun.write(path.join(phase.worktreePath, "src.ts"), "console.log('hello');\n")
      const diffStats = await getWorktreeDiffStats(phase.worktreePath)
      expect(diffStats.files).toBeDefined()

      // Clean up worktree
      await removePhaseWorktree(tempDir, "01-test", { deleteBranch: true })
      const exists = await Bun.file(phase.worktreePath).exists()
      expect(exists).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
