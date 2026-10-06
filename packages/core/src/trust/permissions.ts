import { matchGlob } from "../util/glob.ts"
import { isControlPath } from "./tamper.ts"

export type SeatRole = "manager" | "programmer" | "qa-a" | "qa-b" | "human" | "system"

export interface PermissionCheckResult {
  readonly allowed: boolean
  readonly reason?: string
}

/**
 * Checks whether an agent seat is permitted to write to the specified relative path.
 *
 * Rules:
 * - human/system: allowed everywhere.
 * - Control files (gates, waivers, audit, approvals, frontier, state): deny-write for ALL agents.
 * - manager: writes .factory/** (except control files) and {docs,README.md}/**.
 * - programmer: writes source files inside their worktree or project source (never .factory/**).
 * - qa-a / qa-b: read-only, never allowed to write anything.
 */
export function checkSeatWritePermission(
  seat: SeatRole,
  relativePath: string,
  _options?: { inWorktree?: boolean },
): PermissionCheckResult {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "")

  if (seat === "human" || seat === "system") {
    return { allowed: true }
  }

  // Control files are strictly deny-write for all autonomous agent seats
  if (isControlPath(normalized)) {
    return {
      allowed: false,
      reason: `Control file "${normalized}" is write-protected for agent role "${seat}". Modifications require human approval.`,
    }
  }

  if (seat === "qa-a" || seat === "qa-b") {
    return {
      allowed: false,
      reason: `QA seat "${seat}" is strictly read-only and cannot perform file writes.`,
    }
  }

  if (seat === "manager") {
    // Manager writes .factory files (specs, roadmaps) and docs
    const allowedPatterns = [".factory/**", "docs/**", "README.md", "ARCHITECTURE.md"]
    const matches = allowedPatterns.some((pattern) => matchGlob(normalized, pattern))
    if (!matches) {
      return {
        allowed: false,
        reason: `Manager seat is restricted to .factory/** and documentation paths; cannot write to implementation file "${normalized}".`,
      }
    }
    return { allowed: true }
  }

  if (seat === "programmer") {
    // Programmer cannot write into .factory directory
    if (matchGlob(normalized, ".factory/**")) {
      return {
        allowed: false,
        reason: `Programmer seat cannot write to .factory/** directory. State and specs are owned by manager.`,
      }
    }

    // Git metadata protection
    if (matchGlob(normalized, ".git/**")) {
      return {
        allowed: false,
        reason: `Programmer seat cannot write directly to .git/** metadata.`,
      }
    }

    return { allowed: true }
  }

  return { allowed: false, reason: `Unknown seat role "${seat}".` }
}
