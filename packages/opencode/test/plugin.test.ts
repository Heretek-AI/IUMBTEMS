import { describe, expect, test } from "bun:test"
import path from "node:path"
import { boot } from "@heretek-ai/es-testkit"

const pluginDir = path.resolve(__dirname, "..")

describe("opencode plugin integration", () => {
  test("loads plugin, registers tools and responds via real host", async () => {
    const harness = await boot({
      plugins: [pluginDir],
      script: (request) => {
        // Find if model should call a tool
        const lastMsg = request.messages[request.messages.length - 1]
        const text = String(lastMsg?.content ?? "")

        if (text.includes("init factory")) {
          return {
            toolCalls: [
              {
                name: "es_factory_init",
                args: { spendCeilingUSD: 50.0, directory: harness.directory },
              },
            ],
          }
        }

        if (text.includes("check status")) {
          return {
            toolCalls: [
              {
                name: "es_factory_status",
                args: { directory: harness.directory },
              },
            ],
          }
        }

        return { text: "Plugin operational" }
      },
    })

    try {
      const res = await harness.run("init factory")
      expect(res.context.length).toBeGreaterThan(0)

      // Verify status tool
      const statusRes = await harness.run("check status")
      expect(statusRes.context.length).toBeGreaterThan(0)
    } finally {
      await harness.close()
    }
  }, 45000)

  test("execute.before hook prevents unauthorized writes to control paths", async () => {
    const harness = await boot({
      plugins: [pluginDir],
      script: (request) => {
        const lastMsg = request.messages[request.messages.length - 1]
        const text = String(lastMsg?.content ?? "")
        if (text.includes("tamper file")) {
          return {
            toolCalls: [
              {
                name: "write",
                args: {
                  path: ".factory/gates.json",
                  content: "tampered",
                },
              },
            ],
          }
        }
        return { text: "ready" }
      },
    })

    try {
      const res = await harness.run("tamper file")
      const allMessages = JSON.stringify(res.context)
      // The hook blocks and reports Access Denied or refusal
      expect(allMessages).toContain("Access Denied")
    } finally {
      await harness.close()
    }
  }, 45000)
})
