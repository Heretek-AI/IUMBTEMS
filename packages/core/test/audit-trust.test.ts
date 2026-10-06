import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { appendAuditEntry, verifyAuditChain } from "../src/audit/index.ts"
import { checkStopFile } from "../src/trust/index.ts"

describe("audit and trust", () => {
  test("audit log appends with hash chaining and verifies correctly", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-audit-test-"))
    try {
      const e0 = await appendAuditEntry(tempDir, {
        actor: "system",
        action: "init",
        payload: { stage: "grill" },
      })
      expect(e0.seq).toBe(0)
      expect(e0.prevHash).toBe("0".repeat(64))

      const e1 = await appendAuditEntry(tempDir, {
        actor: "manager",
        action: "phase_start",
        payload: { phase: "01-scaffold" },
      })
      expect(e1.seq).toBe(1)
      expect(e1.prevHash).toBe(e0.hash)

      const verification = await verifyAuditChain(tempDir)
      expect(verification.valid).toBe(true)
      expect(verification.entries.length).toBe(2)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("audit log detects tamper/corruption", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-audit-tamper-"))
    try {
      await appendAuditEntry(tempDir, {
        actor: "system",
        action: "init",
      })
      await appendAuditEntry(tempDir, {
        actor: "programmer",
        action: "commit",
      })

      // Corrupt the file
      const logFile = path.join(tempDir, ".factory", "runtime", "audit.jsonl")
      const content = await Bun.file(logFile).text()
      const lines = content.trim().split("\n")
      const tamperedFirstLine = lines[0]?.replace("system", "hacker")
      await writeFile(logFile, `${tamperedFirstLine}\n${lines[1]}\n`, "utf8")

      const verification = await verifyAuditChain(tempDir)
      expect(verification.valid).toBe(false)
      expect(verification.error).toContain("entry 0 was modified")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("stop file detects kill-switch engagement", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-stop-test-"))
    try {
      const check1 = await checkStopFile(tempDir)
      expect(check1.stopped).toBe(false)

      const factoryDir = path.join(tempDir, ".factory")
      await Bun.write(path.join(factoryDir, "STOP"), "Emergency halt by user")

      const check2 = await checkStopFile(tempDir)
      expect(check2.stopped).toBe(true)
      expect(check2.reason).toBe("Emergency halt by user")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
