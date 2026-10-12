// Browser config apply (#145, ADR 0002 I7 narrow): preview → single-use
// ticket bound to the previewed hash → passphrase over loopback → write.
// Each test maps to a config-apply probe (P1–P9); the probe results are
// posted on the ticket. `fleet.config.apply` stays an unknown RPC method
// (P8) — the mutating path is this ticketed function only, refusing agent
// sandboxes (P6), wrong Origins (P5) and hash drift (P4).
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CsrfTokens } from "../src/approve.ts"
import { applyConfigEdit, ConfigTickets, requestConfigTicket } from "../src/configview.ts"

const PASS = "correct-horse-phrase-for-config-tests"
const ORIGIN = "http://127.0.0.1:9"

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")
const canon = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

async function repo(config: unknown = { licenseWhitelist: ["MIT"] }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "es-configapply-repo-"))
  await mkdir(path.join(root, ".factory"), { recursive: true })
  await writeFile(path.join(root, ".factory", "config.json"), canon(config))
  await writeFile(path.join(root, ".factory", "gates.json"), canon({ topN: 5 }))
  return root
}

async function state(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "es-configapply-state-"))
  const { sealHumanKey } = await import("@heretek-ai/es-core")
  await sealHumanKey(PASS, dir)
  return dir
}

async function treeHash(root: string): Promise<string> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files.push(full)
    }
  }
  await walk(root)
  files.sort()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(path.relative(root, file))
    hash.update(await readFile(file))
  }
  return hash.digest("hex")
}

const humanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.ES_SANDBOX
  return env
}

async function session() {
  const csrfTokens = new CsrfTokens()
  const sessionId = "ab".repeat(32)
  return { csrfTokens, session: sessionId, csrf: csrfTokens.forSession(sessionId) }
}

describe("P9 happy path: preview to apply equals disk", () => {
  test("a previewed config edit applies with the passphrase and matches the preview hash", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    try {
      const next = { licenseWhitelist: ["MIT", "Apache-2.0"], research: { depth: 3 } }
      const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
      expect(issued.newHash).toBe(sha256(canon(next)))
      const done = await applyConfigEdit({
        repoRoot: root,
        stateRoot,
        tickets,
        csrfTokens,
        session: sessionId,
        csrf,
        origin: ORIGIN,
        ticket: issued.ticket,
        file: "config",
        content: next,
        passphrase: PASS,
        env: humanEnv(),
      })
      expect(done.ok).toBe(true)
      expect(done.newHash).toBe(issued.newHash)
      const onDisk = await readFile(path.join(root, ".factory", "config.json"), "utf8")
      expect(onDisk).toBe(canon(next))
      expect(sha256(onDisk)).toBe(issued.newHash)
      const { recentAuditEntries } = await import("@heretek-ai/es-core")
      const actions = (await recentAuditEntries(root, 10)).map((entry) => `${entry.action}:${entry.actor}`)
      expect(actions.some((entry) => entry.startsWith("config.apply:") && entry.includes("web"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})

describe("P1/P2/P3 ticket refusals", () => {
  test("P1: apply without a ticket (missing or unknown) is refused and writes nothing", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    const before = await treeHash(root)
    try {
      const next = { licenseWhitelist: ["MIT", "ISC"] }
      for (const bad of ["", "not-a-ticket", "ab".repeat(32)]) {
        let status = 0
        try {
          await applyConfigEdit({
            repoRoot: root,
            stateRoot,
            tickets,
            csrfTokens,
            session: sessionId,
            csrf,
            origin: ORIGIN,
            ticket: bad,
            file: "config",
            content: next,
            passphrase: PASS,
            env: humanEnv(),
          })
        } catch (error) {
          status = (error as { status?: number }).status ?? 0
        }
        expect(status).toBe(403)
      }
      expect(await treeHash(root)).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("P2: a ticket redeems once; the second apply is refused", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    try {
      const next = { licenseWhitelist: ["MIT", "ISC"] }
      const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
      const call = (passphrase: string) =>
        applyConfigEdit({
          repoRoot: root,
          stateRoot,
          tickets,
          csrfTokens,
          session: sessionId,
          csrf,
          origin: ORIGIN,
          ticket: issued.ticket,
          file: "config",
          content: next,
          passphrase,
          env: humanEnv(),
        })
      // First redeem fails auth but still consumes the ticket (single-use).
      await expect(call("wrong-phrase")).rejects.toMatchObject({ status: 403 })
      await expect(call(PASS)).rejects.toMatchObject({ status: 403 })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("P3: an expired ticket is refused", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets(0)
    const { csrfTokens, session: sessionId, csrf } = await session()
    const before = await treeHash(root)
    try {
      const next = { licenseWhitelist: ["MIT", "ISC"] }
      const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
      await expect(
        applyConfigEdit({
          repoRoot: root,
          stateRoot,
          tickets,
          csrfTokens,
          session: sessionId,
          csrf,
          origin: ORIGIN,
          ticket: issued.ticket,
          file: "config",
          content: next,
          passphrase: PASS,
          env: humanEnv(),
        }),
      ).rejects.toMatchObject({ status: 403 })
      expect(await treeHash(root)).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})

describe("P4 hash binding", () => {
  test("content differing from the preview is refused with no write", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    const before = await treeHash(root)
    try {
      const previewed = { licenseWhitelist: ["MIT", "ISC"] }
      const issued = await requestConfigTicket(root, { file: "config", content: previewed }, tickets)
      await expect(
        applyConfigEdit({
          repoRoot: root,
          stateRoot,
          tickets,
          csrfTokens,
          session: sessionId,
          csrf,
          origin: ORIGIN,
          ticket: issued.ticket,
          file: "config",
          content: { licenseWhitelist: ["MIT", "GPL-3.0-only"] },
          passphrase: PASS,
          env: humanEnv(),
        }),
      ).rejects.toMatchObject({ status: 409 })
      expect(await treeHash(root)).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("a file changed on disk since the preview is refused as stale", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    try {
      const next = { licenseWhitelist: ["MIT", "ISC"] }
      const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
      await writeFile(path.join(root, ".factory", "config.json"), canon({ licenseWhitelist: ["MIT", "BSD-3-Clause"] }))
      await expect(
        applyConfigEdit({
          repoRoot: root,
          stateRoot,
          tickets,
          csrfTokens,
          session: sessionId,
          csrf,
          origin: ORIGIN,
          ticket: issued.ticket,
          file: "config",
          content: next,
          passphrase: PASS,
          env: humanEnv(),
        }),
      ).rejects.toMatchObject({ status: 409 })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})

describe("P5/P6 transport refusals", () => {
  test("P5: a missing or foreign Origin is refused before the ticket is touched", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    const before = await treeHash(root)
    try {
      const next = { licenseWhitelist: ["MIT", "ISC"] }
      const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
      for (const origin of [undefined, "", "https://evil.com", "http://evil.com:9", "http://127.0.0.1.evil.com:9"]) {
        await expect(
          applyConfigEdit({
            repoRoot: root,
            stateRoot,
            tickets,
            csrfTokens,
            session: sessionId,
            csrf,
            origin,
            ticket: issued.ticket,
            file: "config",
            content: next,
            passphrase: PASS,
            env: humanEnv(),
          }),
        ).rejects.toMatchObject({ status: 403 })
      }
      // The ticket survives transport refusals (never looked at): it still redeems.
      const done = await applyConfigEdit({
        repoRoot: root,
        stateRoot,
        tickets,
        csrfTokens,
        session: sessionId,
        csrf,
        origin: ORIGIN,
        ticket: issued.ticket,
        file: "config",
        content: next,
        passphrase: PASS,
        env: humanEnv(),
      })
      expect(done.newHash).toBe(sha256(canon(next)))
      expect(before).not.toBe(await treeHash(root))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("P5b: a missing or wrong CSRF token is refused", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    try {
      const next = { licenseWhitelist: ["MIT", "ISC"] }
      const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
      await expect(
        applyConfigEdit({
          repoRoot: root,
          stateRoot,
          tickets,
          csrfTokens,
          session: sessionId,
          csrf: undefined,
          origin: ORIGIN,
          ticket: issued.ticket,
          file: "config",
          content: next,
          passphrase: PASS,
          env: humanEnv(),
        }),
      ).rejects.toMatchObject({ status: 403 })
      await expect(
        applyConfigEdit({
          repoRoot: root,
          stateRoot,
          tickets,
          csrfTokens,
          session: sessionId,
          csrf: "wrong-csrf",
          origin: ORIGIN,
          ticket: issued.ticket,
          file: "config",
          content: next,
          passphrase: PASS,
          env: humanEnv(),
        }),
      ).rejects.toMatchObject({ status: 403 })
      expect(csrf).not.toBe("wrong-csrf")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("P6: the apply refuses under ES_SANDBOX", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    const before = await treeHash(root)
    try {
      const next = { licenseWhitelist: ["MIT", "ISC"] }
      const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
      const failure = await applyConfigEdit({
        repoRoot: root,
        stateRoot,
        tickets,
        csrfTokens,
        session: sessionId,
        csrf,
        origin: ORIGIN,
        ticket: issued.ticket,
        file: "config",
        content: next,
        passphrase: PASS,
        env: { ...process.env, ES_SANDBOX: "seat" },
      }).then(
        () => undefined,
        (error: unknown) => error as Error & { status?: number },
      )
      expect(failure).toBeDefined()
      expect(failure?.status).toBe(403)
      expect(String(failure?.message)).toMatch(/sandbox/i)
      expect(await treeHash(root)).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})

describe("P7 passphrase hygiene and attempt limits", () => {
  test("a wrong passphrase is refused with remaining attempts and persists nowhere", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    const probe = "probe-phrase-that-must-never-persist-98765"
    try {
      const next = { licenseWhitelist: ["MIT", "ISC"] }
      const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
      const failure = await applyConfigEdit({
        repoRoot: root,
        stateRoot,
        tickets,
        csrfTokens,
        session: sessionId,
        csrf,
        origin: ORIGIN,
        ticket: issued.ticket,
        file: "config",
        content: next,
        passphrase: probe,
        env: humanEnv(),
      }).then(
        () => undefined,
        (error: unknown) => error as { status?: number; message?: string; remaining?: number },
      )
      expect(failure?.status).toBe(403)
      expect((failure as { details?: { remaining?: number } })?.details?.remaining).toBe(4)
      expect(String(failure?.message)).not.toContain(probe)
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
      await grep(stateRoot)
      await grep(path.join(root, ".factory"))
      expect(hits).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("five wrong passphrases lock the surface with an audit entry", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    try {
      const next = { licenseWhitelist: ["MIT", "ISC"] }
      for (let attempt = 1; attempt <= 4; attempt++) {
        const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
        const failure = await applyConfigEdit({
          repoRoot: root,
          stateRoot,
          tickets,
          csrfTokens,
          session: sessionId,
          csrf,
          origin: ORIGIN,
          ticket: issued.ticket,
          file: "config",
          content: next,
          passphrase: `wrong-${attempt}-phrase-long-enough`,
          env: humanEnv(),
        }).then(
          () => undefined,
          (error: unknown) => error as { status?: number; remaining?: number },
        )
        expect(failure?.status).toBe(403)
        expect((failure as { details?: { remaining?: number } })?.details?.remaining).toBe(5 - attempt)
      }
      const issued = await requestConfigTicket(root, { file: "config", content: next }, tickets)
      const locked = await applyConfigEdit({
        repoRoot: root,
        stateRoot,
        tickets,
        csrfTokens,
        session: sessionId,
        csrf,
        origin: ORIGIN,
        ticket: issued.ticket,
        file: "config",
        content: next,
        passphrase: "wrong-5-phrase-long-enough",
        env: humanEnv(),
      }).then(
        () => undefined,
        (error: unknown) => error as { status?: number; retryAfterSec?: number },
      )
      expect(locked?.status).toBe(423)
      expect(typeof (locked as { details?: { retryAfterSec?: number } })?.details?.retryAfterSec).toBe("number")
      const { recentAuditEntries } = await import("@heretek-ai/es-core")
      const entries = await recentAuditEntries(root, 20)
      // The I4 mechanism is shared with approvals (separate web-config
      // bucket); the payload names the config surface.
      expect(entries.map((entry) => entry.action)).toContain("approval.lockout")
      expect(
        entries.some(
          (entry) => entry.action === "approval.lockout" && (entry.payload as { stage?: string }).stage === "config",
        ),
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})

describe("P8 scope: gates stay terminal-only, no RPC or agent path", () => {
  test("gates content is refused for browser apply at request and at submit", async () => {
    const root = await repo()
    const stateRoot = await state()
    const tickets = new ConfigTickets()
    const { csrfTokens, session: sessionId, csrf } = await session()
    const before = await treeHash(root)
    try {
      await expect(requestConfigTicket(root, { file: "gates", content: { topN: 7 } }, tickets)).rejects.toThrow(
        /terminal-only/,
      )
      // Even with a live config ticket, submitting as gates is refused.
      const issued = await requestConfigTicket(
        root,
        { file: "config", content: { licenseWhitelist: ["MIT", "ISC"] } },
        tickets,
      )
      await expect(
        applyConfigEdit({
          repoRoot: root,
          stateRoot,
          tickets,
          csrfTokens,
          session: sessionId,
          csrf,
          origin: ORIGIN,
          ticket: issued.ticket,
          file: "gates",
          content: { topN: 7 },
          passphrase: PASS,
          env: humanEnv(),
        }),
      ).rejects.toMatchObject({ status: 403 })
      expect(await treeHash(root)).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("fleet.config.apply is still an unknown RPC method and no agent tool reaches the apply", async () => {
    const root = await repo()
    const { TelemetryServer } = await import("../src/telemetry.ts")
    const { fleetPaths } = await import("../src/state.ts")
    const TOKEN = "configapply-scope-token-with-enough-length"
    const busState = await mkdtemp(path.join(tmpdir(), "es-configapply-bus-"))
    try {
      await mkdir(fleetPaths(busState).dir, { recursive: true })
      await writeFile(fleetPaths(busState).token, TOKEN, { mode: 0o600 })
      const server = new TelemetryServer({
        stateRoot: busState,
        port: 0,
        token: TOKEN,
        getSnapshot: () => ({
          daemon: { running: true, pid: 1, maxUsd: 1, concurrency: 1 },
          tasks: [],
          spendUsd: 0,
          pending: [],
        }),
        configRoot: root,
      })
      await server.start()
      try {
        const res = (await fetch(`http://127.0.0.1:${server.port}/fleet/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ method: "fleet.config.apply", params: {} }),
        }).then((response) => response.json())) as { error?: { code: number } }
        expect(res.error?.code).toBe(-32601)
      } finally {
        await server.stop()
      }
      const { esTools } = await import("@heretek-ai/es-core")
      const names = esTools({ root, seat: "programmer" } as never).map((tool) => tool.name)
      expect(names.some((name) => /config.*apply|apply.*config/i.test(name))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(busState, { recursive: true, force: true })
    }
  })
})
