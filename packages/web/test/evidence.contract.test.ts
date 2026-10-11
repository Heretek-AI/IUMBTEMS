// Web evidence contract (#207 §2): the shipped web client (`src/api.ts`,
// type-only fleet imports) against the real in-process fleet server. This
// is the test-only harness-import exception (AGENTS.md): it runtime-imports
// the fleet server to prove the browser's fetchers parse live sealed
// evidence (claims, ranges, seal, exports) over the session cookie. `src/`
// stays type-only — nothing here ships.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { type FleetSnapshot, fleetPaths, TelemetryServer } from "@heretek-ai/es-fleet"
import {
  exportEvidenceDossier,
  fetchEvidenceClaim,
  fetchEvidenceClaims,
  fetchEvidenceSource,
  fetchStatus,
  fetchTask,
} from "../src/api.ts"
import { layoutEvidence } from "../src/evidence.ts"

const SOURCE_TEXT =
  "Bun is a fast all-in-one JavaScript runtime. It ships a test runner, a bundler, and a package manager — all built in. Researchers measured startup at twelve milliseconds on commodity hardware."
const QUOTE = "Researchers measured startup at twelve milliseconds on commodity hardware"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

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

async function rig() {
  const state = await mkdtemp(path.join(tmpdir(), "es-web-evidence-"))
  const repo = await mkdtemp(path.join(tmpdir(), "es-web-evidence-repo-"))
  // Relative core imports: the web package has no es-core dependency, and
  // the leaf boundary keeps `src/` type-only — this fixture setup lives in
  // the test-only harness exception, so it resolves core by path.
  const { SourceCache } = await import("../../core/src/research/cache.ts")
  const { normalizeClaim } = await import("../../core/src/claims/claim.ts")
  const { evidenceHash } = await import("../../core/src/claims/dossier.ts")
  const { writeJson } = await import("../../core/src/util/fs.ts")
  const { mintWebTicket } = await import("@heretek-ai/es-fleet")
  const sources = path.join(repo, ".factory", "research", "sources")
  await mkdir(sources, { recursive: true })
  const sealed = new SourceCache(sources, state)
  const entry = await sealed.put({ url: "https://example.com/web-contract", text: SOURCE_TEXT, provider: "fetch" })
  const claim = normalizeClaim({
    tag: "VERIFIED",
    statement: "Bun starts in about twelve milliseconds.",
    source: { sha256: entry.meta.sha256, quote: QUOTE },
  })
  await writeJson(path.join(repo, ".factory", "research", "dossier.json"), {
    version: "1.1",
    mode: "research",
    subject: "web-contract",
    createdAt: new Date().toISOString(),
    claims: [claim],
    evidenceHash: evidenceHash([claim]),
  })
  await writeFile(path.join(repo, ".factory", "research", "REPORT.md"), "# Contract\n\nBody.\n")
  const webRoot = path.join(state, "site")
  await mkdir(webRoot, { recursive: true })
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>swarm</title>")
  await mkdir(fleetPaths(state).dir, { recursive: true })
  const { ensureToken } = await import("@heretek-ai/es-fleet")
  const token = await ensureToken(state)
  await writeFile(
    fleetPaths(state).worktrees,
    JSON.stringify({
      v: 1,
      worktrees: {
        run1: {
          taskId: "run1",
          dir: repo,
          branch: "fleet/run1",
          base: "0".repeat(40),
          createdAt: new Date().toISOString(),
          status: "allocated",
        },
      },
    }),
  )
  const server = new TelemetryServer({
    stateRoot: state,
    port: 0,
    token,
    getSnapshot: (): FleetSnapshot => ({
      daemon: { running: true, pid: 7, maxUsd: 50, concurrency: 2 },
      tasks: [{ id: "run1", title: "Contract", status: "running", ceilingUSD: 5, spendUsd: 0, deps: [], reason: "x" }],
      spendUsd: 0,
      pending: [],
    }),
    webRoot,
  })
  await server.start()
  const ticket = await mintWebTicket(state)
  const login = await raw(
    server.port,
    `GET /?t=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
  )
  const cookie = (login.headers["set-cookie"] ?? "").split(";")[0]!
  const base = `http://127.0.0.1:${server.port}`
  const origin = base
  // The browser rides the session cookie same-origin; tests inject it the
  // same way (Cookie + loopback Origin) around the real fetch.
  const wrapped = globalThis.fetch
  globalThis.fetch = ((url: unknown, init: unknown) => {
    const headers = { ...((init as { headers?: Record<string, string> } | undefined)?.headers ?? {}), cookie, origin }
    return (wrapped as typeof fetch)(url as string, { ...((init as object) ?? {}), headers })
  }) as typeof fetch
  return { state, repo, server, base, sealedSha: entry.meta.sha256, sealedText: entry.text, claimId: claim.id }
}

describe("web evidence contract against the live fleet server (#207 §2)", () => {
  test("status/task fetchers parse the live snapshot", async () => {
    const { state, repo, server, base } = await rig()
    try {
      const status = await fetchStatus(base)
      expect(status.tasks.map((task) => task.id)).toEqual(["run1"])
      expect((await fetchTask("run1", base)).title).toBe("Contract")
    } finally {
      globalThis.fetch = realFetch
      await server.stop()
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("evidence fetchers match the sealed sources (sha, seal, ranges, export)", async () => {
    const { state, repo, server, base, sealedSha, sealedText, claimId } = await rig()
    try {
      const listed = await fetchEvidenceClaims("run1", { tag: "VERIFIED" }, base)
      expect(listed.claims).toHaveLength(1)
      expect(listed.claims[0]!.id).toBe(claimId)
      expect(listed.claims[0]!.sourceSha).toBe(sealedSha)
      // The claim graph draws the live edge.
      expect(layoutEvidence(listed.claims).edges).toEqual([{ from: claimId, to: sealedSha }])

      const detail = await fetchEvidenceClaim("run1", claimId, base)
      expect(detail.quotes).toHaveLength(1)
      expect(detail.quotes[0]!.verified).toBe(true)
      expect(detail.quotes[0]!.ranges.length).toBeGreaterThan(0)
      const [first, last] = [detail.quotes[0]!.ranges[0]!, detail.quotes[0]!.ranges.at(-1)!]
      expect(sealedText.slice(first.start, last.end)).toContain("twelve milliseconds")

      const source = await fetchEvidenceSource("run1", sealedSha, base)
      expect(source.seal).toBe("sealed")
      expect(source.text).toBe(sealedText)
      expect(source.meta.sha256).toBe(sealedSha)

      const exported = await exportEvidenceDossier("run1", "markdown", base)
      expect(exported.body).toContain("twelve milliseconds")
    } finally {
      globalThis.fetch = realFetch
      await server.stop()
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})
