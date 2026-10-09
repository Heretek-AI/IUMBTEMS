// Bus client (#129): strict response parsing, auth failure mapping. The
// fetch transport is stubbed per test; no DOM is touched.
import { afterEach, describe, expect, test } from "bun:test"
import {
  fetchApprovePreview,
  fetchConfigView,
  fetchStatus,
  fetchTask,
  parseStatus,
  previewConfigPlan,
  RpcError,
  rpc,
  submitApproval,
} from "./api.ts"

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
      tasks: [{ id: "a", title: "Alpha", status: "running", ceilingUSD: 5, spendUsd: 1, deps: [] }],
      spendUsd: 1,
      pending: [{ taskId: "a", reason: "frontier approval", stage: "frontier" }],
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

  test("fetchTask returns the parsed task, or throws when it is missing", async () => {
    stubFetch(200, {
      result: { task: { id: "a", title: "Alpha", status: "done", ceilingUSD: 5, spendUsd: 5, deps: [] } },
    })
    expect((await fetchTask("a")).title).toBe("Alpha")
    stubFetch(200, { error: { code: -32603, message: "unknown task" } })
    await expect(fetchTask("a")).rejects.toThrow(RpcError)
  })

  test("fetchConfigView parses the view and rejects malformed payloads", async () => {
    stubFetch(200, {
      result: {
        config: { licenseWhitelist: ["MIT"] },
        configHash: "abc",
        gates: { topN: 5 },
        gatesHash: null,
        drift: { clean: true, violations: [], hasBaseline: false },
        forbidden: ["embeddings"],
      },
    })
    const seen = await fetchConfigView()
    expect(seen.config).toEqual({ licenseWhitelist: ["MIT"] })
    expect(seen.gatesHash).toBeNull()
    stubFetch(200, { result: { config: {}, drift: {} } })
    await expect(fetchConfigView()).rejects.toThrow(RpcError)
  })

  test("previewConfigPlan returns the plan", async () => {
    stubFetch(200, {
      result: { ok: true, errors: [], oldHash: "a", newHash: "b", changedKeys: ["topN"], commands: ["x"] },
    })
    const plan = await previewConfigPlan("gates", { topN: 3 })
    expect(plan.ok).toBe(true)
    expect(plan.changedKeys).toEqual(["topN"])
  })

  test("fetchApprovePreview parses the preview and rejects malformed payloads", async () => {
    stubFetch(200, {
      ticket: "t",
      csrf: "c",
      subjectHash: "ab".repeat(32),
      summary: ["Idea: x"],
      files: [{ path: ".factory/frontier.json", sha256: "cd".repeat(32) }],
      spendCeilingUSD: 25,
      pending: true,
    })
    const seen = await fetchApprovePreview("t1", "frontier")
    expect(seen.summary).toEqual(["Idea: x"])
    expect(seen.files).toHaveLength(1)
    stubFetch(200, { ticket: "t" })
    await expect(fetchApprovePreview("t1", "frontier")).rejects.toThrow(RpcError)
  })

  test("submitApproval returns the result and surfaces refusal details", async () => {
    stubFetch(200, { ok: true, stage: "frontier", alreadyApproved: false, factoryStage: "RESEARCH" })
    const done = await submitApproval("t", "c", "pass")
    expect(done.factoryStage).toBe("RESEARCH")
    stubFetch(403, { error: "wrong passphrase", remaining: 3 })
    const failure = await submitApproval("t", "c", "nope").then(
      () => undefined,
      (error: unknown) => error as RpcError,
    )
    expect(failure).toBeInstanceOf(RpcError)
    expect(failure?.details.remaining).toBe(3)
  })
})
