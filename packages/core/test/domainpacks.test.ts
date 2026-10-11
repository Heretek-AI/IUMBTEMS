// Domain packs (full port of 0.7.25 runner/refinement.py + tests): the
// constitution's per-claim verdicts and tier-aware score, the three shipped
// packs, and the machine wiring that gates completeResearch. The fixture is
// the ported borderline_claims.json.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import {
  type Constitution,
  type ConstitutionClaim,
  claimVerdict,
  computeEpistemicScoreFromClaims,
  constitutionFromPack,
  Factory,
  factoryLayout,
  gateRunner,
  LEGACY_CONSTITUTION,
  loadDomainPack,
  recordApproval,
  researchSourcesDir,
  SourceCache,
  weightFor,
} from "../src/index.ts"
import { type Fixture, frontier, gitRepo } from "./helpers.ts"

interface FixtureClaim {
  readonly id: string
  readonly tag: string
  readonly statement: string
  readonly sourceHash: string
  readonly sourceUrl: string
  readonly verbatimQuote: string
  readonly tier: string
}

const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures/borderline-claims.json"), "utf8")) as {
  readonly retractedHashes: string[]
  readonly claims: FixtureClaim[]
}

const toClaim = (row: FixtureClaim): ConstitutionClaim => ({
  id: row.id,
  tag: row.tag,
  tier: row.tier,
  source: { sha256: row.sourceHash, quote: row.verbatimQuote, url: row.sourceUrl },
})
const claims = () => fixture.claims.map(toClaim)
const retracted = () => new Set(fixture.retractedHashes)

const biopharma = async (): Promise<Constitution> => constitutionFromPack(await loadDomainPack("biopharma"))

describe("the domain-pack constitution (d66328c:runner/refinement.py)", () => {
  test("the fixture has the legacy shape: 20 claims, 2 retracted sources", () => {
    expect(fixture.claims.length).toBe(20)
    expect(fixture.retractedHashes.length).toBe(2)
  })

  test("all three packs load; an unknown pack is refused (no silent fallback)", async () => {
    for (const id of ["biopharma", "quant", "legal"]) {
      const pack = await loadDomainPack(id)
      expect(Object.keys(pack.tierWeights)).toContain("PREPRINT")
    }
    // Whitespace is stripped first, as legacy did; blank or unknown ids raise.
    expect((await loadDomainPack(" biopharma ")).packId).toBe("biopharma")
    await expect(loadDomainPack("no-such-pack")).rejects.toThrow("domain pack not found")
    await expect(loadDomainPack("")).rejects.toThrow("domain pack not found")
  })

  test("the probe: default accepts all 20, biopharma flips at least a quarter (ACCEPTED -> REJECTED)", async () => {
    const pack = await biopharma()
    const before = claims().map((claim) => claimVerdict(claim, { retractedHashes: retracted() }))
    const after = claims().map((claim) => claimVerdict(claim, { constitution: pack, retractedHashes: retracted() }))
    expect(before.every((verdict) => verdict.verdict === "ACCEPTED")).toBe(true)
    const flips = fixture.claims
      .map((_, index) => [before[index]!.verdict, after[index]!.verdict] as const)
      .filter(([was, now]) => was !== now)
    expect(flips.length / fixture.claims.length).toBeGreaterThanOrEqual(0.25)
    expect(flips.every(([was, now]) => was === "ACCEPTED" && now === "REJECTED")).toBe(true)
  })

  test("banned-domain mechanism: the six planted domains are rejected", async () => {
    const pack = await biopharma()
    const banned = fixture.claims.filter(
      (row) => row.sourceUrl.includes("mirror.example") || row.sourceUrl.includes("predatory-journal"),
    )
    expect(banned.length).toBe(6)
    for (const row of banned) {
      const verdict = claimVerdict(toClaim(row), { constitution: pack })
      expect([row.id, verdict.verdict]).toEqual([row.id, "REJECTED"])
      expect(verdict.reasons.some((reason) => reason.startsWith("BANNED_DOMAIN"))).toBe(true)
    }
  })

  test("missing-tag mechanism: untagged claims are rejected", async () => {
    const pack = await biopharma()
    const untagged = fixture.claims.filter((row) => !row.tag)
    expect(untagged.length).toBe(2)
    for (const row of untagged) {
      const verdict = claimVerdict(toClaim(row), { constitution: pack })
      expect([row.id, verdict.verdict]).toEqual([row.id, "REJECTED"])
      expect(verdict.reasons.some((reason) => reason.startsWith("MISSING_TAG"))).toBe(true)
    }
  })

  test("zero-tolerance retraction: a retracted or STALE source is rejected regardless of score", async () => {
    const pack = await biopharma()
    const rows = fixture.claims.filter((row) => fixture.retractedHashes.includes(row.sourceHash))
    expect(rows.length).toBe(2)
    for (const row of rows) {
      // Without the ledger: the status-based downgrade still fires.
      const stale = { ...toClaim(row), status: "STALE" as const }
      const verdict = claimVerdict(stale, { constitution: pack })
      expect([row.id, verdict.verdict]).toEqual([row.id, "REJECTED"])
      expect(verdict.reasons.some((reason) => reason.startsWith("ZERO_TOLERANCE_RETRACTION"))).toBe(true)
      // Standard policy does not apply the rule.
      expect(claimVerdict(stale, { constitution: LEGACY_CONSTITUTION }).verdict).toBe("ACCEPTED")
      // With the ledger: the source-hash downgrade fires too.
      // (ConstitutionClaim has no status, so only the hash rule can fire.)
      const { status: _status, ...live } = stale
      expect(
        claimVerdict(live, { constitution: pack, retractedHashes: retracted() }).reasons.some((reason) =>
          reason.startsWith("ZERO_TOLERANCE_RETRACTION"),
        ),
      ).toBe(true)
    }
  })

  test("tier weights move the score: 18 verified preprints weigh 18 x 0.3 under biopharma", async () => {
    const pack = await biopharma()
    const flat = computeEpistemicScoreFromClaims(claims(), LEGACY_CONSTITUTION)
    const weighted = computeEpistemicScoreFromClaims(claims(), pack)
    expect(flat.breakdown.verifiedPassed).toBe(18)
    expect(weighted.score).toBeLessThan(flat.score)
    expect(weighted.breakdown.verifiedWeight).toBeCloseTo(18 * 0.3, 3)
  })

  test("the legacy structural rules fire (VERIFIED evidence, INFERRED logic, HYPOTHESIS falsification, NK fields)", () => {
    expect(claimVerdict({ id: "v", tag: "VERIFIED" }).reasons.join()).toContain("VERIFIED_REQUIRES_HASH")
    expect(claimVerdict({ id: "v2", tag: "VERIFIED", source: { sha256: "a".repeat(64) } }).reasons.join()).toContain(
      "VERIFIED_REQUIRES_QUOTE",
    )
    expect(claimVerdict({ id: "i", tag: "INFERRED" }).reasons.join()).toContain("INFERRED_REQUIRES_LOGIC")
    expect(claimVerdict({ id: "h", tag: "HYPOTHESIS" }).reasons.join()).toContain("HYPOTHESIS_REQUIRES_FALSIFICATION")
    const nk = claimVerdict({ id: "n", tag: "NEGATIVE_KNOWLEDGE" })
    expect(nk.reasons.join()).toContain("NEG_KNOWLEDGE_REQUIRES_QUERY")
    expect(nk.reasons.join()).toContain("NEG_KNOWLEDGE_REQUIRES_FINDING")
    // A complete claim of each kind is accepted; a code location counts as
    // VERIFIED evidence too (1.x addition).
    expect(claimVerdict({ id: "ok", tag: "VERIFIED", source: { sha256: "a".repeat(64), quote: "q" } }).verdict).toBe(
      "ACCEPTED",
    )
    expect(claimVerdict({ id: "loc", tag: "VERIFIED", location: { file: "src/a.ts" } }).verdict).toBe("ACCEPTED")
    expect(claimVerdict({ id: "ok2", tag: "INFERRED", reasoning: "from the parent fact" }).verdict).toBe("ACCEPTED")
  })

  test("the legacy defaults are preserved exactly", () => {
    expect(weightFor(LEGACY_CONSTITUTION, "PREPRINT")).toBe(1)
    expect(LEGACY_CONSTITUTION.bannedDomains).toEqual([])
    expect(LEGACY_CONSTITUTION.mandatoryTags).toEqual([])
    expect(LEGACY_CONSTITUTION.retractionPolicy).toBe("standard")
    expect(LEGACY_CONSTITUTION.acceptThreshold).toBe(0.65)
    expect(LEGACY_CONSTITUTION.negBonus).toBe(0.5)
    expect(LEGACY_CONSTITUTION.rejectPenalty).toBe(2.5)
  })
})

describe("the pack gates completeResearch", () => {
  let fx: Fixture
  const PASSPHRASE = "test-passphrase-1234"
  let signer: HumanSigner
  beforeEach(async () => {
    fx = await gitRepo()
    await sealHumanKey(PASSPHRASE, fx.state)
    signer = await unlockHumanKey(PASSPHRASE, fx.state)
  })
  afterEach(() => fx.cleanup())

  const factoryWith = (packId?: string) =>
    new Factory(fx.root, {
      gates: gateRunner({ stateDir: fx.state }),
      stateDir: fx.state,
      ...(packId ? { domainPack: packId } : {}),
    })

  const toResearch = async (packId?: string) => {
    const factory = factoryWith(packId)
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier())
    await recordApproval(fx.root, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
    await factory.beginResearch("human:tester")
    return factory
  }

  const report = async (url: string, text: string, quote: string) => {
    const cache = new SourceCache(researchSourcesDir(fx.root), fx.state)
    const source = await cache.put({ url, text, provider: "fetch" })
    await writeFile(
      factoryLayout(fx.root).researchReport,
      `- A researched claim [VERIFIED: sha256:${source.meta.sha256} "${quote}"]\n`,
    )
  }

  test("a clean report passes under biopharma and records the pack and score", async () => {
    const factory = await toResearch("biopharma")
    await report(
      "https://doi.org/10.1/clean",
      "The cohort met the primary efficacy bar in the per-protocol analysis.",
      "primary efficacy bar",
    )
    const state = await factory.completeResearch("factory")
    expect(state.stage).toBe("SPEC")
    const events = await readAuditEntries(fx.root, "stage.spec")
    const spec = events.at(-1)?.payload as { domainPack?: string; epistemicScore?: number }
    expect(spec.domainPack).toBe("biopharma")
    expect(spec.epistemicScore).toBe(1)
  })

  test("a banned-domain source is rejected under biopharma, and accepted without a pack", async () => {
    const packed = await toResearch("biopharma")
    await report(
      "https://predatory-journal.example/x",
      "Weak preprint finding about surrogate endpoints.",
      "surrogate endpoints",
    )
    await expect(packed.completeResearch("factory")).rejects.toThrow("BANNED_DOMAIN")

    // A fresh project without a pack: the same source passes (legacy unchanged).
    await fx.cleanup()
    fx = await gitRepo()
    await sealHumanKey(PASSPHRASE, fx.state)
    signer = await unlockHumanKey(PASSPHRASE, fx.state)
    const unpacked = await toResearch()
    await report(
      "https://predatory-journal.example/x",
      "Weak preprint finding about surrogate endpoints.",
      "surrogate endpoints",
    )
    await expect(unpacked.completeResearch("factory")).resolves.toBeDefined()
  })

  test("a below-threshold report is refused at completion, naming the score (#256.2)", async () => {
    // A preprint-only report passes every claim verdict under biopharma but
    // scores 0.3 against its 0.7 threshold: the machine.ts refusal path.
    const factory = await toResearch("biopharma")
    await report(
      "https://arxiv.org/abs/1234",
      "A model predicts surrogate endpoints in this preprint.",
      "predicts surrogate endpoints",
    )
    await expect(factory.completeResearch("factory")).rejects.toThrow("below its threshold")
  })

  test("an unknown configured pack fails closed at completion time", async () => {
    const factory = await toResearch("no-such-pack")
    await report("https://journal.example/clean", "A finding rests on a cached source.", "cached source")
    await expect(factory.completeResearch("factory")).rejects.toThrow("domain pack not found")
  })

  test("the summary shows the active pack during RESEARCH", async () => {
    const factory = await toResearch("biopharma")
    expect(await factory.summary()).toContain("domain pack: biopharma")
  })
})

// The stage.spec audit entries, read straight from the hash chain (no store helper needed).
async function readAuditEntries(root: string, action: string) {
  const text = await Bun.file(factoryLayout(root).audit).text()
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { action: string; payload: Record<string, unknown> })
    .filter((entry) => entry.action === action)
}

describe("source tiers reach claims and the score (#113)", () => {
  test("the built-in table classifies hosts; packs override it; unknowns stay undefined", async () => {
    const { classifySourceTier } = await import("../src/research/tier.ts")
    expect([
      classifySourceTier("https://arxiv.org/abs/1234"),
      classifySourceTier("https://export.arxiv.org/abs/1234"),
      classifySourceTier("https://www.biorxiv.org/content/1"),
      classifySourceTier("https://doi.org/10.1/abc"),
      classifySourceTier("https://pubmed.ncbi.nlm.nih.gov/1/"),
      classifySourceTier("https://www.nature.com/articles/x"),
      classifySourceTier("https://docs.python.org/3/"),
      classifySourceTier("https://developer.mozilla.org/en/"),
      // A docs./developer. prefix on an unlisted host earns no tier (#252):
      // the prefix rule would let docs.<attacker> claim curated weight.
      classifySourceTier("https://docs.example.com/x"),
      classifySourceTier("https://developer.example.com/y"),
      classifySourceTier("https://www.fda.gov/news/x"),
      classifySourceTier("https://journal.example/clean"),
      classifySourceTier("not a url"),
      classifySourceTier("https://ARXIV.ORG/ABS/1"),
    ]).toEqual([
      "PREPRINT",
      "PREPRINT",
      "PREPRINT",
      "PEER_REVIEWED",
      "PEER_REVIEWED",
      "PEER_REVIEWED",
      "TECHNICAL_DOCUMENTATION",
      "TECHNICAL_DOCUMENTATION",
      undefined,
      undefined,
      "PRIMARY_PRESS",
      undefined,
      undefined,
      "PREPRINT",
    ])
    // A pack override wins over the built-ins.
    expect(classifySourceTier("https://arxiv.org/abs/1", { PEER_REVIEWED: ["arxiv.org"] })).toBe("PEER_REVIEWED")
    expect(classifySourceTier("https://internal.example/trial", { PRIMARY_PRESS: ["internal.example"] })).toBe(
      "PRIMARY_PRESS",
    )
  })

  test("the tier is stored in sealed SourceMeta; tampering with it voids the seal", async () => {
    const fx = await gitRepo()
    try {
      const { SourceCache } = await import("../src/research/cache.ts")
      const cache = new SourceCache(path.join(fx.root, ".factory/research/sources"), fx.state)
      const entry = await cache.put({ url: "https://arxiv.org/abs/1", text: "A preprint finding.", provider: "fetch" })
      expect(entry.meta.tier).toBe("PREPRINT")
      expect((await cache.get(entry.meta.sha256))?.meta.tier).toBe("PREPRINT")
      // Unknown hosts stay tierless (the score falls back to __default__).
      const plain = await cache.put({ url: "https://example.test/x", text: "Just a page.", provider: "fetch" })
      expect(plain.meta.tier).toBeUndefined()
      // The seal covers the tier: rewriting it voids the entry.
      const { atomicWrite } = await import("../src/util/fs.ts")
      const metaFile = path.join(fx.root, ".factory/research/sources", `${entry.meta.sha256}.json`)
      const meta = JSON.parse(await Bun.file(metaFile).text())
      await atomicWrite(metaFile, `${JSON.stringify({ ...meta, tier: "PEER_REVIEWED" })}\n`)
      expect(await cache.get(entry.meta.sha256)).toBeUndefined()
    } finally {
      await fx.cleanup()
    }
  })

  test("claims inherit the cited source's tier; multi-source evidence takes the max weight", async () => {
    const fx = await gitRepo()
    try {
      const { SourceCache, researchSourcesDir } = await import("../src/research/cache.ts")
      const { auditMarkdown } = await import("../src/research/auditor.ts")
      const { claimsFromAudit } = await import("../src/claims/research.ts")
      const { highestTier } = await import("../src/claims/constitution.ts")
      const cache = new SourceCache(researchSourcesDir(fx.root), fx.state)
      const peer = await cache.put({
        url: "https://doi.org/10.1/x",
        text: "The trial met its endpoint.",
        provider: "fetch",
      })
      const pre = await cache.put({
        url: "https://arxiv.org/abs/2",
        text: "A model predicts the endpoint.",
        provider: "fetch",
      })
      await mkdir(path.join(fx.root, ".factory/research"), { recursive: true })
      const report = [
        `- The trial met its endpoint [VERIFIED: sha256:${peer.meta.sha256} "met its endpoint"]`,
        `- A model predicts the endpoint [VERIFIED: sha256:${pre.meta.sha256} "predicts the endpoint"]`,
      ].join("\n")
      const audit = await auditMarkdown(report, cache)
      expect(audit.passed).toBe(true)
      const found = await claimsFromAudit(audit, cache)
      expect(found.map((claim) => claim.tier).sort()).toEqual(["PEER_REVIEWED", "PREPRINT"])
      const pack = await loadDomainPack("biopharma")
      const constitution = constitutionFromPack(pack)
      expect(highestTier(["PREPRINT", "PEER_REVIEWED"], constitution)).toBe("PEER_REVIEWED")
      expect(highestTier([undefined, "PREPRINT"], constitution)).toBe("PREPRINT")
      expect(highestTier([undefined], constitution)).toBeUndefined()
    } finally {
      await fx.cleanup()
    }
  })

  test("a peer-reviewed dossier scores above a preprint-only one under biopharma", async () => {
    const pack = await loadDomainPack("biopharma")
    const constitution = constitutionFromPack(pack)
    const peer = computeEpistemicScoreFromClaims(
      [{ id: "a".repeat(64), tag: "VERIFIED", tier: "PEER_REVIEWED" }],
      constitution,
    )
    const pre = computeEpistemicScoreFromClaims(
      [{ id: "b".repeat(64), tag: "VERIFIED", tier: "PREPRINT" }],
      constitution,
    )
    expect(peer.score).toBe(1)
    expect(pre.score).toBe(0.3)
    // Unknown tiers fall back to __default__, which a pack clamps to its
    // lowest verified tier weight (#252): tierless must never outscore
    // verified evidence.
    expect(weightFor(constitution, undefined)).toBeLessThanOrEqual(0.3)
    expect(computeEpistemicScoreFromClaims([{ id: "c".repeat(64), tag: "VERIFIED" }], constitution).score).toBe(
      weightFor(constitution, undefined),
    )
  })

  test("tiers do not change claim identity: PCRB export and verify still pass", async () => {
    const { normalizeClaim, claimId } = await import("../src/claims/claim.ts")
    const without = normalizeClaim({
      tag: "VERIFIED",
      statement: "X holds.",
      source: { sha256: "a".repeat(64), quote: "x holds" },
    })
    const withTier = normalizeClaim({
      tag: "VERIFIED",
      statement: "X holds.",
      source: { sha256: "a".repeat(64), quote: "x holds" },
      tier: "PEER_REVIEWED",
    })
    expect(withTier.id).toBe(without.id)
    expect(withTier.tier).toBe("PEER_REVIEWED")
    expect(claimId({ ...without, tier: "PREPRINT" } as never)).toBe(without.id)
  })
})

describe("scoring integrity (#252)", () => {
  test("tierless claims weigh at the lowest verified tier, never full weight", async () => {
    // Unclassifiable hosts used to fall back to __default__ 1.0 and outscore
    // verified preprints (0.3) under biopharma: a perverse incentive to cite
    // worse sources. A pack now clamps __default__ to its lowest tier weight.
    const pack = await loadDomainPack("biopharma")
    const constitution = constitutionFromPack(pack)
    const floor = Math.min(
      ...Object.entries(pack.tierWeights)
        .filter(([tier]) => tier !== "__default__")
        .map(([, weight]) => weight),
    )
    expect(weightFor(constitution, undefined)).toBe(floor)
    const tierless = computeEpistemicScoreFromClaims([{ id: "c".repeat(64), tag: "VERIFIED" }], constitution)
    const preprint = computeEpistemicScoreFromClaims(
      [{ id: "d".repeat(64), tag: "VERIFIED", tier: "PREPRINT" }],
      constitution,
    )
    expect(tierless.score).toBe(floor)
    expect(tierless.score).toBeLessThanOrEqual(preprint.score)
    // The no-pack constitution is untouched (legacy numbers preserved).
    expect(weightFor(LEGACY_CONSTITUTION, undefined)).toBe(1)
  })

  test("negative knowledge cannot inflate the score past the threshold", async () => {
    // totalAssertions excluded negKnowledge while the numerator added
    // negBonus per row: 10xPREPRINT went 0.3 -> 1.0 with 14 NK lines. NK rows
    // now count as assertions too.
    const pack = await loadDomainPack("biopharma")
    const constitution = constitutionFromPack(pack)
    const verified = Array.from({ length: 10 }, (_, index) => ({
      id: `v${index}`.padEnd(64, "0"),
      tag: "VERIFIED" as const,
      tier: "PREPRINT" as const,
    }))
    const nk = Array.from({ length: 14 }, (_, index) => ({
      id: `n${index}`.padEnd(64, "0"),
      tag: "NEGATIVE_KNOWLEDGE" as const,
      query: `query ${index}`,
      finding: `finding ${index}`,
    }))
    const scored = computeEpistemicScoreFromClaims([...verified, ...nk], constitution)
    expect(scored.breakdown.negativeKnowledgeCount).toBe(14)
    expect(scored.score).toBeLessThan(constitution.acceptThreshold)
  })

  test("mandatory tags enforce membership, not just presence", async () => {
    const pack = await biopharma()
    const garbage = claimVerdict({ id: "g", tag: "GARBAGE" }, { constitution: pack })
    expect(garbage.verdict).toBe("REJECTED")
    expect(garbage.reasons.some((reason) => reason.startsWith("MISSING_TAG"))).toBe(true)
    expect(
      claimVerdict({ id: "v", tag: "VERIFIED", source: { sha256: "a".repeat(64), quote: "q" } }, { constitution: pack })
        .verdict,
    ).toBe("ACCEPTED")
  })
})

describe("pack coverage (#256)", () => {
  test("each pack pins its thresholds, weights and penalties", async () => {
    // A typo or deletion in a pack file stays green under mechanism-only
    // tests, so the values are pinned exactly (SECONDARY_MEDIA was removed:
    // the classifier never emits it, #256.3).
    const biopharma = await loadDomainPack("biopharma")
    expect(biopharma.tierWeights).toEqual({
      __default__: 1,
      PEER_REVIEWED: 1,
      TECHNICAL_DOCUMENTATION: 0.8,
      PRIMARY_PRESS: 0.7,
      PREPRINT: 0.3,
    })
    expect([biopharma.acceptThreshold, biopharma.negBonus, biopharma.rejectPenalty]).toEqual([0.7, 0.5, 2.5])
    expect(biopharma.retractionPolicy).toBe("zero_tolerance")
    const quant = await loadDomainPack("quant")
    expect(quant.tierWeights).toEqual({
      __default__: 1,
      PEER_REVIEWED: 0.9,
      TECHNICAL_DOCUMENTATION: 1,
      PRIMARY_PRESS: 0.6,
      PREPRINT: 0.5,
    })
    expect([quant.acceptThreshold, quant.negBonus, quant.rejectPenalty]).toEqual([0.7, 0.75, 3])
    const legal = await loadDomainPack("legal")
    expect(legal.tierWeights).toEqual({
      __default__: 1,
      PEER_REVIEWED: 0.8,
      TECHNICAL_DOCUMENTATION: 0.7,
      PRIMARY_PRESS: 1,
      PREPRINT: 0.2,
    })
    expect([legal.acceptThreshold, legal.negBonus, legal.rejectPenalty]).toEqual([0.65, 0.5, 2.5])
  })

  test("quant and legal ban their own mirrors, not just biopharma's", async () => {
    // Only biopharma's banned domains appeared in fixtures; per-pack
    // behavior is asserted directly here.
    const quant = constitutionFromPack(await loadDomainPack("quant"))
    const legal = constitutionFromPack(await loadDomainPack("legal"))
    const bio = await biopharma()
    const vendorMirror = {
      id: "q",
      tag: "VERIFIED",
      source: { sha256: "b".repeat(64), quote: "backtest", url: "https://vendor-whitepaper-mirror.example/p" },
    }
    expect(claimVerdict(vendorMirror, { constitution: quant }).verdict).toBe("REJECTED")
    expect(claimVerdict(vendorMirror, { constitution: bio }).verdict).toBe("ACCEPTED")
    const sponsored = {
      id: "l",
      tag: "VERIFIED",
      source: { sha256: "c".repeat(64), quote: "holding", url: "https://undisclosed-sponsored-content.example/x" },
    }
    expect(claimVerdict(sponsored, { constitution: legal }).verdict).toBe("REJECTED")
    expect(claimVerdict(sponsored, { constitution: bio }).verdict).toBe("ACCEPTED")
  })
})
