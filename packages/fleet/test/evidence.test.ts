// Evidence explorer reads (#133): claims, claim detail with quote ranges,
// sources with seal status, and renderer exports. Read-only throughout —
// the no-write proof hashes the trees — with size caps on every payload.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  evidenceHash,
  factoryLayout,
  normalizeClaim,
  normalizeForQuote,
  SourceCache,
  writeJson,
} from "@heretek-ai/es-core"
import {
  exportEvidence,
  MAX_CLAIMS,
  readEvidenceClaim,
  readEvidenceClaims,
  readEvidenceSource,
  SOURCE_TEXT_CAP,
} from "../src/evidence.ts"

const SOURCE_TEXT =
  "Bun is a fast all-in-one JavaScript runtime. It ships a test runner, a bundler, and a package manager — all built in. Researchers measured startup at twelve milliseconds on commodity hardware."

const QUOTE = "Researchers measured startup at twelve milliseconds on commodity hardware"

async function rig(withRetraction = false) {
  const state = await mkdtemp(path.join(tmpdir(), "es-evidence-state-"))
  const repo = await mkdtemp(path.join(tmpdir(), "es-evidence-repo-"))
  const sources = path.join(repo, ".factory", "research", "sources")
  await mkdir(sources, { recursive: true })
  const sealed = new SourceCache(sources, state)
  const entry = await sealed.put({ url: "https://example.com/bun", text: SOURCE_TEXT, provider: "fetch" })
  const plain = new SourceCache(sources)
  const unsealed = await plain.put({
    url: "https://example.com/plain",
    text: `Plain source text. ${QUOTE}.`,
    provider: "fetch",
  })
  const claim = normalizeClaim({
    tag: "VERIFIED",
    statement: "Bun starts in about twelve milliseconds.",
    source: { sha256: entry.meta.sha256, quote: QUOTE },
  })
  const hypothesis = normalizeClaim({
    tag: "HYPOTHESIS",
    statement: "Faster startups improve test throughput.",
    falsification: "Measure suite times before and after.",
  })
  await writeJson(path.join(repo, ".factory", "research", "dossier.json"), {
    version: "1.1",
    mode: "research",
    subject: "demo",
    createdAt: new Date().toISOString(),
    claims: [claim, hypothesis],
    evidenceHash: evidenceHash([claim, hypothesis]),
  })
  await writeFile(path.join(repo, ".factory", "research", "REPORT.md"), "# Demo report\n\nBody.\n")
  if (withRetraction) {
    await mkdir(path.join(repo, ".factory", "claims"), { recursive: true })
    await writeJson(factoryLayout(repo).retractions, {
      version: 1,
      retractions: [
        {
          source: entry.meta.sha256,
          event: "RETRACTED",
          at: new Date().toISOString(),
          note: "withdrawn",
          by: "human:tester",
        },
      ],
    })
  }
  return { state, repo, sealedHash: entry.meta.sha256, unsealedHash: unsealed.meta.sha256, claim }
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
  await walk(root).catch(() => undefined)
  files.sort()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(path.relative(root, file))
    hash.update(await readFile(file))
  }
  return hash.digest("hex")
}

describe("evidence.claims", () => {
  test("it lists claims with tag, status, statement and source", async () => {
    const { state, repo } = await rig()
    try {
      const { claims, truncated } = await readEvidenceClaims(repo, {})
      expect(truncated).toBe(false)
      expect(claims.map((entry) => entry.tag).sort()).toEqual(["HYPOTHESIS", "VERIFIED"])
      const verified = claims.find((entry) => entry.tag === "VERIFIED")!
      expect(verified.status).toBe("LIVE")
      expect(verified.statement).toContain("twelve milliseconds")
      expect(verified.sourceSha).toMatch(/^[0-9a-f]{64}$/)
      expect(claims.find((entry) => entry.tag === "HYPOTHESIS")!.sourceSha).toBeNull()
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("tag, status and text filters narrow the list", async () => {
    const { state, repo } = await rig()
    try {
      expect((await readEvidenceClaims(repo, { tag: "VERIFIED" })).claims).toHaveLength(1)
      expect((await readEvidenceClaims(repo, { status: "STALE" })).claims).toHaveLength(0)
      expect((await readEvidenceClaims(repo, { text: "throughput" })).claims.map((entry) => entry.tag)).toEqual([
        "HYPOTHESIS",
      ])
      expect((await readEvidenceClaims(repo, { text: "no such statement" })).claims).toHaveLength(0)
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test(`lists truncate at ${MAX_CLAIMS}`, async () => {
    const { state, repo } = await rig()
    try {
      const extra = Array.from({ length: MAX_CLAIMS + 5 }, (_value, index) =>
        normalizeClaim({
          tag: "HYPOTHESIS",
          statement: `Bulk claim number ${index} for truncation.`,
          falsification: "Re-run the count.",
        }),
      )
      const { claims: current } = await readEvidenceClaims(repo, {})
      const dossierFile = path.join(repo, ".factory", "research", "dossier.json")
      const dossier = JSON.parse(await readFile(dossierFile, "utf8")) as { claims: unknown[] }
      dossier.claims.push(...extra)
      await writeFile(dossierFile, JSON.stringify(dossier))
      const seen = await readEvidenceClaims(repo, {})
      expect(seen.claims).toHaveLength(MAX_CLAIMS)
      expect(seen.truncated).toBe(true)
      expect(current).toHaveLength(2)
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("evidence.claim", () => {
  test("it returns quotes with original-text ranges, rank and files", async () => {
    const { state, repo, claim } = await rig()
    try {
      const detail = await readEvidenceClaim(repo, claim.id)
      expect(detail).not.toBeNull()
      expect(detail!.quotes).toHaveLength(1)
      const [quote] = detail!.quotes
      expect(quote!.verified).toBe(true)
      expect(quote!.ranges.length).toBeGreaterThan(0)
      for (const range of quote!.ranges) expect(SOURCE_TEXT.slice(range.start, range.end).length).toBeGreaterThan(0)
      expect(
        normalizeForQuote(SOURCE_TEXT.slice(quote!.ranges[0]!.start, quote!.ranges.at(-1)!.end)).replace(/\s+/g, ""),
      ).toBe(normalizeForQuote(QUOTE).replace(/\s+/g, ""))
      expect(detail!.rankExplanation.length).toBeGreaterThan(0)
      expect(detail!.retractions).toEqual([])
      expect(detail!.events).toEqual([])
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a retracted source degrades the claim and shows the retraction", async () => {
    const { state, repo, claim } = await rig(true)
    try {
      const detail = await readEvidenceClaim(repo, claim.id)
      expect(detail!.claim.status).toBe("STALE")
      expect(detail!.retractions).toHaveLength(1)
      expect(detail!.retractions[0]!.event).toBe("RETRACTED")
      expect(detail!.events.length).toBeGreaterThan(0)
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("unknown claims are null", async () => {
    const { state, repo } = await rig()
    try {
      expect(await readEvidenceClaim(repo, "no-such-claim")).toBeNull()
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("evidence.source", () => {
  test("sealed and unsealed sources report their seal status", async () => {
    const { state, repo, sealedHash, unsealedHash } = await rig()
    try {
      const sealed = await readEvidenceSource(repo, state, sealedHash)
      expect(sealed!.seal).toBe("sealed")
      expect(sealed!.text).toContain("twelve milliseconds")
      expect(sealed!.truncated).toBe(false)
      expect(sealed!.meta.url).toBe("https://example.com/bun")
      const unsealed = await readEvidenceSource(repo, state, unsealedHash)
      expect(unsealed!.seal).toBe("unsealed")
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a forged seal reports invalid", async () => {
    const { state, repo, sealedHash } = await rig()
    try {
      const sources = path.join(repo, ".factory", "research", "sources")
      const metaFile = path.join(sources, `${sealedHash}.json`)
      const meta = JSON.parse(await readFile(metaFile, "utf8")) as Record<string, unknown>
      meta.seal = "00".repeat(32)
      await writeFile(metaFile, JSON.stringify(meta))
      expect((await readEvidenceSource(repo, state, sealedHash))!.seal).toBe("invalid")
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("tampered text and unknown hashes are null; long text is capped", async () => {
    const { state, repo, sealedHash } = await rig()
    try {
      expect(await readEvidenceSource(repo, state, "ab".repeat(32))).toBeNull()
      expect(await readEvidenceSource(repo, state, "not-hex")).toBeNull()
      const sources = path.join(repo, ".factory", "research", "sources")
      await writeFile(path.join(sources, `${sealedHash}.md`), "tampered")
      expect(await readEvidenceSource(repo, state, sealedHash)).toBeNull()
      const big = `Long source. ${"x".repeat(SOURCE_TEXT_CAP + 100)} end.`
      const hash = createHash("sha256").update(big).digest("hex")
      await writeFile(path.join(sources, `${hash}.md`), big)
      await writeFile(
        path.join(sources, `${hash}.json`),
        JSON.stringify({ sha256: hash, url: "", retrieved: "", provider: "fetch", bytes: big.length }),
      )
      const seen = await readEvidenceSource(repo, state, hash)
      expect(seen!.truncated).toBe(true)
      expect(seen!.text.length).toBeLessThanOrEqual(SOURCE_TEXT_CAP)
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("evidence.export", () => {
  test("markdown and html exports reuse the dossier renderers", async () => {
    const { state, repo } = await rig()
    try {
      const md = await exportEvidence(repo, state, "markdown")
      expect(md?.format).toBe("markdown")
      expect(md?.body).toContain("twelve milliseconds")
      expect(md?.truncated).toBe(false)
      const html = await exportEvidence(repo, state, "html")
      expect(html?.body).toContain("<")
      expect(html?.body).toContain("twelve milliseconds")
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("missing dossiers are null", async () => {
    const { state, repo } = await rig()
    try {
      await rm(path.join(repo, ".factory", "research", "dossier.json"))
      expect(await exportEvidence(repo, state, "markdown")).toBeNull()
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("evidence: read-only", () => {
  test("claims, detail, source and export leave every file untouched", async () => {
    const { state, repo, claim, sealedHash } = await rig(true)
    try {
      const beforeRepo = await treeHash(repo)
      const beforeState = await treeHash(state)
      await readEvidenceClaims(repo, {})
      await readEvidenceClaim(repo, claim.id)
      await readEvidenceSource(repo, state, sealedHash)
      await exportEvidence(repo, state, "markdown")
      await exportEvidence(repo, state, "html")
      expect(await treeHash(repo)).toBe(beforeRepo)
      expect(await treeHash(state)).toBe(beforeState)
    } finally {
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("evidence.* over the bus", () => {
  const TOKEN = "evidence-bus-token-with-enough-length"

  async function bus(repoRoot: string, state: string) {
    const { TelemetryServer } = await import("../src/telemetry.ts")
    const { fleetPaths } = await import("../src/state.ts")
    const { mkdir: makeDir } = await import("node:fs/promises")
    await makeDir(fleetPaths(state).dir, { recursive: true })
    await writeFile(fleetPaths(state).token, TOKEN, { mode: 0o600 })
    await writeFile(
      fleetPaths(state).worktrees,
      JSON.stringify({
        v: 1,
        worktrees: {
          run1: {
            taskId: "run1",
            dir: repoRoot,
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
      token: TOKEN,
      getSnapshot: () => ({
        daemon: { running: true, pid: 1, maxUsd: 1, concurrency: 1 },
        tasks: [],
        spendUsd: 0,
        pending: [],
      }),
    })
    await server.start()
    return server
  }

  const call = (port: number, method: string, params: unknown) =>
    fetch(`http://127.0.0.1:${port}/fleet/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ method, params }),
    }).then((response) => response.json()) as Promise<{ result?: unknown; error?: { code: number; message: string } }>

  test("claims, detail, source and export round-trip; unknown runs and bad params fail", async () => {
    const { state, repo, claim, sealedHash } = await rig()
    const server = await bus(repo, state)
    try {
      const claims = await call(server.port, "evidence.claims", { runId: "run1", filter: { tag: "VERIFIED" } })
      expect((claims.result as { claims: unknown[] }).claims).toHaveLength(1)
      const detail = await call(server.port, "evidence.claim", { runId: "run1", id: claim.id })
      expect((detail.result as { quotes: unknown[] }).quotes).toHaveLength(1)
      const source = await call(server.port, "evidence.source", { runId: "run1", sha: sealedHash })
      expect((source.result as { seal: string }).seal).toBe("sealed")
      const exported = await call(server.port, "evidence.export", { runId: "run1", format: "markdown" })
      expect((exported.result as { body: string }).body).toContain("twelve milliseconds")
      expect((await call(server.port, "evidence.claims", { runId: "nope" })).error?.code).toBe(-32603)
      expect((await call(server.port, "evidence.claim", { runId: "run1", id: "nope" })).error?.code).toBe(-32603)
      expect((await call(server.port, "evidence.source", { runId: "run1", sha: "xyz" })).error?.code).toBe(-32603)
      expect((await call(server.port, "evidence.export", { runId: "run1", format: "pdf" })).error?.code).toBe(-32602)
      expect(
        (await call(server.port, "evidence.claims", { runId: "run1", filter: { tag: "VERIFIED", extra: 1 } })).error
          ?.code,
      ).toBe(-32602)
    } finally {
      await server.stop()
      await rm(state, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})
