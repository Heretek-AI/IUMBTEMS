// Bus event client contract (#130): live WS delivery, replay on connect,
// refetch on reconnect, malformed frames dropped. This is the test-only
// exception to the web leaf-surface rule (AGENTS.md, docs/FLEET.md): it
// runtime-imports the fleet server harness, so it lives in `test/` —
// `src/` holds only shipped code with type-only fleet imports. The live
// test runs against a real TelemetryServer; the reconnect test uses an
// injected socket.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type BusEvent, type FleetSnapshot, fleetPaths, TelemetryServer } from "@heretek-ai/es-fleet"
import { type BusSocket, connectBus } from "../src/bus.ts"

const TOKEN = "bus-test-token-with-enough-length"

const fixture = (): FleetSnapshot => ({
  daemon: { running: true, pid: 7, maxUsd: 50, concurrency: 2 },
  tasks: [{ id: "a", title: "Alpha", status: "running", ceilingUSD: 5, spendUsd: 1, deps: [], reason: "building" }],
  spendUsd: 1,
  pending: [],
})

async function rig() {
  const state = await mkdtemp(path.join(tmpdir(), "es-web-bus-"))
  await mkdir(fleetPaths(state).dir, { recursive: true })
  await writeFile(fleetPaths(state).token, TOKEN, { mode: 0o600 })
  const server = new TelemetryServer({ stateRoot: state, port: 0, token: TOKEN, getSnapshot: fixture })
  await server.start()
  return { state, server }
}

const authed = (token: string) => (url: string) => {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[])
  return socket as unknown as BusSocket
}

describe("bus client against a real server", () => {
  test("backlog replays on connect and live events arrive", async () => {
    const { state, server } = await rig()
    try {
      await server.log.append("changed", { taskId: "a", kind: "started" })
      const seen: BusEvent[] = []
      let connects = 0
      const disconnect = connectBus({
        url: `ws://127.0.0.1:${server.port}/fleet/ws`,
        openSocket: authed(TOKEN),
        onEvent: (event) => {
          seen.push(event)
        },
        onConnect: () => {
          connects += 1
        },
      })
      try {
        await Bun.sleep(300)
        expect(connects).toBe(1)
        expect(seen.map((event) => event.seq)).toEqual([1])
        await server.log.append("liveness", { note: "tick" })
        await Bun.sleep(1200)
        expect(seen.map((event) => event.seq)).toEqual([1, 2])
        expect(seen[1]!.type).toBe("liveness")
      } finally {
        disconnect()
      }
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("bus client reconnect", () => {
  test("a dropped socket reconnects and refetches", async () => {
    const sockets: Array<{
      handlers: Record<string, ((event: unknown) => void) | undefined>
      sent: string[]
      closed: boolean
    }> = []
    const openSocket = (url: string): BusSocket => {
      const fake = {
        handlers: {} as Record<string, ((event: unknown) => void) | undefined>,
        sent: [] as string[],
        closed: false,
        send: (text: string) => {
          fake.sent.push(text)
        },
        close: () => {
          fake.closed = true
        },
      }
      sockets.push(fake)
      void url
      return {
        send: fake.send,
        close: fake.close,
        set onopen(fn: ((event: unknown) => void) | undefined) {
          fake.handlers.open = fn
        },
        set onmessage(fn: ((event: unknown) => void) | undefined) {
          fake.handlers.message = fn
        },
        set onclose(fn: ((event: unknown) => void) | undefined) {
          fake.handlers.close = fn
        },
        set onerror(fn: ((event: unknown) => void) | undefined) {
          fake.handlers.error = fn
        },
      }
    }
    const seen: BusEvent[] = []
    let connects = 0
    const disconnect = connectBus({
      url: "ws://127.0.0.1:1/fleet/ws",
      openSocket,
      backoffMs: () => 5,
      onEvent: (event) => {
        seen.push(event)
      },
      onConnect: () => {
        connects += 1
      },
    })
    try {
      expect(sockets).toHaveLength(1)
      // Malformed frames never reach onEvent and never kill the client.
      sockets[0]!.handlers.open?.({})
      sockets[0]!.handlers.message?.({ data: "not json" })
      sockets[0]!.handlers.message?.({ data: JSON.stringify({ type: "bogus" }) })
      expect(seen).toEqual([])
      // A well-formed event flows through.
      sockets[0]!.handlers.message?.({
        data: JSON.stringify({ seq: 1, at: "2026-10-09T12:00:00.000Z", type: "changed", payload: { taskId: "a" } }),
      })
      expect(seen.map((event) => event.seq)).toEqual([1])
      // The socket drops: the client reconnects and refetches.
      sockets[0]!.handlers.close?.({})
      await Bun.sleep(50)
      expect(sockets).toHaveLength(2)
      sockets[1]!.handlers.open?.({})
      expect(connects).toBe(2)
      expect(JSON.parse(sockets[1]!.sent[0]!).subscribe).toEqual(["changed", "liveness"])
    } finally {
      disconnect()
    }
    expect(sockets.at(-1)!.closed).toBe(true)
  })
})
