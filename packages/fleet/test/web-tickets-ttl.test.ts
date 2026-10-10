// Expired-ticket fixtures (#283, follow-up of #207): the TTL branches for
// both ticket kinds. Web tickets live as files holding an absolute expiry
// (`web.ts:87` returns Number(raw) > Date.now()); approve tickets live in
// memory with the same comparison (`approve.ts:34`). The existing suites
// cover malformed/missing web tickets and reuse-after-fail approve tickets
// only — these fixtures mint, then expire, then assert refusal at both the
// unit level and the HTTP level.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { ApproveTickets } from "../src/approve.ts"
import { fleetDir, fleetPaths } from "../src/state.ts"
import { type FleetSnapshot, TelemetryServer } from "../src/telemetry.ts"
import { mintWebTicket, redeemWebTicket } from "../src/web.ts"

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

const expireWebTicket = async (state: string, ticket: string): Promise<void> => {
  const file = path.join(fleetDir(state), "web-tickets", ticket)
  await writeFile(file, `${Date.now() - 1_000}\n`, { mode: 0o600 })
}

describe("web tickets: minted-then-expired fixtures (#283)", () => {
  test("an expired ticket file redeems to false and is consumed", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-web-ttl-"))
    try {
      const ticket = await mintWebTicket(state)
      await expireWebTicket(state, ticket)
      expect(await redeemWebTicket(state, ticket)).toBe(false)
      // Single-use claim consumed the file: a second redeem is still false.
      expect(await redeemWebTicket(state, ticket)).toBe(false)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("an expired ticket is refused at the HTTP exchange without a cookie", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-web-ttl-"))
    const webRoot = path.join(state, "site")
    await mkdir(webRoot, { recursive: true })
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>swarm</title>")
    await mkdir(fleetPaths(state).dir, { recursive: true })
    const server = new TelemetryServer({
      stateRoot: state,
      port: 0,
      token: "x".repeat(40),
      getSnapshot: (): FleetSnapshot => ({
        daemon: { running: true, pid: 1, maxUsd: 1, concurrency: 1 },
        tasks: [],
        spendUsd: 0,
        pending: [],
      }),
      webRoot,
    })
    await server.start()
    try {
      const ticket = await mintWebTicket(state)
      await expireWebTicket(state, ticket)
      const res = await raw(
        server.port,
        `GET /?t=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      )
      expect(res.status).toBe(403)
      expect(res.headers["set-cookie"]).toBeUndefined()
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("approve tickets: minted-then-expired fixtures (#283)", () => {
  test("an approve ticket past its TTL redeems to undefined (unit level)", async () => {
    const tickets = new ApproveTickets(20)
    const ticket = tickets.issue({ repoDir: "/tmp/repo", stage: "frontier", subjectHash: "ab".repeat(32) })
    expect(tickets.redeem(ticket)?.stage).toBe("frontier")
    const expiring = tickets.issue({ repoDir: "/tmp/repo", stage: "frontier", subjectHash: "ab".repeat(32) })
    await Bun.sleep(50)
    expect(tickets.redeem(expiring)).toBeUndefined()
    // Consumed whether valid or not: a second redeem is still undefined.
    expect(tickets.redeem(expiring)).toBeUndefined()
  })

  test("an expired approve ticket is refused at the submit endpoint (TTL branch)", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-approve-ttl-state-"))
    const repo = await mkdtemp(path.join(tmpdir(), "es-approve-ttl-repo-"))
    await mkdir(path.join(repo, ".factory"), { recursive: true })
    await writeFile(
      path.join(repo, ".factory", "frontier.json"),
      `${JSON.stringify({ version: "1.1", idea: "TTL probe", spendCeiling: { currency: "USD", maxAmount: 5 }, settled: true, nodes: [] }, null, 2)}\n`,
    )
    const { writeJson, factoryLayout, sealHumanKey } = await import("@heretek-ai/es-core")
    await writeJson(factoryLayout(repo).pending, [
      { stage: "frontier", requestedBy: "factory", at: new Date().toISOString() },
    ])
    const PASS = "ttl-probe-passphrase-for-expired-ticket-test"
    await sealHumanKey(PASS, state)
    await mkdir(fleetPaths(state).dir, { recursive: true })
    await writeFile(fleetPaths(state).token, "approve-ttl-token-with-enough-length", { mode: 0o600 })
    await writeJson(fleetPaths(state).worktrees, {
      v: 1,
      worktrees: {
        t1: {
          taskId: "t1",
          dir: repo,
          branch: "fleet/t1",
          base: "0".repeat(40),
          createdAt: new Date().toISOString(),
          status: "allocated",
        },
      },
    })
    const site = path.join(state, "site")
    await mkdir(site, { recursive: true })
    await writeFile(path.join(site, "index.html"), "<!doctype html>")
    // A 30 ms preview-ticket TTL: the preview below expires before submit.
    const server = new TelemetryServer({
      stateRoot: state,
      port: 0,
      token: "approve-ttl-token-with-enough-length",
      getSnapshot: (): FleetSnapshot => ({
        daemon: { running: true, pid: 1, maxUsd: 10, concurrency: 1 },
        tasks: [],
        spendUsd: 0,
        pending: [],
      }),
      webRoot: site,
      approveTicketTtlMs: 30,
    })
    await server.start()
    try {
      const { mintWebTicket } = await import("../src/web.ts")
      const ticket = await mintWebTicket(state)
      const login = await raw(
        server.port,
        `GET /?t=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      )
      expect(login.status).toBe(200)
      const cookie = (login.headers["set-cookie"] ?? "").split(";")[0]!
      const origin = `http://127.0.0.1:${server.port}`
      const post = (target: string, payload: unknown, extra: Record<string, string>) => {
        const body = JSON.stringify(payload)
        return raw(
          server.port,
          `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${Object.entries(
            extra,
          )
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("")}\r\n`,
          body,
        )
      }
      const preview = JSON.parse(
        (await post("/fleet/approve/preview", { runId: "t1", stage: "frontier" }, { Cookie: cookie, Origin: origin }))
          .body,
      ) as { ticket: string; csrf: string }
      expect(typeof preview.ticket).toBe("string")
      await Bun.sleep(80)
      const submit = await post(
        "/fleet/approve",
        { ticket: preview.ticket, passphrase: PASS },
        { Cookie: cookie, Origin: origin, "X-CSRF": preview.csrf },
      )
      expect(submit.status).toBe(403)
      expect(submit.body).toContain("unknown or expired ticket")
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})
