// Approval attempt limiting (#119, ADR 0002 I4).
import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  APPROVAL_ATTEMPT_WINDOW_MS,
  checkApprovalAttempts,
  MAX_APPROVAL_ATTEMPTS,
  noteApprovalSuccess,
  noteWrongPassphrase,
} from "../src/approval/attempts.ts"
import { recentAuditEntries } from "../src/audit/index.ts"
import { type Fixture, gitRepo } from "./helpers.ts"

describe("approval attempts", () => {
  test("5 wrong passphrases lock out; the window slides; success clears", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "es-attempts-"))
    const fx: Fixture = await gitRepo()
    try {
      const root = fx.root
      let check = await checkApprovalAttempts(dir, 0)
      expect(check).toEqual({ allowed: true, remaining: MAX_APPROVAL_ATTEMPTS })
      for (let i = 1; i <= MAX_APPROVAL_ATTEMPTS; i++) {
        check = await noteWrongPassphrase({ dir, root, stage: "frontier", channel: "tui", now: i * 1000 })
        if (i < MAX_APPROVAL_ATTEMPTS) expect(check.allowed).toBe(true)
      }
      expect(check.allowed).toBe(false)
      expect(check.retryAfterSec).toBe(Math.ceil((1000 + APPROVAL_ATTEMPT_WINDOW_MS - 5000) / 1000))
      // Lockouts are audited.
      const actions = (await recentAuditEntries(root, 10)).map((entry) => entry.action)
      expect(actions).toContain("approval.lockout")
      // The window slides: past failures expire.
      const later = await checkApprovalAttempts(dir, APPROVAL_ATTEMPT_WINDOW_MS + 60_000)
      expect(later).toEqual({ allowed: true, remaining: MAX_APPROVAL_ATTEMPTS })
      // Success clears mid-window failures.
      await noteWrongPassphrase({
        dir,
        root,
        stage: "frontier",
        channel: "tui",
        now: APPROVAL_ATTEMPT_WINDOW_MS + 61_000,
      })
      await noteApprovalSuccess(dir)
      expect(await checkApprovalAttempts(dir, APPROVAL_ATTEMPT_WINDOW_MS + 62_000)).toEqual({
        allowed: true,
        remaining: MAX_APPROVAL_ATTEMPTS,
      })
    } finally {
      fx.cleanup()
    }
  })
})
