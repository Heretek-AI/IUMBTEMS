// #355: an unreadable run state is a status value (one log per distinct
// problem), not a throw every poll; the footer names the problem and fix.
import { describe, expect, test } from "bun:test"
import { createRpcHandlers } from "../src/rpc.ts"

const sealError = () =>
  Object.assign(new Error("Cannot verify .factory/runtime/state.json: there is no engine key at /tmp/x."))

const fakeRuntime = (read: () => Promise<never>) =>
  ({
    root: "/tmp/proj",
    factory: { read, summary: async () => "<factory-state>no</factory-state>" },
    config: {},
    configSources: [],
    warnings: [],
  }) as any

describe("status RPC seal throttle (#355)", () => {
  test("a seal problem returns a status with footer, and logs once per problem", async () => {
    const handlers = createRpcHandlers(
      fakeRuntime(async () => {
        throw sealError()
      }),
      async () => {},
    )
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(String(args[0]))
    }
    try {
      const first = await handlers.status()
      expect(first.stage).toBe("ERROR")
      expect(String(first.footer)).toContain("state unreadable")
      expect(String(first.footer)).toContain("fix:")
      expect(String(first.sealProblem)).toContain("Cannot verify")
      const second = await handlers.status()
      expect(second.stage).toBe("ERROR")
      expect(warns).toHaveLength(1)
      const dashboard = await handlers.factoryState()
      expect(dashboard.stage).toBe("ERROR")
      expect(String(dashboard.headline)).toContain("State unreadable")
      expect(warns).toHaveLength(1)
    } finally {
      console.warn = orig
    }
  })

  test("a non-seal error still throws", async () => {
    const handlers = createRpcHandlers(
      fakeRuntime(async () => {
        throw new Error("boom")
      }),
      async () => {},
    )
    await expect(handlers.status()).rejects.toThrow("boom")
  })
})
