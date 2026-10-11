// Per-pack coverage closers for #256 (audit #190 follow-up): every shipped
// pack's banned domains and threshold/weight values pin current behavior, the
// below-threshold refusal path at machine.ts:545 is exercised, and the
// SECONDARY_MEDIA / tierDomains dead config is documented as observed.
// Scoring itself is NOT changed here (#252 owns the scoring defects: tierless
// weight, NK inflation, garbage tags); these tests pin the mechanism only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { type HumanSigner, sealHumanKey, unlockHumanKey } from "../src/approval/keystore.ts"
import {
  type Constitution,
  claimVerdict,
  constitutionFromPack,
  Factory,
  factoryLayout,
  gateRunner,
  LEGACY_CONSTITUTION,
  loadDomainPack,
  recordApproval,
  researchSourcesDir,
  SourceCache,
} from "../src/index.ts"
import { researchOptions } from "../src/research/ops.ts"
import { classifySourceTier } from "../src/research/tier.ts"
import { type Fixture, frontier, gitRepo } from "./helpers.ts"

const pack = async (id: string): Promise<Constitution> => constitutionFromPack(await loadDomainPack(id))

describe("each shipped pack bans its own domains (#256.1)", () => {
  const cases = [
    { packId: "quant", domain: "vendor-whitepaper-mirror.example" },
    { packId: "legal", domain: "undisclosed-sponsored-content.example" },
    { packId: "biopharma", domain: "predatory-journal.example" },
  ] as const
  for (const { packId, domain } of cases) {
    test(`${packId} rejects a source on ${domain} (BANNED_DOMAIN), other packs and legacy accept it`, async () => {
      const claim = {
        id: `${packId}-banned`,
        tag: "VERIFIED",
        source: {
          sha256: "b".repeat(64),
          quote: "the whitepaper claims linear scaling on every desk",
          url: `https://${domain}/research-note`,
        },
      }
      const own = claimVerdict(claim, { constitution: await pack(packId) })
      expect(own.verdict).toBe("REJECTED")
      expect(own.reasons.some((reason) => reason.startsWith("BANNED_DOMAIN"))).toBe(true)
      // Pack-agnostic baseline unchanged: legacy accepts the same claim.
      expect(claimVerdict(claim, { constitution: LEGACY_CONSTITUTION }).verdict).toBe("ACCEPTED")
      // Specificity: a sibling pack with a different ban list accepts it.
      const sibling = cases.find((entry) => entry.packId !== packId)!.packId
      expect(claimVerdict(claim, { constitution: await pack(sibling) }).verdict).toBe("ACCEPTED")
    })
  }
})

describe("pack threshold and weight values are pinned (#256.1)", () => {
  test("accept thresholds: biopharma 0.7, quant 0.7, legal 0.65", async () => {
    expect((await pack("biopharma")).acceptThreshold).toBe(0.7)
    expect((await pack("quant")).acceptThreshold).toBe(0.7)
    expect((await pack("legal")).acceptThreshold).toBe(0.65)
  })

  test("spot tier weights: biopharma downweights preprints, legal prefers primary press, quant values docs", async () => {
    expect((await pack("biopharma")).tierWeights.PREPRINT).toBe(0.3)
    expect((await pack("biopharma")).tierWeights.PEER_REVIEWED).toBe(1.0)
    expect((await pack("legal")).tierWeights.PRIMARY_PRESS).toBe(1.0)
    expect((await pack("legal")).tierWeights.PREPRINT).toBe(0.2)
    expect((await pack("quant")).tierWeights.TECHNICAL_DOCUMENTATION).toBe(1.0)
    expect((await pack("quant")).tierWeights.PREPRINT).toBe(0.5)
  })

  test("ban lists and retraction policies are pinned per pack", async () => {
    expect((await pack("biopharma")).bannedDomains).toEqual([
      "predatory-journal.example",
      "retracted-mirror.example",
      "banned-preprint-mirror.example",
    ])
    expect((await pack("quant")).bannedDomains).toEqual(["vendor-whitepaper-mirror.example"])
    expect((await pack("legal")).bannedDomains).toEqual(["undisclosed-sponsored-content.example"])
    expect((await pack("biopharma")).retractionPolicy).toBe("zero_tolerance")
    expect((await pack("quant")).retractionPolicy).toBe("standard")
    expect((await pack("legal")).retractionPolicy).toBe("standard")
    expect((await pack("quant")).negBonus).toBe(0.75)
    expect((await pack("quant")).rejectPenalty).toBe(3.0)
  })
})

describe("the below-threshold refusal path (#256.2)", () => {
  let fx: Fixture
  const PASSPHRASE = "test-passphrase-1234"
  let signer: HumanSigner
  beforeEach(async () => {
    fx = await gitRepo()
    await sealHumanKey(PASSPHRASE, fx.state)
    signer = await unlockHumanKey(PASSPHRASE, fx.state)
  })
  afterEach(() => fx.cleanup())

  test("a preprint-only report passes every per-claim rule yet is refused below the biopharma threshold", async () => {
    const factory = new Factory(fx.root, {
      gates: gateRunner({ stateDir: fx.state }),
      stateDir: fx.state,
      domainPack: "biopharma",
    })
    await factory.begin("human:tester")
    await factory.writeFrontier("grill", frontier())
    await recordApproval(fx.root, { stage: "frontier", channel: "cli", approvedBy: "tester", signer })
    await factory.beginResearch("human:tester")
    // arxiv.org classifies PREPRINT (weight 0.3 under biopharma), so one
    // verified claim scores 0.3 < 0.7 with no per-claim rule firing.
    const cache = new SourceCache(researchSourcesDir(fx.root), fx.state)
    const source = await cache.put({
      url: "https://arxiv.org/abs/2601.00001",
      text: "A preprint model predicts surrogate endpoints in early cohorts.",
      provider: "fetch",
    })
    expect(source.meta.tier).toBe("PREPRINT")
    await mkdir(path.dirname(factoryLayout(fx.root).researchReport), { recursive: true })
    await writeFile(
      factoryLayout(fx.root).researchReport,
      `- A preprint predicts surrogate endpoints [VERIFIED: sha256:${source.meta.sha256} "predicts surrogate endpoints"]\n`,
    )
    let message: string | undefined
    try {
      await factory.completeResearch("factory")
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught)
    }
    expect(message).toBeDefined()
    // The machine.ts:545 threshold refusal, not the per-claim rejection path.
    expect(message).toContain("below its threshold")
    expect(message).toContain("biopharma")
    expect(message).not.toContain("rejects")
  })
})

describe("removed dead tier config (#252, was #256.3)", () => {
  test("SECONDARY_MEDIA carries no weight in any pack and the classifier never emits it", async () => {
    // Fixed: the tierless SECONDARY_MEDIA weights are gone from every
    // shipped pack (they were dead config — tier.ts has no rule returning
    // it, not even for news-like hosts).
    expect((await loadDomainPack("biopharma")).tierWeights.SECONDARY_MEDIA).toBeUndefined()
    expect((await loadDomainPack("quant")).tierWeights.SECONDARY_MEDIA).toBeUndefined()
    expect((await loadDomainPack("legal")).tierWeights.SECONDARY_MEDIA).toBeUndefined()
    // ... yet tier.ts has no rule returning it, not even for news-like hosts.
    for (const url of [
      "https://arxiv.org/abs/1",
      "https://doi.org/10.1/x",
      "https://docs.python.org/3/",
      "https://www.fda.gov/news/x",
      "https://www.bbc.com/news/science-1",
      "https://www.nytimes.com/2026/01/01/health/x.html",
      "https://blog.example.com/opinion",
      "https://example.test/x",
    ])
      expect([url, classifySourceTier(url)]).toEqual([url, expect.not.stringMatching("SECONDARY_MEDIA")])
  })

  test("tierDomains overrides reach no caller: no shipped pack sets them and researchOptions drops them", async () => {
    // Observed: the schema, cache.put and ops plumbing accept tierDomains,
    // but no shipped pack file sets them ...
    for (const id of ["biopharma", "quant", "legal"])
      expect([(await loadDomainPack(id)).packId, (await loadDomainPack(id)).tierDomains]).toEqual([id, undefined])
    // ... and the config-to-tools mapping never forwards them (verified by
    // grep: zero assignments to ResearchOpsContext.tierDomains repo-wide), so
    // a pack can never re-tier a host at runtime today.
    expect("tierDomains" in researchOptions({ research: { depth: 2 } })).toBe(false)
  })
})
