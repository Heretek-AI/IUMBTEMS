// Bus client (#129): strict response parsing, auth failure mapping. The
// fetch transport is stubbed per test; no DOM is touched.
import { afterEach, describe, expect, test } from "bun:test"
import { fetchStatus, parseStatus, RpcError, rpc } from "./api.ts"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const stubFetch = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe("parseStatus", () => {
  test("it accepts a well-formed snapshot", () => {
    const snapshot = parseStatus({
      daemon: { running: true, pid: 7, maxUsd: 50, concurrency: 2 },
      tasks: [{ id: "a", status: "running", ceilingUSD: 5, spendUsd: 1 }],
      spendUsd: 1,
      pending: [{ taskId: "a", reason: "frontier approval" }],
    })
    expect(snapshot.daemon.pid).toBe(7)
    expect(snapshot.tasks).toHaveLength(1)
  })

  test("it rejects malformed payloads (fail-closed, never a partial render)", () => {
    for (const bad of [
      undefined,
      {},
      { daemon: {}, tasks: [], spendUsd: 0, pending: [] },
      {
        daemon: { running: true, pid: 7, maxUsd: 50, concurrency: 2 },
        tasks: [{ id: "a" }],
        spendUsd: 0,
        pending: [],
      },
    ])
      expect(() => parseStatus(bad)).toThrow(RpcError)
  })
})

describe("rpc", () => {
  test("401 maps to a sign-in hint, 403 to a loopback hint", async () => {
    stubFetch(401, {})
    await expect(rpc("fleet.status", {})).rejects.toThrow(/one-time URL/)
    stubFetch(403, {})
    await expect(rpc("fleet.status", {})).rejects.toThrow(/loopback/)
  })

  test("an RPC error envelope throws with its code", async () => {
    stubFetch(200, { error: { code: -32601, message: "unknown method" } })
    let failure: RpcError | undefined
    try {
      await rpc("fleet.status", {})
    } catch (error) {
      failure = error as RpcError
    }
    expect(failure).toBeInstanceOf(RpcError)
    expect(failure?.code).toBe(-32601)
  })

  test("fetchStatus returns the parsed snapshot", async () => {
    stubFetch(200, {
      result: {
        daemon: { running: true, pid: 7, maxUsd: 50, concurrency: 2 },
        tasks: [],
        spendUsd: 0,
        pending: [],
      },
    })
    expect((await fetchStatus()).spendUsd).toBe(0)
  })
})
