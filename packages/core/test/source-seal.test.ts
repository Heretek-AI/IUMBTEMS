// #98 source-cache sealing: every cache construction goes through the sealed
// constructor, so planted unsealed entries are refused by scout witnessing,
// brief export and retract. Behavioural specs only (clean-room).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import { exportBrief } from "../src/claims/brief.ts"
import { normalizeClaim } from "../src/claims/claim.ts"
import { buildDossier, writeDossier } from "../src/claims/dossier.ts"
import { factoryLayout } from "../src/layout.ts"
import { normalizeSourceText, researchSourcesDir, SourceCache } from "../src/research/cache.ts"
import { scoutTools } from "../src/scout/ops.ts"
import { atomicWrite } from "../src/util/fs.ts"
import { sha256 } from "../src/util/hash.ts"

let root: string
let state: string
let signer: HumanSigner
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-seal-"))
  state = await mkdtemp(path.join(tmpdir(), "es-seal-state-"))
  await sealHumanKey("test-passphrase-1234", state)
  signer = await unlockHumanKey("test-passphrase-1234", state)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const OSV = {
  vulns: [
    {
      id: "GHSA-test-0001",
      summary: "Test advisory with enough detail to quote",
      database_specific: { severity: "HIGH" },
      affected: [],
    },
  ],
}
const osvFetch = (async () => Response.json(OSV)) as unknown as typeof fetch
const scout = { agent: "scout" }

/** Plant an entry directly on disk with no engine seal (a pre-seeded forgery). */
async function plantUnsealed(url: string, text: string): Promise<string> {
  const dir = researchSourcesDir(root)
  await mkdir(dir, { recursive: true })
  const normal = normalizeSourceText(text)
  const hash = sha256(normal)
  await atomicWrite(path.join(dir, `${hash}.md`), normal)
  await atomicWrite(
    path.join(dir, `${hash}.json`),
    `${JSON.stringify({ sha256: hash, url, retrieved: new Date().toISOString(), provider: "fetch", bytes: Buffer.byteLength(normal) })}\n`,
  )
  return hash
}

const sealed = () => new SourceCache(researchSourcesDir(root), state)

describe("H1: scout advisories seal what they write", () => {
  test("es_scout_advisories entries verify under a sealed reader", async () => {
    const all = scoutTools({ root, stateDir: state, fetch: osvFetch })
    const tool = (name: string) => all.find((item) => item.name === name)!
    await tool("es_scout_plan").execute(
      { objective: "seal probe", candidates: [{ name: "probe", source: "npm:seal-probe" }] },
      scout,
    )
    const out = await tool("es_scout_advisories").execute({ candidate: "probe" }, scout)
    const hash = /sha256:([0-9a-f]{64})/.exec(String(out))![1]!
    expect((await sealed().get(hash))?.meta.provider).toBe("osv")
  })
})

describe("H2: scout witnessing refuses planted entries", () => {
  test("es_scout_record refuses a VERIFIED claim quoting a planted unsealed source", async () => {
    const text = "The planted advisory claims ten million calls per second on a laptop."
    const hash = await plantUnsealed("https://evil.test/planted", text)
    expect(await sealed().get(hash)).toBeUndefined()
    const all = scoutTools({ root, stateDir: state })
    const tool = (name: string) => all.find((item) => item.name === name)!
    await tool("es_scout_plan").execute(
      { objective: "seal probe", candidates: [{ name: "probe", source: "local:./candidate-a" }] },
      scout,
    )
    await expect(
      tool("es_scout_record").execute(
        {
          candidate: "probe",
          maintenance: "stable",
          proposal: "reject",
          rationale: "planted evidence must not ground a record",
          claims: [
            {
              tag: "VERIFIED",
              statement: "It is fast.",
              source: { sha256: hash, quote: "ten million calls per second" },
            },
          ],
        },
        scout,
      ),
    ).rejects.toThrow("failed their witness check")
  })
})

describe("H3: brief export refuses planted entries", () => {
  test("exportBrief re-witnesses against the sealed cache: planted quotes fail", async () => {
    const text = "Independent benchmark reached 9.5 GB/s throughput on reference hardware."
    const hash = await plantUnsealed("https://evil.test/bench", text)
    const legacy = new SourceCache(researchSourcesDir(root))
    const claim = normalizeClaim({
      tag: "VERIFIED",
      statement: "The benchmark is reproducible.",
      source: { sha256: hash, quote: "benchmark reached 9.5 GB/s throughput" },
    })
    await mkdir(factoryLayout(root).research, { recursive: true })
    await writeFile(factoryLayout(root).researchReport, "# R\n")
    // A legacy dossier (written before sealing) witnesses fine unsealed.
    await writeDossier(
      factoryLayout(root).researchDossier,
      buildDossier({ mode: "research", subject: "s", claims: [claim] }),
      {
        cache: legacy,
      },
    )
    const { brief } = await exportBrief(root, { signer, stateDir: state })
    expect(brief.claims[0]!.witness.ok).toBe(false)
    expect(brief.sources[hash]).toBeUndefined()
  })
})

describe("misuse guard: no unsealed SourceCache in shipped code", () => {
  test("only research/cache.ts and researchCache construct the cache", async () => {
    const repo = path.resolve(import.meta.dir, "../../..")
    const hits: string[] = []
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith(".ts")) {
          const text = await readFile(full, "utf8")
          if (
            text.includes("new SourceCache(") &&
            full !== path.join(repo, "packages/core/src/research/cache.ts") &&
            full !== path.join(repo, "packages/core/src/research/ops.ts")
          )
            hits.push(path.relative(repo, full))
        }
      }
    }
    for (const pkg of ["core", "cli", "opencode", "testkit"])
      await walk(path.join(repo, "packages", pkg, "src")).catch(() => undefined)
    expect(hits).toEqual([])
  })
})
