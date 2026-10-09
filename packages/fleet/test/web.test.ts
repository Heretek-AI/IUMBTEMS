// Web control plane serving (#129): single-use URL tickets exchanged for
// an HttpOnly SameSite=Strict session cookie, static UI serving with a
// strict CSP, Host/Origin fail-closed checks, and a human-only `es-fleet
// web` that mints the one-time URL.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fleetPaths } from "../src/state.ts"
import { ensureToken, type FleetSnapshot, TelemetryServer } from "../src/telemetry.ts"
import {
  mintWebTicket,
  parseSessionCookie,
  redeemWebTicket,
  WEB_SECURITY_HEADERS,
  WEB_SESSION_COOKIE,
} from "../src/web.ts"

const snap = (): FleetSnapshot => ({
  daemon: { running: true, pid: 4242, maxUsd: 50, concurrency: 2 },
  tasks: [],
  spendUsd: 0,
  pending: [],
})

async function rig() {
  const state = await mkdtemp(path.join(tmpdir(), "es-fleet-web-"))
  const webRoot = path.join(state, "site")
  await mkdir(webRoot, { recursive: true })
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>swarm</title>")
  await writeFile(path.join(webRoot, "app.js"), "console.log(1)")
  await mkdir(fleetPaths(state).dir, { recursive: true })
  const token = await ensureToken(state)
  const server = new TelemetryServer({ stateRoot: state, port: 0, token, getSnapshot: snap, webRoot })
  await server.start()
  return { state, webRoot, server, token }
}

const raw = (port: number, head: string): Promise<{ status: number; headers: Record<string, string>; body: string }> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1", () => socket.write(head))
    let buffer = Buffer.alloc(0)
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
    })
    socket.on("close", () => {
      const text = buffer.toString("latin1")
      const at = text.indexOf("\r\n\r\n")
      const header = text.slice(0, at)
      const [statusLine, ...lines] = header.split("\r\n")
      const status = Number(statusLine!.split(" ")[1])
      const headers: Record<string, string> = {}
      for (const line of lines) {
        const colon = line.indexOf(":")
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      resolve({ status, headers, body: text.slice(at + 4) })
    })
    socket.on("error", reject)
  })

const get = (port: number, target: string, headers: Record<string, string> = {}) =>
  raw(
    port,
    `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("")}\r\n`,
  )

describe("web tickets", () => {
  test("a ticket redeems once, then is dead", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-web-"))
    try {
      const ticket = await mintWebTicket(state)
      expect(ticket).toMatch(/^[0-9a-f]{64}$/)
      expect(await redeemWebTicket(state, ticket)).toBe(true)
      expect(await redeemWebTicket(state, ticket)).toBe(false)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("concurrent redeems grant exactly one winner", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-web-"))
    try {
      const ticket = await mintWebTicket(state)
      const results = await Promise.all(
        Array.from({ length: 10 }, () => redeemWebTicket(state, ticket)),
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("malformed and expired tickets are refused", async () => {    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-web-"))
    try {
      expect(await redeemWebTicket(state, "not-hex")).toBe(false)
      expect(await redeemWebTicket(state, "../token")).toBe(false)
      expect(await redeemWebTicket(state, "ab".repeat(32))).toBe(false)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("cookie parsing extracts the session id", () => {
    const id = "ab".repeat(32)
    expect(parseSessionCookie(`a=1; ${WEB_SESSION_COOKIE}=${id}; b=2`)).toBe(id)
    expect(parseSessionCookie("a=1")).toBeUndefined()
    // Non-hex values are never treated as sessions (fail-closed).
    expect(parseSessionCookie(`${WEB_SESSION_COOKIE}=abc123`)).toBeUndefined()
  })
})

describe("web serving", () => {
  test("the ticket exchange is single-use and sets a locked-down cookie", async () => {
    const { state, server } = await rig()
    try {
      const ticket = await mintWebTicket(state)
      const first = await get(server.port, `/?t=${ticket}`)
      expect(first.status).toBe(200)
      expect(first.body).toContain("swarm")
      const setCookie = first.headers["set-cookie"] ?? ""
      expect(setCookie).toContain(`${WEB_SESSION_COOKIE}=`)
      expect(setCookie).toMatch(/httponly/i)
      expect(setCookie).toMatch(/samesite=strict/i)
      // Second use of the same ticket is refused.
      const second = await get(server.port, `/?t=${ticket}`)
      expect(second.status).toBe(403)
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a bad ticket is refused without a cookie", async () => {
    const { state, server } = await rig()
    try {
      const res = await get(server.port, "/?t=ab".concat("cd".repeat(31)))
      expect(res.status).toBe(403)
      expect(res.headers["set-cookie"]).toBeUndefined()
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("anonymous loads are refused; the session cookie opens the UI", async () => {
    const { state, server } = await rig()
    try {
      expect((await get(server.port, "/")).status).toBe(401)
      const ticket = await mintWebTicket(state)
      const login = await get(server.port, `/?t=${ticket}`)
      const cookie = (login.headers["set-cookie"] ?? "").split(";")[0]!
      const authed = await get(server.port, "/", { Cookie: cookie })
      expect(authed.status).toBe(200)
      expect(authed.body).toContain("swarm")
      const asset = await get(server.port, "/app.js", { Cookie: cookie })
      expect(asset.status).toBe(200)
      expect(asset.headers["content-type"]).toContain("javascript")
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("every web response carries the strict security headers", async () => {
    const { state, server } = await rig()
    try {
      const ticket = await mintWebTicket(state)
      const login = await get(server.port, `/?t=${ticket}`)
      const csp = login.headers["content-security-policy"] ?? ""
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(login.headers["x-content-type-options"]).toBe("nosniff")
      expect(login.headers["referrer-policy"]).toBe("no-referrer")
      expect(WEB_SECURITY_HEADERS["content-security-policy"]).toContain("connect-src 'self'")
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a wrong Host or a non-loopback Origin is refused", async () => {
    const { state, server } = await rig()
    try {
      expect((await raw(server.port, `GET / HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n`)).status).toBe(403)
      const ticket = await mintWebTicket(state)
      const cookie = ((await get(server.port, `/?t=${ticket}`)).headers["set-cookie"] ?? "").split(";")[0]!
      expect((await get(server.port, "/", { Cookie: cookie, Origin: "https://evil.com" })).status).toBe(403)
      expect((await get(server.port, "/", { Cookie: cookie, Origin: `http://127.0.0.1:${server.port}` })).status).toBe(
        200,
      )
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("path traversal never escapes the web root", async () => {
    const { state, server } = await rig()
    try {
      const ticket = await mintWebTicket(state)
      const cookie = ((await get(server.port, `/?t=${ticket}`)).headers["set-cookie"] ?? "").split(";")[0]!
      // /../token would be the bus bearer token if traversal worked.
      expect((await get(server.port, "/../token", { Cookie: cookie })).status).toBe(404)
      expect((await get(server.port, "/%2e%2e/token", { Cookie: cookie })).status).toBe(404)
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("the session cookie authorizes read-only RPC only with a loopback Origin", async () => {
    const { state, server } = await rig()
    try {
      const ticket = await mintWebTicket(state)
      const cookie = ((await get(server.port, `/?t=${ticket}`)).headers["set-cookie"] ?? "").split(";")[0]!
      const body = JSON.stringify({ method: "fleet.status", params: {} })
      const rpc = (extra: Record<string, string>) =>
        raw(
          server.port,
          `POST /fleet/rpc HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${Object.entries(
            extra,
          )
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("")}\r\n${body}`,
        )
      expect((await rpc({ Cookie: cookie })).status).toBe(403)
      const ok = await rpc({ Cookie: cookie, Origin: `http://127.0.0.1:${server.port}` })
      expect(ok.status).toBe(200)
      expect(ok.body).toContain("4242")
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("es-fleet web", () => {
  // The CI/dev shell runs with ES_SANDBOX set: act as the human caller the
  // command requires by clearing it for the duration of each test.
  const asHuman = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = process.env.ES_SANDBOX
    delete process.env.ES_SANDBOX
    try {
      return await fn()
    } finally {
      if (previous === undefined) delete process.env.ES_SANDBOX
      else process.env.ES_SANDBOX = previous
    }
  }

  /** Capture everything a callback writes to stdout/stderr. */
  const capture = async (fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> => {
    const out: string[] = []
    const err: string[] = []
    const stdoutWrite = process.stdout.write.bind(process.stdout)
    const stderrWrite = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((chunk: unknown) => {
      out.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown) => {
      err.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const code = await fn()
      return { code, out: out.join(""), err: err.join("") }
    } finally {
      process.stdout.write = stdoutWrite
      process.stderr.write = stderrWrite
    }
  }

  test("it is refused inside an agent sandbox", async () => {
    const { main } = await import("../src/bin.ts")
    const previous = process.env.ES_SANDBOX
    process.env.ES_SANDBOX = "seat"
    try {
      const seen = await capture(() => main(["web"]))
      expect(seen.code).toBe(1)
      expect(seen.err).toMatch(/agent sandbox/)
    } finally {
      if (previous === undefined) delete process.env.ES_SANDBOX
      else process.env.ES_SANDBOX = previous
    }
  })

  test("it prints a one-time URL for a running daemon", async () => {
    const { main } = await import("../src/bin.ts")
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-web-"))
    try {
      const { fleetPaths } = await import("../src/state.ts")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(fleetPaths(state).dir, { recursive: true })
      await writeFile(path.join(fleetPaths(state).dir, "telemetry.json"), JSON.stringify({ port: 4242 }))
      await writeFile(fleetPaths(state).token, "test-token", { mode: 0o600 })
      const seen = await capture(() => asHuman(() => main(["web", "--state-dir", state])))
      expect(seen.code).toBe(0)
      expect(seen.out).toMatch(/http:\/\/127\.0\.0\.1:4242\/\?t=[0-9a-f]{64}/)
      // The printed ticket redeems exactly once.
      const printed = /t=([0-9a-f]{64})/.exec(seen.out)![1]!
      expect(await redeemWebTicket(state, printed)).toBe(true)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("it refuses when no daemon is running", async () => {
    const { main } = await import("../src/bin.ts")
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-web-"))
    try {
      const seen = await capture(() => asHuman(() => main(["web", "--state-dir", state])))
      expect(seen.code).toBe(1)
      expect(seen.err).toMatch(/not running/i)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})
