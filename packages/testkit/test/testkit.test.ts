import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { boot } from "../src/index.ts"

describe("testkit", () => {
  test("boots in-process OpenCode host with fake LLM", async () => {
    const harness = await boot({
      script: () => ({ text: "harness response" }),
    })
    try {
      const result = await harness.run("hello testkit")
      expect(result.sessionID).toBeDefined()
      expect(result.context.length).toBeGreaterThan(0)
    } finally {
      await harness.close()
    }
  }, 30000)

  test("a git repo boots with a repo-local identity (merges must not need ambient config)", async () => {
    const harness = await boot({ git: true })
    try {
      const config = await readFile(path.join(harness.directory, ".git", "config"), "utf8")
      expect(config).toContain("email = test@test")
      expect(config).toContain("name = test")
    } finally {
      await harness.close()
    }
  }, 30000)
})
