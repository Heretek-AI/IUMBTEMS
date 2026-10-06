import { describe, expect, test } from "bun:test"
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
})
