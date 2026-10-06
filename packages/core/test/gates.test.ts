import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkBudgets, detectProjectGates, runGates, scanForSecrets } from "../src/gates/index.ts"

describe("mechanical gates", () => {
  test("secret scanner identifies leaked keys", () => {
    const codeWithSecret = `
const apiKey = "AKIA1234567890ABCDEF";
const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB";
console.log(apiKey);
`
    const findings = scanForSecrets(codeWithSecret, "src/auth.ts")
    expect(findings.length).toBe(2)
    expect(findings[0]?.rule).toBe("security/secret-aws-key")
    expect(findings[0]?.line).toBe(2)
    expect(findings[1]?.rule).toBe("security/secret-github-token")
  })

  test("detector infers bun configuration from bun.lock", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-detect-test-"))
    try {
      await writeFile(path.join(tempDir, "bun.lock"), "")
      await writeFile(path.join(tempDir, "biome.json"), "{}")

      const config = await detectProjectGates(tempDir)
      expect(config.commands.test?.command).toBe("bun test")
      expect(config.commands.lint?.command).toContain("biome check")
      expect(config.budgets.maxDiffLines).toBe(500)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("budget checks enforce file line limit and dep justifications", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-budget-test-"))
    try {
      const longContent = "line\n".repeat(50)
      const testFile = "src/big.ts"
      await mkdir(path.join(tempDir, "src"), { recursive: true })
      await writeFile(path.join(tempDir, testFile), longContent)

      // Test with max 20 lines
      const findings = await checkBudgets(tempDir, [testFile], {
        maxFileLines: 20,
        requireDepJustification: false,
      })
      expect(findings.length).toBe(1)
      expect(findings[0]?.rule).toBe("budget/file-length")

      // Test dep manifest without justification
      await writeFile(path.join(tempDir, "package.json"), "{}")
      const depFindings = await checkBudgets(tempDir, ["package.json"], {
        requireDepJustification: true,
        phaseId: "01-test",
      })
      expect(depFindings.length).toBe(1)
      expect(depFindings[0]?.rule).toBe("budget/dependency-justification")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("gate engine evaluates secrets and honors active waivers", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-engine-test-"))
    try {
      const srcDir = path.join(tempDir, "src")
      await mkdir(srcDir, { recursive: true })
      const filePath = "src/secret.ts"
      await writeFile(path.join(tempDir, filePath), 'const key = "AKIA1234567890ABCDEF";\n')

      // 1. Without waiver, fails
      const res1 = await runGates(tempDir, {
        touchedFiles: [filePath],
        skipExecution: true,
      })
      expect(res1.passed).toBe(false)
      expect(res1.findings.length).toBe(1)
      expect(res1.waiverCount).toBe(0)

      // 2. Add an active waiver
      const waiversDir = path.join(tempDir, ".factory", "waivers")
      await mkdir(waiversDir, { recursive: true })
      const waiver = {
        id: "w1",
        rule: "security/secret-aws-key",
        filePattern: "src/**",
        reason: "Test mock AWS key",
        signedBy: "admin",
        signedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        artifactHash: "0".repeat(64),
      }
      await writeFile(path.join(waiversDir, "w1.json"), JSON.stringify(waiver, null, 2))

      const res2 = await runGates(tempDir, {
        touchedFiles: [filePath],
        skipExecution: true,
      })
      expect(res2.passed).toBe(true)
      expect(res2.findings.length).toBe(0)
      expect(res2.waiverCount).toBe(1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
