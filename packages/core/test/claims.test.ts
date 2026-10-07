// The evidential claim stack. Ported tests cite the legacy test they encode
// (d66328c:<path>:<line>); everything else is new 1.1 behaviour.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  applyDegradation,
  auditMarkdown,
  buildDossier,
  type Claim,
  ClaimError,
  type ClaimInput,
  ClaimStore,
  checkLocation,
  claimsFromAudit,
  computeEpistemicScoreFromClaims,
  type Dossier,
  DossierRefusal,
  exportBrief,
  factoryLayout,
  hashJson,
  NK_MAX_FIELD,
  normalizeClaim,
  normalizeNegativeKnowledge,
  rankClaims,
  rankDossiers,
  readRetractions,
  recordRetraction,
  researchSourcesDir,
  SourceCache,
  sha256,
  stripTags,
  verifyBrief,
  witnessClaim,
  writeDossier,
} from "../src/index.ts"

let root: string
let state: string
let cache: SourceCache
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "es-claims-"))
  state = await mkdtemp(path.join(tmpdir(), "es-claims-state-"))
  cache = new SourceCache(researchSourcesDir(root))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

const at = new Date("2026-10-07T12:00:00Z")
const now = () => at

// ------------------------------------------------------------------ normalisation

describe("normalizeClaim (d66328c:runner/tests/test_claim_witness.py)", () => {
  test("each kind gets its default tag (:29, :47, :62, :75)", () => {
    expect(normalizeClaim({ kind: "claim", statement: "s" }).tag).toBe("VERIFIED")
    expect(normalizeClaim({ kind: "inference", statement: "s" }).tag).toBe("INFERRED")
    expect(normalizeClaim({ kind: "hypothesis", statement: "s" }).tag).toBe("HYPOTHESIS")
    expect(normalizeClaim({ kind: "negative_knowledge", query: "q", finding: "f" }).tag).toBe("NEGATIVE_KNOWLEDGE")
  })

  test("a string parent becomes a list (:83); a missing tag defaults by kind (:87)", () => {
    const parent = "a".repeat(64)
    expect(normalizeClaim({ kind: "inference", statement: "from a", parents: parent }).parents).toEqual([parent])
    expect(normalizeClaim({ kind: "hypothesis", statement: "x", tag: null }).tag).toBe("HYPOTHESIS")
  })

  test("1.1: an empty or unknown tag is an error, not a value a later check must catch", () => {
    expect(() => normalizeClaim({ tag: "", statement: "s" })).toThrow(ClaimError)
    expect(() => normalizeClaim({ tag: "PROBABLY", statement: "s" })).toThrow(/unknown epistemic tag/)
    expect(() => normalizeClaim({ tag: "VERIFIED", statement: "   " })).toThrow(/no statement/)
  })

  test("ids are content hashes: equal content, equal id; NK rows never collide on 'UNKNOWN' (legacy B2)", () => {
    const one = normalizeClaim({ kind: "negative_knowledge", query: "q1", finding: "nothing" })
    const two = normalizeClaim({ kind: "negative_knowledge", query: "q2", finding: "nothing" })
    expect(one.id).not.toBe(two.id)
    expect(normalizeClaim({ kind: "negative_knowledge", query: "q1", finding: "nothing" }).id).toBe(one.id)
    // Parent order does not change the id.
    const [a, b] = ["a".repeat(64), "b".repeat(64)]
    expect(normalizeClaim({ tag: "INFERRED", statement: "s", parents: [a, b] }).id).toBe(
      normalizeClaim({ tag: "INFERRED", statement: "s", parents: [b, a] }).id,
    )
  })
})

describe("negative knowledge hardening (d66328c:runner/tests/test_nk_hardening.py)", () => {
  const VALID = {
    query: "Zero-latency PCIe streaming ZK provers",
    finding: "No architecture eliminates bus transfer overhead.",
  }
  const MALFORMED = [
    { query: "Missing finding entirely" },
    { finding: "Missing query entirely" },
    { query: null, finding: "Null query" },
    { query: "Null finding", finding: null },
    { query: 123, finding: "Non-string query" },
    { query: "Non-string finding", finding: ["list"] },
    { query: "", finding: "Empty query" },
    { query: "Whitespace query", finding: "   " },
    "just a string",
    null,
    42,
  ]

  test("a valid row passes (:62); every malformed row is dropped and counted (:67)", () => {
    expect(normalizeNegativeKnowledge([VALID]).valid).toHaveLength(1)
    expect(normalizeNegativeKnowledge(MALFORMED)).toEqual({ valid: [], dropped: MALFORMED.length })
  })

  test("non-lists coerce or count (:78, :269): undefined → nothing, one object → one row", () => {
    expect(normalizeNegativeKnowledge(undefined)).toEqual({ valid: [], dropped: 0 })
    expect(normalizeNegativeKnowledge(VALID).valid).toHaveLength(1)
    expect(normalizeNegativeKnowledge("nope")).toEqual({ valid: [], dropped: 1 })
  })

  test("invisible-only sides are dropped; visible text is kept with invisibles stripped (:106)", () => {
    for (const invisible of ["​​", "﻿", "‌‍", "​ ‌"]) {
      expect(normalizeNegativeKnowledge([{ query: invisible, finding: "real" }])).toEqual({ valid: [], dropped: 1 })
      expect(normalizeNegativeKnowledge([{ query: "real", finding: invisible }])).toEqual({ valid: [], dropped: 1 })
    }
    const { valid } = normalizeNegativeKnowledge([{ query: "​q﻿", finding: "f‍" }])
    expect([valid[0]?.query, valid[0]?.finding]).toEqual(["q", "f"])
  })

  test("statement-shaped, numeric and non-object rows are dropped (:128)", () => {
    const bad = [
      { statement: "Provers are slow.", source_hash: "abc" },
      { query: 123, finding: "numeric" },
      { query: "q", finding: 456 },
      { query: "", finding: "empty" },
      { query: "   ", finding: "ws" },
      "a string row",
      null,
      42,
      ["q", "f"],
    ]
    expect(normalizeNegativeKnowledge(bad)).toEqual({ valid: [], dropped: bad.length })
  })

  test("duplicates dedupe and count as dropped (:145, :904); distinct rows past the cap stay distinct (:910, :926)", () => {
    const dup = normalizeNegativeKnowledge([VALID, { ...VALID }, { query: "q2", finding: "f2" }])
    expect([dup.valid.length, dup.dropped]).toEqual([2, 1])
    const prefix = "P".repeat(NK_MAX_FIELD)
    const distinct = normalizeNegativeKnowledge([
      { query: `${prefix}X`, finding: "F" },
      { query: `${prefix}Y`, finding: "F" },
    ])
    expect([distinct.valid.length, distinct.dropped]).toEqual([2, 0])
  })

  test("long fields truncate to the cap in code points (:152); the full-key nkKey keeps them distinct (R11)", () => {
    const big = "😀".repeat(NK_MAX_FIELD + 100)
    const { valid, dropped } = normalizeNegativeKnowledge([{ query: big, finding: big }])
    expect(dropped).toBe(0)
    expect([...valid[0]!.query!].length).toBe(NK_MAX_FIELD)
    expect([...valid[0]!.finding!].length).toBe(NK_MAX_FIELD)

    // R11: identity and scoring dedupe on the full cleaned pre-truncate pair,
    // so two rows that differ only past the cap stay distinct with distinct
    // ids, and the score path counts both.
    const prefix = "P".repeat(NK_MAX_FIELD)
    const rows = normalizeNegativeKnowledge([
      { query: `${prefix}X`, finding: "F" },
      { query: `${prefix}Y`, finding: "F" },
    ])
    expect([rows.valid.length, rows.dropped]).toEqual([2, 0])
    expect(rows.valid[0]!.id).not.toBe(rows.valid[1]!.id)
    expect(rows.valid[0]!.nkKey).toBeDefined()
    expect(computeEpistemicScoreFromClaims(rows.valid).breakdown.negativeKnowledgeCount).toBe(2)
    // Exact duplicates still dedupe (the key matches).
    expect(computeEpistemicScoreFromClaims([rows.valid[0]!, rows.valid[0]!]).breakdown.negativeKnowledgeCount).toBe(1)
  })

  test("a spoofed tag loses to the kind (:163, :318)", () => {
    const spoofed = normalizeClaim({ kind: "negative_knowledge", tag: "VERIFIED", ...VALID })
    expect(spoofed.tag).toBe("NEGATIVE_KNOWLEDGE")
  })
})

// ------------------------------------------------------------------ witness

describe("witnessClaim (d66328c:runner/tests/test_claim_witness.py)", () => {
  test("a VERIFIED claim without evidence is rejected (:127)", async () => {
    const witness = await witnessClaim(normalizeClaim({ tag: "VERIFIED", statement: "trust me" }), { cache, now })
    expect(witness).toEqual({
      ok: false,
      checkedAt: at.toISOString(),
      reason: expect.stringContaining("needs evidence"),
    })
  })

  test("INFERRED needs its reasoning and HYPOTHESIS its falsification (legacy structural rules)", async () => {
    const inferred = normalizeClaim({ tag: "INFERRED", statement: "therefore the sky is green" })
    expect((await witnessClaim(inferred, { cache, now })).reason).toMatch(/reasoning/)
    const hypothesis = normalizeClaim({ tag: "HYPOTHESIS", statement: "maybe the sky is green" })
    expect((await witnessClaim(hypothesis, { cache, now })).reason).toMatch(/falsification/)
    const reasoned = normalizeClaim({ tag: "INFERRED", statement: "derived", reasoning: "from the parent fact" })
    expect((await witnessClaim(reasoned, { cache, now })).ok).toBe(true)
    const tested = normalizeClaim({ tag: "HYPOTHESIS", statement: "guess", falsification: "run the experiment" })
    expect((await witnessClaim(tested, { cache, now })).ok).toBe(true)
  })

  test("a real cache round trip verifies (:163); a missing or tampered source does not", async () => {
    const source = await cache.put({
      url: "https://x.test/a",
      text: "The parser handles nested brackets in quotes.",
      provider: "fetch",
    })
    const claim = normalizeClaim({
      tag: "VERIFIED",
      statement: "Nested brackets are handled.",
      source: { sha256: source.meta.sha256, quote: "handles nested brackets" },
    })
    expect((await witnessClaim(claim, { cache })).ok).toBe(true)
    await writeFile(source.path, "The parser handles nested brackets in quotes. Edited.")
    expect((await witnessClaim(claim, { cache })).reason).toMatch(/not in the cache \(or was tampered with\)/)
  })

  test("a whitespace-only quote never matches (legacy B1: it exact-matched with confidence 1.0)", async () => {
    const source = await cache.put({
      url: "https://x.test/b",
      text: "Some real source text for the cache.",
      provider: "fetch",
    })
    const claim = normalizeClaim({
      tag: "VERIFIED",
      statement: "s",
      source: { sha256: source.meta.sha256, quote: "   " },
    })
    expect((await witnessClaim(claim, { cache })).ok).toBe(false)
  })

  test("INFERRED parents must be known claims when a known set is given", async () => {
    const claim = normalizeClaim({
      tag: "INFERRED",
      statement: "derived",
      reasoning: "from a parent",
      parents: "c".repeat(64),
    })
    expect((await witnessClaim(claim, { cache, known: new Set() })).reason).toMatch(/unknown parent/)
    expect((await witnessClaim(claim, { cache, known: new Set(["c".repeat(64)]) })).ok).toBe(true)
  })
})

describe("code locations (new in 1.1: legacy never checked line refs on disk)", () => {
  const code =
    'export function login(user: string) {\n  const sql = "SELECT * FROM users WHERE name = \'" + user + "\'"\n  return db.query(sql)\n}\n'
  beforeEach(async () => {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src/auth.ts"), code)
  })
  const at = (file: string, lines: [number, number], excerpt: string) => checkLocation(root, { file, lines, excerpt })

  test("the excerpt must be verbatim in the cited lines", async () => {
    expect(await at("src/auth.ts", [2, 3], `"SELECT * FROM users WHERE name = '" + user`)).toEqual({ ok: true })
    expect((await at("src/auth.ts", [3, 3], `"SELECT * FROM users WHERE name = '" + user`)).ok).toBe(false)
    expect((await at("src/auth.ts", [2, 2], "SELECT * FROM accounts WHERE id")).ok).toBe(false)
  })

  test("hallucinated files, lines past the end and paths outside the tree are refused", async () => {
    expect(await at("src/missing.ts", [1, 1], "export function login")).toMatchObject({
      reason: expect.stringMatching(/does not exist/),
    })
    expect(await at("src/auth.ts", [4, 9], "return db.query(sql)")).toMatchObject({
      reason: expect.stringMatching(/past the end/),
    })
    expect(await at("../etc/passwd", [1, 1], "root:x:0:0:root")).toMatchObject({
      reason: expect.stringMatching(/outside/),
    })
    const outside = await mkdtemp(path.join(tmpdir(), "es-outside-"))
    await writeFile(path.join(outside, "secret.ts"), "export const secret = 'shh-very-secret'\n")
    await symlink(path.join(outside, "secret.ts"), path.join(root, "src/link.ts"))
    expect(await at("src/link.ts", [1, 1], "export const secret")).toMatchObject({
      reason: expect.stringMatching(/outside/),
    })
    await rm(outside, { recursive: true, force: true })
  })

  test("a VERIFIED code finding is witnessed against the tree", async () => {
    const claim = normalizeClaim({
      tag: "VERIFIED",
      statement: "login() builds SQL by string concatenation (CWE-89).",
      severity: "high",
      location: { file: "src/auth.ts", lines: [2, 3], excerpt: '"SELECT * FROM users WHERE name = \'" + user' },
    })
    expect((await witnessClaim(claim, { cache, root })).ok).toBe(true)
    expect((await witnessClaim(claim, { cache })).reason).toMatch(/needs the audited tree's root/)
  })
})

// ------------------------------------------------------------------ dossiers + store

async function researchDossier(): Promise<{ dossier: Dossier; sources: string[] }> {
  const a = await cache.put({
    url: "https://x.test/a",
    text: "Alpha source: the cache is content addressed by sha256.",
    provider: "fetch",
  })
  const b = await cache.put({
    url: "https://x.test/b",
    text: "Beta source: quotes must appear verbatim in the cache.",
    provider: "fetch",
  })
  const claims = [
    normalizeClaim({
      tag: "VERIFIED",
      statement: "The cache is content addressed.",
      source: { sha256: a.meta.sha256, quote: "content addressed by sha256" },
    }),
    normalizeClaim({
      tag: "VERIFIED",
      statement: "Quotes are verbatim.",
      source: { sha256: b.meta.sha256, quote: "quotes must appear verbatim" },
    }),
    normalizeClaim({
      kind: "negative_knowledge",
      query: "fuzzy quote matching",
      finding: "No fuzzy matching is used.",
    }),
  ]
  const dossier = await writeDossier(
    factoryLayout(root).researchDossier,
    buildDossier({ mode: "research", subject: "cache design", claims, now: at }),
    { cache, now },
  )
  return { dossier, sources: [a.meta.sha256, b.meta.sha256] }
}

describe("dossiers", () => {
  test("writing witnesses every claim and records the result", async () => {
    const { dossier } = await researchDossier()
    expect(dossier.claims.every((claim) => claim.witness?.ok)).toBe(true)
    const saved = JSON.parse(await readFile(factoryLayout(root).researchDossier, "utf8"))
    expect(saved.evidenceHash).toBe(dossier.evidenceHash)
  })

  test("a dossier with a failing VERIFIED quote is refused whole (the quote-mismatch refusal)", async () => {
    const source = await cache.put({
      url: "https://x.test/c",
      text: "The real text says the limit is ten requests.",
      provider: "fetch",
    })
    const claims = [
      normalizeClaim({
        tag: "VERIFIED",
        statement: "Limit is ten.",
        source: { sha256: source.meta.sha256, quote: "the limit is ten requests" },
      }),
      normalizeClaim({
        tag: "VERIFIED",
        statement: "Limit is a hundred.",
        source: { sha256: source.meta.sha256, quote: "the limit is a hundred requests" },
      }),
    ]
    const file = factoryLayout(root).researchDossier
    const attempt = writeDossier(file, buildDossier({ mode: "research", subject: "limits", claims }), { cache })
    await expect(attempt).rejects.toBeInstanceOf(DossierRefusal)
    await expect(attempt).rejects.toThrow(/Limit is a hundred.*not found verbatim/s)
    expect(await Bun.file(file).exists()).toBe(false)
  })

  test("the evidence hash ignores claim order and duplicates", () => {
    const one = normalizeClaim({ tag: "HYPOTHESIS", statement: "first hypothesis" })
    const two = normalizeClaim({ tag: "HYPOTHESIS", statement: "second hypothesis" })
    const forward = buildDossier({ mode: "research", subject: "x", claims: [one, two] })
    const backward = buildDossier({ mode: "research", subject: "x", claims: [two, one, two] })
    expect(backward.claims).toHaveLength(2)
    expect(backward.evidenceHash).toBe(forward.evidenceHash)
  })

  test("research report lines become claims, tags stripped from the statement", async () => {
    const source = await cache.put({
      url: "https://x.test/r",
      text: "Greeting libraries usually expose a single greet function.",
      provider: "fetch",
    })
    const report = `# R\n\n- A greet function is conventional [VERIFIED: https://x.test/r "expose a single greet function"]\n- Nothing else was found [NEGATIVE_KNOWLEDGE: searched for greeting DSLs]\n`
    const claims = await claimsFromAudit(await auditMarkdown(report, cache), cache)
    expect(claims.map((claim) => [claim.tag, claim.statement])).toEqual([
      ["VERIFIED", "A greet function is conventional"],
      ["NEGATIVE_KNOWLEDGE", "Nothing else was found"],
    ])
    expect(claims[0]!.source?.sha256).toBe(source.meta.sha256)
    expect(stripTags("1. x [INFERRED: a [nested] body] y")).toBe("x y")
  })
})

describe("ClaimStore (d66328c:runner/tests/test_claim_store.py)", () => {
  test("loading twice gives the same fingerprint (:31); sources are indexed for citing (:65)", async () => {
    const { sources } = await researchDossier()
    const first = await ClaimStore.load(root)
    const second = await ClaimStore.load(root)
    expect(first.size).toBe(3)
    expect(second.fingerprint()).toBe(first.fingerprint())
    expect(first.citing(sources[0]!).map((claim) => claim.statement)).toEqual(["The cache is content addressed."])
  })

  test("one claim in two dossiers is one claim, found in both files (:83)", async () => {
    const claim = normalizeClaim({ tag: "HYPOTHESIS", statement: "shared hypothesis here" })
    const make = (subject: string) => buildDossier({ mode: "research", subject, claims: [claim] })
    const store = ClaimStore.from(
      [
        { file: "a.json", dossier: make("a") },
        { file: "b.json", dossier: make("b") },
      ],
      [],
    )
    expect(store.size).toBe(1)
    expect(store.files(claim.id)).toEqual(["a.json", "b.json"])
  })

  test("search is a case-insensitive substring match (:122)", async () => {
    await researchDossier()
    const store = await ClaimStore.load(root)
    expect(store.search("CONTENT addressed").map((claim) => claim.tag)).toEqual(["VERIFIED"])
    expect(store.search("")).toEqual([])
  })

  test("a corrupt dossier is an error, never silently skipped", async () => {
    await mkdir(factoryLayout(root).research, { recursive: true })
    await writeFile(factoryLayout(root).researchDossier, JSON.stringify({ version: "1.1", mode: "research" }))
    await expect(ClaimStore.load(root)).rejects.toThrow(/not a valid dossier/)
  })
})

// ------------------------------------------------------------------ degradation

describe("living dossiers (d66328c:runner/tests/test_living_dossiers.py)", () => {
  test("a retracted source makes its claims STALE without touching the dossier file (:103)", async () => {
    const { sources } = await researchDossier()
    const before = await readFile(factoryLayout(root).researchDossier, "utf8")
    await recordRetraction(root, { source: sources[0]!, event: "RETRACTED", note: "withdrawn", by: "human:test" })
    const store = await ClaimStore.load(root)
    expect(store.citing(sources[0]!).map((claim) => claim.status)).toEqual(["STALE"])
    expect(store.citing(sources[1]!).map((claim) => claim.status)).toEqual(["LIVE"])
    expect(store.events).toHaveLength(1)
    expect(await readFile(factoryLayout(root).researchDossier, "utf8")).toBe(before)
  })

  test("REVISED makes claims SUSPECT, not STALE (:149); the latest event per source wins", async () => {
    const { sources } = await researchDossier()
    await recordRetraction(root, { source: sources[1]!, event: "RETRACTED", by: "human:test" })
    await recordRetraction(root, { source: sources[1]!, event: "REVISED", note: "corrected", by: "human:test" })
    expect((await ClaimStore.load(root)).citing(sources[1]!)[0]?.status).toBe("SUSPECT")
  })

  test("no retractions, no degradation (:168); an invalid event is refused (:177)", async () => {
    const { dossier } = await researchDossier()
    expect(applyDegradation(dossier.claims, []).events).toEqual([])
    await expect(
      recordRetraction(root, { source: "d".repeat(64), event: "BOGUS" as "RETRACTED", by: "human:test" }),
    ).rejects.toThrow()
  })

  test("degradation is idempotent (:183)", async () => {
    const { dossier, sources } = await researchDossier()
    const retractions = [
      { source: sources[0]!, event: "RETRACTED" as const, at: at.toISOString(), note: "", by: "human:t" },
    ]
    const once = applyDegradation(dossier.claims, retractions)
    expect(once.events).toHaveLength(1)
    expect(applyDegradation(once.claims, retractions).events).toEqual([])
  })

  test("a corrupt ledger is an error and is never reset (legacy B4 wiped it to [])", async () => {
    await mkdir(factoryLayout(root).claims, { recursive: true })
    await writeFile(factoryLayout(root).retractions, '{"version":1,"retractions":"oops"}')
    await expect(readRetractions(root)).rejects.toThrow(/corrupt/)
    await expect(recordRetraction(root, { source: "e".repeat(64), event: "REVISED", by: "human:t" })).rejects.toThrow(
      /corrupt/,
    )
    expect(await readFile(factoryLayout(root).retractions, "utf8")).toBe('{"version":1,"retractions":"oops"}')
  })
})

// ------------------------------------------------------------------ ranking

interface RivalFixture {
  sources: Record<string, string>
  claims: Array<{ label: string; status: Claim["status"]; witness: "ok" | "failed" | null; input: Record<string, any> }>
  expectedClaims: string[]
  dossiers: Array<{ label: string; subject: string; claims: string[] }>
  expectedDossiers: string[]
}

async function rivals() {
  const fixture = (await Bun.file(path.join(import.meta.dir, "fixtures/claims/rivals.json")).json()) as RivalFixture
  const hashes = Object.fromEntries(Object.entries(fixture.sources).map(([ref, text]) => [ref, sha256(text)]))
  const byLabel = new Map<string, Claim>()
  for (const item of fixture.claims) {
    const { source, parents, ...rest } = item.input
    const input: ClaimInput = {
      ...rest,
      ...(source ? { source: { sha256: hashes[source.ref]!, quote: source.quote } } : {}),
      ...(parents ? { parents: (parents as string[]).map((label) => byLabel.get(label)!.id) } : {}),
    }
    const claim = normalizeClaim(input)
    byLabel.set(item.label, {
      ...claim,
      status: item.status,
      ...(item.witness
        ? {
            witness: {
              ok: item.witness === "ok",
              checkedAt: at.toISOString(),
              ...(item.witness === "failed" ? { reason: "quote not found" } : {}),
            },
          }
        : {}),
    })
  }
  const labelOf = new Map([...byLabel].map(([label, claim]) => [claim.id, label]))
  return { fixture, byLabel, labelOf }
}

/** Deterministic permutations (a seeded Fisher–Yates), so failures reproduce. */
function* permutations<T>(items: readonly T[], count: number): Generator<T[]> {
  let seed = 42
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed / 2 ** 31
  }
  for (let n = 0; n < count; n++) {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
    }
    yield copy
  }
}

describe("rival ranking (new in 1.1)", () => {
  test("claims rank by status, witness, strength, sources, then id — for every input order", async () => {
    const { fixture, byLabel, labelOf } = await rivals()
    const expected = fixture.expectedClaims.flatMap((group) =>
      group
        .split("|")
        .map((label) => byLabel.get(label)!)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((claim) => labelOf.get(claim.id)!),
    )
    for (const order of permutations([...byLabel.values()], 25)) {
      const ranked = rankClaims(order, { lookup: (id) => [...byLabel.values()].find((claim) => claim.id === id) })
      expect(ranked.map((item) => labelOf.get(item.claim.id))).toEqual(expected)
      expect(ranked.map((item) => item.rank)).toEqual(expected.map((_, index) => index + 1))
    }
  })

  test("the key explains the rank", async () => {
    const { byLabel } = await rivals()
    const ranked = rankClaims([byLabel.get("inferred-two-sources")!], {
      lookup: (id) => [...byLabel.values()].find((claim) => claim.id === id),
    })
    expect(ranked[0]!.key).toEqual({ status: "LIVE", witness: "ok", strength: 1, sources: 2 })
  })

  test("dossiers rank by failed, degraded, grounded, sources — for every input order", async () => {
    const { fixture, byLabel } = await rivals()
    const dossiers = fixture.dossiers.map((item) => ({
      label: item.label,
      dossier: buildDossier({
        mode: "research",
        subject: item.subject,
        claims: item.claims.map((label) => byLabel.get(label)!),
        now: at,
      }),
    }))
    const labelOf = new Map(dossiers.map((item) => [item.dossier.evidenceHash, item.label]))
    for (const order of permutations(dossiers, 25)) {
      const ranked = rankDossiers(order.map((item) => item.dossier))
      expect(ranked.map((item) => labelOf.get(item.dossier.evidenceHash))).toEqual(fixture.expectedDossiers)
    }
    const best = rankDossiers(dossiers.map((item) => item.dossier))[0]!
    expect(best.key).toEqual({ failed: 0, degraded: 0, grounded: 2, sources: 2 })
  })
})

// ------------------------------------------------------------------ PCRB brief

describe("proof-carrying research brief (d66328c:runner/tests/test_pcrb.py)", () => {
  const N_SOURCES = 5
  const N_CLAIMS = 50

  async function seedBrief() {
    const layout = factoryLayout(root)
    const sources: string[] = []
    for (let s = 0; s < N_SOURCES; s++) {
      const text = Array.from(
        { length: N_CLAIMS / N_SOURCES },
        (_, k) => `Finding ${s}.${k}: reproducibility of independent benchmark ${s * 100 + k} reached ${k + 1}.5 GB/s.`,
      ).join("\n")
      sources.push(
        (await cache.put({ url: `https://bench.test/${s}`, title: `Bench ${s}`, text, provider: "fetch" })).meta.sha256,
      )
    }
    const claims = Array.from({ length: N_CLAIMS }, (_, i) => {
      const s = i % N_SOURCES
      const k = Math.floor(i / N_SOURCES)
      return normalizeClaim({
        tag: "VERIFIED",
        statement: `Benchmark ${s * 100 + k} is reproducible.`,
        source: { sha256: sources[s]!, quote: `reproducibility of independent benchmark ${s * 100 + k} reached` },
      })
    })
    await writeFile(
      path.join(root, ".factory/research/REPORT.md"),
      "# Benchmarks\n\nEvery benchmark was reproduced independently.\n",
    )
    await writeDossier(
      layout.researchDossier,
      buildDossier({ mode: "research", subject: "benchmarks", claims, now: at }),
      { cache, now },
    )
    const { brief, file } = await exportBrief(root, { stateDir: state, now })
    return { brief, file, sources }
  }

  test("the bundle has the expected shape (:100) and a clean brief verifies fast with every quote (:107)", async () => {
    const { brief, file } = await seedBrief()
    expect(file).toBe(factoryLayout(root).researchBrief)
    expect(brief.claims).toHaveLength(N_CLAIMS)
    expect(Object.keys(brief.sources)).toHaveLength(N_SOURCES)
    expect(brief.manifest.members).toHaveLength(1 + N_CLAIMS + N_SOURCES)
    const started = performance.now()
    const result = await verifyBrief(brief, { stateDir: state })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(result).toMatchObject({
      ok: true,
      checks: { sourceIdentity: "pass", manifest: "pass", signature: "valid", quotes: "pass" },
      stats: { claims: N_CLAIMS, sources: N_SOURCES, quotesVerified: N_CLAIMS, quotesFailed: 0 },
    })
  })

  test("every one of 20 seeded tamper mutations is flagged (:120), including coordinated rewrites", async () => {
    const { brief, sources } = await seedBrief()
    const copy = () => structuredClone(brief)
    const mutations: Array<[string, unknown]> = []
    for (let i = 0; i < 5; i++) {
      const b = copy()
      b.claims[i]!.source!.quote = b.claims[i]!.source!.quote.replace("reproducibility", "reproducib1lity")
      mutations.push([`quote_flip_${i}`, b])
    }
    for (let i = 0; i < 5; i++) {
      const b = copy()
      const src = sources[i % N_SOURCES]!
      b.sources[src]!.content += "\nINJECTED FALSE PARAGRAPH."
      mutations.push([`source_body_edit_${i}`, b])
    }
    for (let i = 0; i < 5; i++) {
      const b = copy()
      const donor = structuredClone(b.claims[(i + 7) % N_CLAIMS]!)
      b.claims[i] = { ...donor, id: b.claims[i]!.id }
      mutations.push([`claim_swap_${i}`, b])
    }
    // Coordinated: the attacker re-derives the id and fixes every manifest
    // entry and the member list, so only the HMAC can catch it.
    for (let i = 0; i < 3; i++) {
      const b = copy()
      const old = b.claims[i + 10]!
      const { id: _id, status: _status, witness, ...content } = old
      const forged = normalizeClaim({ ...content, statement: `${old.statement} (fabricated conclusion)` })
      const claim = { ...forged, witness }
      b.claims[i + 10] = claim
      delete b.manifest.claims[old.id]
      b.manifest.claims[claim.id] = hashJson(claim)
      b.manifest.members = b.manifest.members
        .map((member) => (member === `claim:${old.id}` ? `claim:${claim.id}` : member))
        .sort()
      mutations.push([`coordinated_claim_rewrite_${i}`, b])
    }
    for (let i = 0; i < 2; i++) {
      const b = copy()
      const src = sources[i]!
      b.sources[src]!.content = b.sources[src]!.content.replace("GB/s", "TB/s")
      b.manifest.sources[src] = sha256(b.sources[src]!.content)
      mutations.push([`coordinated_source_rewrite_${i}`, b])
    }
    expect(mutations.length).toBeGreaterThanOrEqual(20)
    const missed: string[] = []
    for (const [name, tampered] of mutations)
      if ((await verifyBrief(tampered, { stateDir: state })).ok) missed.push(name)
    expect(missed).toEqual([])
    const coordinated = await verifyBrief(mutations.find(([name]) => name === "coordinated_claim_rewrite_0")![1], {
      stateDir: state,
    })
    expect(coordinated.checks).toMatchObject({ manifest: "pass", signature: "invalid" })
  })

  test("legacy B3: a member removed from the bundle is detected, and an unsigned bundle is refused", async () => {
    const { brief, sources } = await seedBrief()
    const dropped = structuredClone(brief)
    dropped.claims.pop()
    expect((await verifyBrief(dropped, { stateDir: state })).failures).toContainEqual(
      expect.objectContaining({ check: "manifest", message: "member was removed from the bundle" }),
    )
    const noSource = structuredClone(brief)
    delete noSource.sources[sources[0]!]
    expect((await verifyBrief(noSource, { stateDir: state })).ok).toBe(false)
    const unsigned = { ...structuredClone(brief), signature: { alg: "none" } }
    expect(await verifyBrief(unsigned, { stateDir: state })).toMatchObject({
      ok: false,
      checks: { signature: "invalid" },
    })
  })

  test("legacy B7: sources are keyed by the full hash; a prefix key is refused", async () => {
    const { brief, sources } = await seedBrief()
    const prefixed = structuredClone(brief) as any
    prefixed.sources[sources[0]!.slice(0, 16)] = prefixed.sources[sources[0]!]
    delete prefixed.sources[sources[0]!]
    expect((await verifyBrief(prefixed, { stateDir: state })).failures[0]?.check).toBe("schema")
  })

  test("no key here is 'unverifiable', never a minted key (:216); another machine's key is not 'valid' (:221)", async () => {
    const { brief } = await seedBrief()
    const elsewhere = await mkdtemp(path.join(tmpdir(), "es-claims-elsewhere-"))
    try {
      const strict = await verifyBrief(brief, { stateDir: elsewhere })
      expect(strict).toMatchObject({
        ok: false,
        checks: { signature: "unverifiable", manifest: "pass", quotes: "pass" },
      })
      expect(await Bun.file(path.join(elsewhere, "key")).exists()).toBe(false)
      expect((await verifyBrief(brief, { stateDir: elsewhere, allowUnverifiable: true })).ok).toBe(true)
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  test("export needs a report and a research dossier", async () => {
    await expect(exportBrief(root, { stateDir: state })).rejects.toThrow(/No research report/)
    await mkdir(factoryLayout(root).research, { recursive: true })
    await writeFile(factoryLayout(root).researchReport, "# R\n")
    await expect(exportBrief(root, { stateDir: state })).rejects.toThrow(/No research dossier/)
  })
})
