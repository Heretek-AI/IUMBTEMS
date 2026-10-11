// Web control plane integration (#207 §2): fleet web served in-process
// against a run produced on the real testkit host (scripted fake LLM).
// The host writes a marker via @@CALL (real host tools, fake model); the
// sealed evidence (SourceCache + dossier) lives in that host directory and
// is served as run `run1` behind the single-use ticket exchange. Fetches go
// over the web session (cookie + loopback Origin) for status/task/evidence,
// asserting the served evidence matches the sealed sources (sha, seal,
// quote ranges).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { evidenceHash, normalizeClaim, normalizeForQuote, SourceCache, writeJson } from "@heretek-ai/es-core"
import { boot, directiveScript, type Harness } from "@heretek-ai/es-testkit"
import { fleetPaths } from "../src/state.ts"
import { ensureToken, type FleetSnapshot, TelemetryServer } from "../src/telemetry.ts"
import { mintWebTicket } from "../src/web.ts"

const SOURCE_TEXT =
  "Bun is a fast all-in-one JavaScript runtime. It ships a test runner, a bundler, and a package manager — all built in. Researchers measured startup at twelve milliseconds on commodity hardware."
const QUOTE = "Researchers measured startup at twelve milliseconds on commodity hardware"
const STATEMENT = "Bun starts in about twelve milliseconds."

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
      const headers: Record<string, string> = {}
      for (const line of lines) {
        const colon = line.indexOf(":")
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      resolve({ status: Number(statusLine!.split(" ")[1]), headers, body: text.slice(at + 4) })
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

describe("web integration on the testkit host (#207 §2)", () => {
  let h: Harness
  let state = ""
  let server: TelemetryServer | undefined
  let cookie = ""
  let origin = ""
  let sealedSha = ""
  let sealedText = ""
  let claimId = ""
  let hostTools: Array<{ name: string; status: string }> = []

  beforeAll(async () => {
    state = await mkdtemp(path.join(tmpdir(), "es-web-int-state-"))
    h = await boot({
      git: true,
      script: directiveScript,
      files: { "README.md": "# web integration\n" },
    })
    // The run is produced on the host: a scripted seat turn through @@CALL
    // (real host tools, fake model) writes into the host directory.
    const result = await h.run(
      `seed web run @@CALL write {"path": "web-note.txt", "content": "web integration marker\\n"}@@`,
    )
    hostTools = result.tools.map((tool) => ({ name: tool.name, status: tool.status }))

    const webRoot = path.join(state, "site")
    await mkdir(webRoot, { recursive: true })
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>swarm</title>")
    await writeFile(path.join(webRoot, "app.js"), "console.log(1)")
    await mkdir(fleetPaths(state).dir, { recursive: true })
    const token = await ensureToken(state)

    // Run `run1` is the host directory itself.
    await writeFile(
      fleetPaths(state).worktrees,
      JSON.stringify({
        v: 1,
        worktrees: {
          run1: {
            taskId: "run1",
            dir: h.directory,
            branch: "fleet/run1",
            base: "0".repeat(40),
            createdAt: new Date().toISOString(),
            status: "allocated",
          },
        },
      }),
    )

    // Sealed evidence in the host directory (engine key lives in the fleet
    // state dir, so the served seal verifies as `sealed`).
    const sources = path.join(h.directory, ".factory", "research", "sources")
    await mkdir(sources, { recursive: true })
    const sealed = new SourceCache(sources, state)
    const entry = await sealed.put({ url: "https://example.com/web-int", text: SOURCE_TEXT, provider: "fetch" })
    sealedSha = entry.meta.sha256
    sealedText = entry.text
    const claim = normalizeClaim({
      tag: "VERIFIED",
      statement: STATEMENT,
      source: { sha256: entry.meta.sha256, quote: QUOTE },
    })
    claimId = claim.id
    await writeJson(path.join(h.directory, ".factory", "research", "dossier.json"), {
      version: "1.1",
      mode: "research",
      subject: "web-int",
      createdAt: new Date().toISOString(),
      claims: [claim],
      evidenceHash: evidenceHash([claim]),
    })
    await writeFile(path.join(h.directory, ".factory", "research", "REPORT.md"), "# Web int\n\nBody.\n")

    const snapshot = (): FleetSnapshot => ({
      daemon: { running: true, pid: 1, maxUsd: 10, concurrency: 1 },
      tasks: [
        {
          id: "run1",
          title: "Web int",
          status: "running",
          ceilingUSD: 5,
          spendUsd: 0,
          deps: [],
          reason: "testing",
        },
      ],
      spendUsd: 0,
      pending: [],
    })
    server = new TelemetryServer({ stateRoot: state, port: 0, token, getSnapshot: snapshot, webRoot })
    await server.start()
    origin = `http://127.0.0.1:${server.port}`
    const ticket = await mintWebTicket(state)
    const login = await get(server.port, `/?t=${ticket}`)
    if (login.status !== 200) throw new Error(`ticket exchange failed: ${login.status}`)
    cookie = (login.headers["set-cookie"] ?? "").split(";")[0]!
    if (!cookie) throw new Error("ticket exchange set no cookie")
  }, 120_000)

  afterAll(async () => {
    await server?.stop().catch(() => undefined)
    await h?.close()
    if (state) await rm(state, { recursive: true, force: true })
  })

  const rpc = (method: string, params: unknown): Promise<{ result?: any; error?: { code: number; message: string } }> =>
    fetch(`http://127.0.0.1:${server!.port}/fleet/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin,
      },
      body: JSON.stringify({ method, params }),
    }).then((response) => response.json()) as Promise<{
      result?: any
      error?: { code: number; message: string }
    }>

  test("the host produced the run directory via the scripted fake LLM", async () => {
    expect(hostTools).toEqual([{ name: "write", status: "completed" }])
    expect(await readFile(path.join(h.directory, "web-note.txt"), "utf8")).toContain("web integration marker")
  })

  test("fleet.status and fleet.task round-trip over the web session", async () => {
    const status = await rpc("fleet.status", {})
    expect(status.error).toBeUndefined()
    expect(status.result.daemon.running).toBe(true)
    expect(status.result.tasks.map((task: { id: string }) => task.id)).toEqual(["run1"])
    const task = await rpc("fleet.task", { id: "run1" })
    expect(task.error).toBeUndefined()
    expect(task.result.task.id).toBe("run1")
    expect(task.result.task.title).toBe("Web int")
  })

  test("evidence.claims lists the sealed claim with its source sha", async () => {
    const listed = await rpc("evidence.claims", { runId: "run1", filter: { tag: "VERIFIED" } })
    expect(listed.error).toBeUndefined()
    expect(listed.result.claims).toHaveLength(1)
    const [entry] = listed.result.claims
    expect(entry.id).toBe(claimId)
    expect(entry.tag).toBe("VERIFIED")
    expect(entry.status).toBe("LIVE")
    expect(entry.statement).toContain("twelve milliseconds")
    expect(entry.sourceSha).toBe(sealedSha)
  })

  test("evidence.claim returns verified ranges that slice back to the quote", async () => {
    const detail = await rpc("evidence.claim", { runId: "run1", id: claimId })
    expect(detail.error).toBeUndefined()
    expect(detail.result.quotes).toHaveLength(1)
    const [quote] = detail.result.quotes
    expect(quote.quote).toBe(QUOTE)
    expect(quote.verified).toBe(true)
    expect(quote.ranges.length).toBeGreaterThan(0)
    // Every range points into the sealed source text on disk.
    const onDisk = await readFile(path.join(h.directory, ".factory", "research", "sources", `${sealedSha}.md`), "utf8")
    expect(onDisk).toBe(sealedText)
    for (const range of quote.ranges) {
      expect(range.start).toBeGreaterThanOrEqual(0)
      expect(range.end).toBeLessThanOrEqual(sealedText.length)
      expect(range.end).toBeGreaterThan(range.start)
    }
    const covered = normalizeForQuote(sealedText.slice(quote.ranges[0].start, quote.ranges.at(-1).end)).replace(
      /\s+/g,
      "",
    )
    expect(covered).toBe(normalizeForQuote(QUOTE).replace(/\s+/g, ""))
    expect(detail.result.rankExplanation.length).toBeGreaterThan(0)
  })

  test("evidence.source matches the sealed bytes (sha + seal status)", async () => {
    const source = await rpc("evidence.source", { runId: "run1", sha: sealedSha })
    expect(source.error).toBeUndefined()
    expect(source.result.meta.sha256).toBe(sealedSha)
    expect(source.result.meta.url).toBe("https://example.com/web-int")
    expect(source.result.seal).toBe("sealed")
    expect(source.result.text).toBe(sealedText)
    expect(source.result.truncated).toBe(false)
    // Content-addressed: the served bytes hash to their own name.
    expect(createHash("sha256").update(source.result.text).digest("hex")).toBe(sealedSha)
    expect(source.result.text).toContain(QUOTE)
  })

  test("evidence.export renders the dossier through the web session", async () => {
    const exported = await rpc("evidence.export", { runId: "run1", format: "markdown" })
    expect(exported.error).toBeUndefined()
    expect(exported.result.format).toBe("markdown")
    expect(exported.result.body).toContain("twelve milliseconds")
  })

  test("the session serves the UI with the strict headers", async () => {
    const home = await get(server!.port, "/", { Cookie: cookie })
    expect(home.status).toBe(200)
    expect(home.body).toContain("swarm")
    expect(home.headers["content-security-policy"] ?? "").toContain("frame-ancestors 'none'")
    expect(home.headers["x-content-type-options"]).toBe("nosniff")
  })
})
