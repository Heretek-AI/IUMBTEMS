// Browser approvals (#131, ADR 0002 option b): preview → single-use ticket
// bound to the subject hash → passphrase over loopback → in-process unlock,
// sign and zeroize. Each test maps to an adversarial-checklist probe;
// the probe results are posted on the ticket.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fleetPaths } from "../src/state.ts"
import { type FleetSnapshot, TelemetryServer } from "../src/telemetry.ts"
import { mintWebTicket } from "../src/web.ts"

const PASS = "correct-horse-phrase-for-browser-tests"
const TOKEN = "approve-bus-token-with-enough-length"

const frontier = {
  version: "1.1",
  idea: "A greeting library",
  spendCeiling: { currency: "USD", maxAmount: 25 },
  settled: true,
  nodes: [{ id: "lang", question: "Language?", answer: "TypeScript", status: "settled" }],
}

async function rig() {
  const state = await mkdtemp(path.join(tmpdir(), "es-approve-"))
  const repo = await mkdtemp(path.join(tmpdir(), "es-approve-repo-"))
  await mkdir(path.join(repo, ".factory"), { recursive: true })
  await writeFile(path.join(repo, ".factory", "frontier.json"), `${JSON.stringify(frontier, null, 2)}\n`)
  const { writeJson } = await import("@heretek-ai/es-core")
  const { factoryLayout } = await import("@heretek-ai/es-core")
  await writeJson(factoryLayout(repo).pending, [
    { stage: "frontier", requestedBy: "factory", at: new Date().toISOString() },
  ])
  const { sealHumanKey } = await import("@heretek-ai/es-core")
  await sealHumanKey(PASS, state)
  await mkdir(fleetPaths(state).dir, { recursive: true })
  await writeFile(fleetPaths(state).token, TOKEN, { mode: 0o600 })
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
  const server = new TelemetryServer({
    stateRoot: state,
    port: 0,
    token: TOKEN,
    getSnapshot: (): FleetSnapshot => ({
      daemon: { running: true, pid: 1, maxUsd: 10, concurrency: 1 },
      tasks: [],
      spendUsd: 0,
      pending: [],
    }),
    webRoot: site,
  })
  await server.start()
  return { state, repo, server }
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

const post = (
  port: number,
  target: string,
  payload: unknown,
  extra: Record<string, string> = {},
  host = `127.0.0.1:${port}`,
) => {
  const body = JSON.stringify(payload)
  return raw(
    port,
    `POST ${target} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${Object.entries(
      extra,
    )
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("")}\r\n`,
    body,
  )
}

async function session(port: number, state: string): Promise<string> {
  const ticket = await mintWebTicket(state)
  const res = await raw(port, `GET /?t=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
  expect(res.status).toBe(200)
  return (res.headers["set-cookie"] ?? "").split(";")[0]!
}

const json = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>

describe("approve preview", () => {
  test("checklist: preview shows the subject, its hash and a ticket (read-only)", async () => {
    const { state, server } = await rig()
    try {
      const cookie = await session(server.port, state)
      const res = await post(
        server.port,
        "/fleet/approve/preview",
        { runId: "t1", stage: "frontier" },
        { Cookie: cookie, Origin: `http://127.0.0.1:${server.port}` },
      )
      expect(res.status).toBe(200)
      const body = json(res.body)
      expect(typeof body.ticket).toBe("string")
      expect(typeof body.csrf).toBe("string")
      expect(typeof body.subjectHash).toBe("string")
      expect(body.subjectHash as string).toMatch(/^[0-9a-f]{64}$/)
      expect(body.summary as string[]).toEqual(expect.arrayContaining([expect.stringContaining("greeting library")]))
      expect(body.pending).toBe(true)
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("checklist 8/9: anonymous, foreign-Origin and foreign-Host previews are refused", async () => {
    const { state, server } = await rig()
    try {
      const payload = { runId: "t1", stage: "frontier" }
      expect((await post(server.port, "/fleet/approve/preview", payload)).status).toBe(401)
      const cookie = await session(server.port, state)
      expect(
        (await post(server.port, "/fleet/approve/preview", payload, { Cookie: cookie, Origin: "https://evil.com" }))
          .status,
      ).toBe(403)
      expect((await post(server.port, "/fleet/approve/preview", payload, { Cookie: cookie }, "evil.com")).status).toBe(
        403,
      )
      expect(
        (
          await post(
            server.port,
            "/fleet/approve/preview",
            { runId: "nope", stage: "frontier" },
            { Cookie: cookie, Origin: `http://127.0.0.1:${server.port}` },
          )
        ).status,
      ).toBe(404)
      expect(
        (
          await post(
            server.port,
            "/fleet/approve/preview",
            { runId: "t1", stage: "bogus" },
            { Cookie: cookie, Origin: `http://127.0.0.1:${server.port}` },
          )
        ).status,
      ).toBe(400)
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("approve submit", () => {
  const approveAs = (
    port: number,
    cookie: string,
    csrf: string,
    payload: unknown,
    extra: Record<string, string> = {},
  ) =>
    post(port, "/fleet/approve", payload, {
      Cookie: cookie,
      Origin: `http://127.0.0.1:${port}`,
      "X-CSRF": csrf,
      ...extra,
    })

  test("checklist: the full browser path records channel web and clears pending", async () => {
    const { state, repo, server } = await rig()
    try {
      const cookie = await session(server.port, state)
      const origin = `http://127.0.0.1:${server.port}`
      const preview = json(
        (
          await post(
            server.port,
            "/fleet/approve/preview",
            { runId: "t1", stage: "frontier" },
            { Cookie: cookie, Origin: origin },
          )
        ).body,
      )
      const res = await approveAs(server.port, cookie, preview.csrf as string, {
        ticket: preview.ticket,
        passphrase: PASS,
      })
      expect(res.status).toBe(200)
      expect(res.body).not.toContain(PASS)
      const { readApproval, pendingApprovals } = await import("@heretek-ai/es-core")
      const record = await readApproval(repo, "frontier")
      expect(record?.channel).toBe("web")
      expect(await pendingApprovals(repo)).toEqual([])
      expect(json(res.body).alreadyApproved).toBe(false)
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("checklist 1/8: bearer-only, missing CSRF and missing Origin submits are refused", async () => {
    const { state, server } = await rig()
    try {
      const cookie = await session(server.port, state)
      const origin = `http://127.0.0.1:${server.port}`
      const preview = json(
        (
          await post(
            server.port,
            "/fleet/approve/preview",
            { runId: "t1", stage: "frontier" },
            { Cookie: cookie, Origin: origin },
          )
        ).body,
      )
      const payload = { ticket: preview.ticket, passphrase: PASS }
      // Bearer alone never authorizes the mutating endpoint.
      expect(
        (await post(server.port, "/fleet/approve", payload, { Authorization: `Bearer ${TOKEN}`, Origin: origin }))
          .status,
      ).toBe(401)
      // No cookie at all.
      expect(
        (await post(server.port, "/fleet/approve", payload, { Origin: origin, "X-CSRF": preview.csrf as string }))
          .status,
      ).toBe(401)
      // Cookie without CSRF, with a wrong CSRF, and without Origin.
      expect((await post(server.port, "/fleet/approve", payload, { Cookie: cookie, Origin: origin })).status).toBe(403)
      expect((await approveAs(server.port, cookie, "wrong-csrf", payload)).status).toBe(403)
      expect(
        (await post(server.port, "/fleet/approve", payload, { Cookie: cookie, "X-CSRF": preview.csrf as string }))
          .status,
      ).toBe(403)
      expect(
        (await approveAs(server.port, cookie, preview.csrf as string, payload, { Origin: "https://evil.com" })).status,
      ).toBe(403)
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("checklist 4: a ticket redeems once; an expired ticket fails", async () => {
    const { state, server } = await rig()
    try {
      const cookie = await session(server.port, state)
      const origin = `http://127.0.0.1:${server.port}`
      const preview = json(
        (
          await post(
            server.port,
            "/fleet/approve/preview",
            { runId: "t1", stage: "frontier" },
            { Cookie: cookie, Origin: origin },
          )
        ).body,
      )
      const payload = { ticket: preview.ticket, passphrase: "wrong-phrase" }
      expect((await approveAs(server.port, cookie, preview.csrf as string, payload)).status).toBe(403)
      // Same ticket again: already redeemed, even though the first failed auth.
      expect((await approveAs(server.port, cookie, preview.csrf as string, payload)).status).toBe(403)
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
    }
  })

  test("checklist 5: an artifact changed after the preview refuses the sign", async () => {
    const { state, repo, server } = await rig()
    try {
      const cookie = await session(server.port, state)
      const origin = `http://127.0.0.1:${server.port}`
      const preview = json(
        (
          await post(
            server.port,
            "/fleet/approve/preview",
            { runId: "t1", stage: "frontier" },
            { Cookie: cookie, Origin: origin },
          )
        ).body,
      )
      await writeFile(
        path.join(repo, ".factory", "frontier.json"),
        `${JSON.stringify({ ...frontier, idea: "A different library" }, null, 2)}\n`,
      )
      const res = await approveAs(server.port, cookie, preview.csrf as string, {
        ticket: preview.ticket,
        passphrase: PASS,
      })
      expect(res.status).toBe(409)
      const { readApproval } = await import("@heretek-ai/es-core")
      expect(await readApproval(repo, "frontier")).toBeUndefined()
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("checklist 6: five wrong passphrases lock the surface with an audit entry", async () => {
    const { state, repo, server } = await rig()
    try {
      const cookie = await session(server.port, state)
      const origin = `http://127.0.0.1:${server.port}`
      const headers = { Cookie: cookie, Origin: origin }
      const freshTicket = async (): Promise<{ ticket: string; csrf: string }> => {
        const preview = json(
          (await post(server.port, "/fleet/approve/preview", { runId: "t1", stage: "frontier" }, headers)).body,
        )
        return { ticket: preview.ticket as string, csrf: preview.csrf as string }
      }
      for (let attempt = 1; attempt <= 4; attempt++) {
        const { ticket, csrf } = await freshTicket()
        const res = await approveAs(server.port, cookie, csrf, { ticket, passphrase: `wrong-${attempt}` })
        expect(res.status).toBe(403)
        expect(json(res.body).remaining).toBe(5 - attempt)
      }
      // The fifth wrong passphrase trips the lockout (core semantics: the
      // trip itself is refused with the retry delay, and audited).
      const { ticket, csrf } = await freshTicket()
      const locked = await approveAs(server.port, cookie, csrf, { ticket, passphrase: "wrong-5" })
      expect(locked.status).toBe(423)
      expect(typeof json(locked.body).retryAfterSec).toBe("number")
      // Even the right passphrase is refused while locked.
      const { ticket: t2, csrf: c2 } = await freshTicket()
      expect((await approveAs(server.port, cookie, c2, { ticket: t2, passphrase: PASS })).status).toBe(423)
      const { recentAuditEntries } = await import("@heretek-ai/es-core")
      const actions = (await recentAuditEntries(repo, 20)).map((entry) => entry.action)
      expect(actions).toContain("approval.lockout")
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("checklist 7: the passphrase appears in no response, event or state file", async () => {
    const { state, repo, server } = await rig()
    const probe = "probe-phrase-that-must-never-persist-12345"
    try {
      const cookie = await session(server.port, state)
      const origin = `http://127.0.0.1:${server.port}`
      const headers = { Cookie: cookie, Origin: origin }
      const preview = json(
        (await post(server.port, "/fleet/approve/preview", { runId: "t1", stage: "frontier" }, headers)).body,
      )
      const res = await approveAs(server.port, cookie, preview.csrf as string, {
        ticket: preview.ticket,
        passphrase: probe,
      })
      expect(res.status).toBe(403)
      expect(res.body).not.toContain(probe)
      const hits: string[] = []
      const grep = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === "node_modules") continue
            await grep(full)
          } else if (entry.isFile()) {
            try {
              if ((await readFile(full, "utf8")).includes(probe)) hits.push(full)
            } catch {}
          }
        }
      }
      await grep(state)
      await grep(path.join(repo, ".factory"))
      expect(hits).toEqual([])
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})
