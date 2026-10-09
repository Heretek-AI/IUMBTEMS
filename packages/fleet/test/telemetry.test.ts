// Telemetry bus (#126): auth, Host/Origin checks, read-only RPC, strict
// schemas, payload scrubbing, backlog replay and coalesced WS streams.
import { describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureToken, type FleetSnapshot, scrubPayload, TelemetryServer } from "../src/telemetry.ts"

const snapshot = (extra: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  daemon: { running: true, pid: 4242, maxUsd: 50, concurrency: 2 },
  tasks: [
    {
      id: "a",
      title: "Alpha",
      status: "running",
      ceilingUSD: 5,
      spendUsd: 1.25,
      deps: [],
      reason: "waiting on frontier",
    },
    { id: "b", title: "Beta", status: "pending", ceilingUSD: 5, spendUsd: 0, deps: ["a"] },
  ],
  spendUsd: 1.25,
  pending: [{ taskId: "a", reason: "frontier approval", stage: "frontier" }],
  ...extra,
})

const TOKEN = `test-token-${randomBytes(8).toString("hex")}`

async function serverFor(state: string, snap: FleetSnapshot = snapshot()) {
  const { fleetPaths } = await import("../src/state.ts")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(fleetPaths(state).dir, { recursive: true })
  await writeFile(fleetPaths(state).token, TOKEN, { mode: 0o600 })
  const server = new TelemetryServer({
    stateRoot: state,
    port: 0,
    token: TOKEN,
    getSnapshot: () => snap,
  })
  await server.start()
  return server
}

const rpc = (server: TelemetryServer, method: string, params: unknown, token: string | undefined) =>
  fetch(`http://127.0.0.1:${server.port}/fleet/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ method, params }),
  })

describe("auth and binding", () => {
  test("missing or bad token gives 401 on RPC and WS", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-bus-"))
    try {
      const server = await serverFor(state)
      try {
        expect((await rpc(server, "fleet.status", {}, undefined)).status).toBe(401)
        expect((await rpc(server, "fleet.status", {}, "wrong")).status).toBe(401)
        expect((await rpc(server, "fleet.status", {}, TOKEN)).status).toBe(200)
        // WS upgrade without a token is refused before the handshake.
        const wsStatus = await wsHandshake(server.port, {})
        expect(wsStatus).toBe(401)
        const wsOk = await wsHandshake(server.port, { authorization: `Bearer ${TOKEN}` })
        expect(wsOk).toBe(101)
      } finally {
        await server.stop()
      }
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a wrong Host or Origin gives 403", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-bus-"))
    try {
      const server = await serverFor(state)
      try {
        expect(
          await rawStatus(server.port, `GET /fleet/rpc HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n`),
        ).toBe(403)
        expect(await wsHandshake(server.port, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.com" })).toBe(
          403,
        )
      } finally {
        await server.stop()
      }
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("the server binds 127.0.0.1 only", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-bus-"))
    try {
      const server = await serverFor(state)
      try {
        expect(server.host).toBe("127.0.0.1")
      } finally {
        await server.stop()
      }
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("read-only RPC", () => {
  test("every method leaves state files untouched and rejects extra fields", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-bus-"))
    try {
      const { fleetPaths } = await import("../src/state.ts")
      const { mkdir, readFile } = await import("node:fs/promises")
      await mkdir(fleetPaths(state).dir, { recursive: true })
      await writeFile(path.join(fleetPaths(state).dir, "tasks.json"), JSON.stringify({ v: 1, tasks: {} }))
      const before = await readFile(path.join(fleetPaths(state).dir, "tasks.json"), "utf8")
      const server = await serverFor(state)
      try {
        for (const [method, params] of [
          ["fleet.status", {}],
          ["fleet.task", { id: "a" }],
          ["fleet.pending", {}],
          ["fleet.events", { since: 0 }],
        ] as const) {
          const response = await rpc(server, method, params, TOKEN)
          expect(response.status).toBe(200)
        }
        // Strict schemas: extra fields are rejected, unknown tasks 404-ish error.
        const extra = await rpc(server, "fleet.task", { id: "a", evil: 1 }, TOKEN)
        expect(extra.status).toBe(200)
        expect(((await extra.json()) as { error: unknown }).error).toBeDefined()
        const missing = (await (await rpc(server, "fleet.task", { id: "ghost" }, TOKEN)).json()) as { error: unknown }
        expect(missing.error).toBeDefined()
        expect(await readFile(path.join(fleetPaths(state).dir, "tasks.json"), "utf8")).toBe(before)
      } finally {
        await server.stop()
      }
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("payload scrubbing", () => {
  test("secret keys and planted secret values never appear", () => {
    const scrubbed = scrubPayload(
      { apiToken: "abc", nested: { password: "hunter2-hunter" }, ok: "fine", list: ["bearer xyzzy-plugh", "clean"] },
      ["hunter2-hunter", "xyzzy-plugh"],
    )
    const text = JSON.stringify(scrubbed)
    expect(text).not.toContain("abc")
    expect(text).not.toContain("hunter2-hunter")
    expect(text).not.toContain("xyzzy-plugh")
    expect(text).toContain("fine")
    expect(text).toContain("clean")
  })

  test("a token pasted into a task reason is redacted over RPC", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-bus-"))
    try {
      const snap = snapshot({
        tasks: [
          {
            id: "a",
            title: "Alpha",
            status: "failed",
            ceilingUSD: 5,
            spendUsd: 2,
            deps: [],
            reason: `crashed with token ${TOKEN}`,
          },
        ],
      })
      const server = await serverFor(state, snap)
      try {
        const body = (await (await rpc(server, "fleet.status", {}, TOKEN)).json()) as { result: unknown }
        expect(JSON.stringify(body)).not.toContain(TOKEN)
      } finally {
        await server.stop()
      }
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("events and coalescing", () => {
  test("backlog replays in monotonic order from since", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-bus-"))
    try {
      const server = await serverFor(state)
      try {
        server.log.append("changed", { taskId: "a", kind: "started" })
        server.log.append("changed", { taskId: "a", kind: "done" })
        server.log.append("liveness", { taskId: "b", headline: "working" })
        const body = (await (await rpc(server, "fleet.events", { since: 0 }, TOKEN)).json()) as {
          result: { events: Array<{ seq: number }> }
        }
        expect(body.result.events.map((event) => event.seq)).toEqual([1, 2, 3])
        const tail = (await (await rpc(server, "fleet.events", { since: 2 }, TOKEN)).json()) as {
          result: { events: Array<{ seq: number }> }
        }
        expect(tail.result.events.map((event) => event.seq)).toEqual([3])
      } finally {
        await server.stop()
      }
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a burst of 100 events emits at most 2 per channel", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-bus-"))
    try {
      const server = await serverFor(state)
      try {
        const socket = await wsSubscribe(server.port)
        // Let the server process the subscribe (empty replay) before the
        // burst: otherwise the burst becomes backlog and replays one by one.
        await new Promise((resolve) => setTimeout(resolve, 150))
        for (let i = 0; i < 100; i++) server.log.append("changed", { taskId: "a", kind: `tick-${i}` })
        const messages = await collectWs(socket, 1500)
        const changed = messages.filter((message) => message.type === "changed")
        expect(changed.length).toBeLessThanOrEqual(2)
        // ...and the latest wins (drop to latest per key).
        if (changed.length > 0) expect(JSON.stringify(changed.at(-1))).toContain("tick-99")
        socket.destroy()
      } finally {
        await server.stop()
      }
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("token file", () => {
  test("ensureToken creates a 0600 token once and keeps it", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-bus-"))
    try {
      const first = await ensureToken(state)
      const second = await ensureToken(state)
      expect(first).toBe(second)
      expect(first.length).toBeGreaterThanOrEqual(32)
      const { stat } = await import("node:fs/promises")
      const { fleetPaths } = await import("../src/state.ts")
      expect((await stat(fleetPaths(state).token)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})

// --- minimal test WebSocket client (dependency-free) ---

const wsKey = () => createHash("sha1").update(randomBytes(16)).digest("base64")

async function wsHandshake(port: number, headers: Record<string, string>): Promise<number> {
  const lines = [
    "GET /fleet/ws HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${wsKey()}`,
    "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "\r\n",
  ]
  const raw = await rawRequest(port, `${lines.join("\r\n")}`)
  return Number(/HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0)
}

const rawRequest = (port: number, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1", () => socket.write(text))
    let data = ""
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1")
      if (data.includes("\r\n\r\n")) {
        socket.destroy()
        resolve(data)
      }
    })
    socket.on("error", reject)
    setTimeout(() => {
      socket.destroy()
      resolve(data)
    }, 3000)
  })

const rawStatus = async (port: number, text: string): Promise<number> =>
  Number(/HTTP\/1\.1 (\d+)/.exec(await rawRequest(port, text))?.[1] ?? 0)

const frame = (text: string): Buffer => {
  const body = Buffer.from(text)
  const mask = randomBytes(4)
  const header = Buffer.from([0x81, 0x80 | body.length, ...mask])
  const masked = Buffer.alloc(body.length)
  for (let i = 0; i < body.length; i++) masked[i] = body[i]! ^ mask[i % 4]!
  return Buffer.concat([header, masked])
}

async function wsSubscribe(port: number) {
  const socket = createConnection(port, "127.0.0.1")
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  socket.write(
    [
      "GET /fleet/ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${wsKey()}`,
      "Sec-WebSocket-Version: 13",
      `Authorization: Bearer ${TOKEN}`,
      "\r\n",
    ].join("\r\n"),
  )
  // Wait for the 101, then subscribe from the backlog.
  await new Promise<void>((resolve) => {
    let data = ""
    const onData = (chunk: Buffer) => {
      data += chunk.toString("latin1")
      if (data.includes("\r\n\r\n")) {
        socket.removeListener("data", onData)
        resolve()
      }
    }
    socket.on("data", onData)
  })
  socket.write(frame(JSON.stringify({ subscribe: ["changed", "liveness"], since: 0 })))
  return socket
}

async function collectWs(
  socket: ReturnType<typeof createConnection>,
  ms: number,
): Promise<Array<{ type: string; seq?: number }>> {
  const messages: Array<{ type: string; seq?: number }> = []
  let buffer = Buffer.alloc(0)
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const second = buffer[1]!
      const length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        offset = 10
      }
      const size = length === 126 ? buffer.readUInt16BE(2) : length === 127 ? Number(buffer.readBigUInt64BE(2)) : length
      if (buffer.length < offset + size) return
      const opcode = buffer[0]! & 0x0f
      const body = buffer.subarray(offset, offset + size).toString("utf8")
      buffer = buffer.subarray(offset + size)
      if (opcode === 0x1) {
        try {
          messages.push(JSON.parse(body) as { type: string; seq?: number })
        } catch {
          // Keep collecting: a replay array parses as one message below.
          try {
            for (const item of JSON.parse(body) as Array<{ type: string; seq?: number }>) messages.push(item)
          } catch {
            // ignore
          }
        }
      }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, ms))
  return messages
}
