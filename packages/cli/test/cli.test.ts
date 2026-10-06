import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { executeMcpTool, MCP_TOOLS } from "../src/mcp.ts"

describe("cli and mcp", () => {
  test("mcp tool catalog exposes factory and gates tools", () => {
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(4)
    const names = MCP_TOOLS.map((t) => t.name)
    expect(names).toContain("factory_init")
    expect(names).toContain("factory_status")
    expect(names).toContain("gates_run")
    expect(names).toContain("approve")
  })

  test("executes mcp tools against workspace", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "es-cli-test-"))
    try {
      const state = (await executeMcpTool(tempDir, "factory_init", {
        spendCeilingUSD: 40.0,
      })) as any
      expect(state.stage).toBe("GRILL")
      expect(state.spendCeilingUSD).toBe(40.0)

      const status = (await executeMcpTool(tempDir, "factory_status", {})) as any
      expect(status.stage).toBe("GRILL")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
