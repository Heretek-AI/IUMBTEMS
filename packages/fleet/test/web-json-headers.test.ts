// JSON responders carry WEB_SECURITY_HEADERS (#282 fixed by the S5
// remediation: the JSON responders spread the same headers as the web-file
// and deny paths). This locks the fixed behavior: every responder below
// must carry every header.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fleetPaths } from "../src/state.ts"
import { ensureToken, type FleetSnapshot, TelemetryServer } from "../src/telemetry.ts"
import { mintWebTicket, WEB_SECURITY_HEADERS } from "../src/web.ts"

const HEADER_NAMES = Object.keys(WEB_SECURITY_HEADERS).map((name) => name.toLowerCase())

const snap = (): FleetSnapshot => ({
  daemon: { running: true, pid: 4242, maxUsd: 50, concurrency: 2 },
  tasks: [],
  spendUsd: 0,
  pending: [],
})

async function rig() {
  const state = await mkdtemp(path.join(tmpdir(), "es-web-json-"))
  const webRoot = path.join(state, "site")
  await mkdir(webRoot, { recursive: true })
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>swarm</title>")
  await mkdir(fleetPaths(state).dir, { recursive: true })
  const token = await ensureToken(state)
  const server = new TelemetryServer({ stateRoot: state, port: 0, token, getSnapshot: snap, webRoot })
  await server.start()
  return { state, server, token }
}

const raw = (
  port: number,
  head: string,
  body = "",
): Promise<{ status: number; headers: Record<string, string>; body: string }> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1", () => socket.write(head + body))
    let buffer = Buffer.alloc(0)
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
    })
    socket.on("close", () => {
      const text = buffer.toString("latin1")
      const at = text.indexOf("\r\n\r\n")
      const [statusLine, ...lines] = text.slice(0, at).split("\r\n")
      const headers: Record<string, string> = {}
      for (const line of lines) {
        const colon = line.indexOf(":")
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      resolve({ status: Number(statusLine!.split(" ")[1]), headers, body: text.slice(at + 4) })
    })
    socket.on("error", reject)
  })

const postRpc = (port: number, payload: unknown, extra: Record<string, string> = {}) => {
  const body = JSON.stringify(payload)
  return raw(
    port,
    `POST /fleet/rpc HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${Object.entries(
      extra,
    )
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("")}\r\n`,
    body,
  )
}

const postApprove = (port: number, target: string, payload: unknown, extra: Record<string, string> = {}) => {
  const body = JSON.stringify(payload)
  return raw(
    port,
    `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${Object.entries(
      extra,
    )
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("")}\r\n`,
    body,
  )
}

const expectSecurityHeaders = (headers: Record<string, string>, where: string): void => {
  for (const name of HEADER_NAMES) expect(headers[name], `${where}: ${name}`).toBeDefined()
  expect(headers["content-security-policy"] ?? "", `${where}: csp`).toContain("frame-ancestors 'none'")
}

describe("web JSON responders carry the strict headers (#282 fixed)", () => {
  test("successful JSON-RPC carries the strict headers", async () => {
    const { state, server, token } = await rig()
    try {
      const res = await postRpc(
        server.port,
        { method: "fleet.status", params: {} },
        { Authorization: `Bearer ${token}` },
      )
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toContain("application/json")
      expectSecurityHeaders(res.headers, "fleet.status 200")
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("JSON-RPC error envelopes carry the strict headers", async () => {
    const { state, server, token } = await rig()
    try {
      const auth = { Authorization: `Bearer ${token}` }
      // Unknown method and invalid params both answer 200 + error envelope via jsonBody.
      const unknown = await postRpc(server.port, { method: "nope", params: {} }, auth)
      expect(unknown.status).toBe(200)
      expect(unknown.body).toContain("-32601")
      expectSecurityHeaders(unknown.headers, "unknown method")
      const badParams = await postRpc(server.port, { method: "fleet.status", params: { extra: 1 } }, auth)
      expect(badParams.status).toBe(200)
      expect(badParams.body).toContain("-32602")
      expectSecurityHeaders(badParams.headers, "invalid params")
      // Unknown run answers 200 + -32603 via the fail path in dispatch.
      const unknownRun = await postRpc(server.port, { method: "evidence.claims", params: { runId: "nope" } }, auth)
      expect(unknownRun.status).toBe(200)
      expect(unknownRun.body).toContain("-32603")
      expectSecurityHeaders(unknownRun.headers, "unknown run")
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("bare 401/403/404 and approve JSON failures carry the strict headers", async () => {
    const { state, server } = await rig()
    try {
      // No credentials at all: 401 with no JSON body and no security headers.
      const anon = await postRpc(server.port, { method: "fleet.status", params: {} })
      expect(anon.status).toBe(401)
      expectSecurityHeaders(anon.headers, "rpc 401")
      // Approve preview without credentials: 401, also bare.
      const previewAnon = await postApprove(server.port, "/fleet/approve/preview", { runId: "t1", stage: "frontier" })
      expect(previewAnon.status).toBe(401)
      expectSecurityHeaders(previewAnon.headers, "approve preview 401")
      // Approve submit without a session: 401, bare.
      const submitAnon = await postApprove(server.port, "/fleet/approve", { ticket: "x", passphrase: "y" })
      expect(submitAnon.status).toBe(401)
      expectSecurityHeaders(submitAnon.headers, "approve submit 401")
      // Approve submit with a session but no Origin/CSRF: 403, bare.
      const ticket = await mintWebTicket(state)
      const login = await raw(
        server.port,
        `GET /?t=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      )
      const cookie = (login.headers["set-cookie"] ?? "").split(";")[0]!
      const noOrigin = await postApprove(
        server.port,
        "/fleet/approve",
        { ticket: "x", passphrase: "y" },
        { Cookie: cookie, "X-CSRF": "wrong" },
      )
      expect(noOrigin.status).toBe(403)
      expectSecurityHeaders(noOrigin.headers, "approve submit 403")
      // Malformed approve body answers 400 JSON via fail(): no headers.
      const malformed = await postApprove(
        server.port,
        "/fleet/approve/preview",
        { runId: "t1" },
        { Cookie: cookie, Origin: `http://127.0.0.1:${server.port}` },
      )
      expect(malformed.status).toBe(400)
      expect(malformed.body).toContain("want {runId")
      expectSecurityHeaders(malformed.headers, "approve preview 400")
      // Unknown POST target: 404, bare.
      const missing = await postApprove(server.port, "/fleet/nope", {})
      expect(missing.status).toBe(404)
      expectSecurityHeaders(missing.headers, "unknown target 404")
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("contrast: web-file responses do carry the headers", async () => {
    const { state, server } = await rig()
    try {
      const ticket = await mintWebTicket(state)
      const login = await raw(
        server.port,
        `GET /?t=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      )
      expect(login.status).toBe(200)
      expect(login.headers["content-security-policy"] ?? "").toContain("frame-ancestors 'none'")
      expect(login.headers["x-content-type-options"]).toBe("nosniff")
      // Deny paths carry them too.
      const anon = await raw(
        server.port,
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      )
      expect(anon.status).toBe(401)
      expect(anon.headers["content-security-policy"] ?? "").toContain("frame-ancestors 'none'")
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })
})
