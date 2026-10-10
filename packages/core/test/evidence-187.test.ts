// Issue #187 §2 + bug #251 fuzz-adjacent edges (deterministic, no fuzz harness).
//
// Pins the CURRENT normalisation semantics of `verifyQuote` (NFKC,
// typography folds, markdown stripping, whitespace collapse; no entity
// decoding) and the CURRENT auditor downgrade rules (VERIFIED verbatim
// grounds, paraphrases and planted entries stay ungrounded). Bugs #251
// (fuzz corpus, legacy unsealed constructor) and #254 (wording) are for the
// parent: this suite tests behaviour as-is and reports defects as findings,
// never by changing product code.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { auditMarkdown, htmlToText, normalizeSourceText, SourceCache, sha256, verifyQuote } from "../src/index.ts"

let dir: string
let state: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "es-evidence-187-"))
  state = await mkdtemp(path.join(tmpdir(), "es-evidence-187-state-"))
})
afterEach(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]))

const sealed = () => new SourceCache(path.join(dir, "sources"), state)

const GATES = "Alpha gates keep agents honest under heavy load conditions today, witnesses agree."

describe("quote verifier fuzz-adjacent edges (#187 §2, gaps listed in #251)", () => {
  test("zero-width chars: ZWSP/FEFF fold to space and still match; ZWNJ/ZWJ/SHY/word-joiner refuse", () => {
    const plain = "hello world friends and more text here"
    // U+200B ZERO WIDTH SPACE and U+FEFF are in the typography fold to space.
    expect(verifyQuote(plain, "hello​ world friends and more").ok).toBe(true)
    expect(verifyQuote(plain, "hello﻿ world friends and more").ok).toBe(true)
    // An invisible join inside a word folds to a word break (current behaviour).
    expect(verifyQuote("hello​world friends and more text here", "hello world friends and more").ok).toBe(true)
    // U+200C/U+200D/U+00AD/U+2060 are NOT folded: the quote is refused.
    for (const invisible of ["‌", "‍", "­", "⁠"]) {
      const quote = `hello${invisible} world friends and more`
      expect([JSON.stringify(invisible), verifyQuote(plain, quote)]).toMatchObject([
        JSON.stringify(invisible),
        { ok: false },
      ])
      expect(verifyQuote(plain, quote).reason).toContain("not found verbatim")
      // And the reverse direction refuses too: the source keeps the char.
      expect(verifyQuote(`hello${invisible} world friends and more text here`, plain.slice(0, 30)).ok).toBe(false)
    }
  })

  test("`..` stays literal, `...`/`…` split into ordered fragments, `....` leaves a stray dot", () => {
    // Two dots are code/punctuation, never an ellipsis.
    expect(verifyQuote("version 1..2 released today for all users", "version 1..2 released today").ok).toBe(true)
    expect(verifyQuote("version 1..2 released today for all users", "version 1..2 ... released today for all").ok).toBe(
      true,
    )
    // Three dots and the single-char ellipsis both split; order matters.
    expect(verifyQuote(GATES, "Alpha gates keep ... honest under heavy load").ok).toBe(true)
    expect(verifyQuote(GATES, "Alpha gates keep … honest under heavy load").ok).toBe(true)
    expect(verifyQuote(GATES, "honest under heavy load ... Alpha gates keep").ok).toBe(false)
    // Four dots are an ellipsis plus a literal dot: the stray dot is refused.
    const four = verifyQuote(GATES, "Alpha gates keep .... honest under heavy load")
    expect(four.ok).toBe(false)
    expect(four.reason).toContain("not found verbatim")
  })

  test("entity-at-quote: the verifier does no entity decoding (the fetch layer decodes)", () => {
    const amp = htmlToText("<p>Fish &amp; chips are tasty indeed yum.</p>")
    const numeric = htmlToText("<p>Fish &#38; chips are tasty indeed yum.</p>")
    // Both spellings cache to the same decoded bytes.
    expect(amp.text).toBe("Fish & chips are tasty indeed yum.")
    expect(numeric.text).toBe(amp.text)
    // The decoded quote verifies; the still-encoded spellings are refused.
    expect(verifyQuote(amp.text, "Fish & chips are tasty").ok).toBe(true)
    for (const encoded of ["Fish &amp; chips are tasty", "Fish &#38; chips are tasty"]) {
      const check = verifyQuote(amp.text, encoded)
      expect([encoded, check.ok]).toEqual([encoded, false])
      expect(check.reason).toContain("not found verbatim")
    }
  })

  test("markdown-rendered quotes: emphasis and links strip on both sides", () => {
    expect(verifyQuote("the **quick brown fox jumps** over fences high", "quick brown fox jumps over").ok).toBe(true)
    expect(verifyQuote("the quick brown fox jumps over fences high", "the **quick brown fox jumps** over").ok).toBe(
      true,
    )
    expect(verifyQuote("run __every__ `single` test file now please", "run every single test file now").ok).toBe(true)
    expect(verifyQuote("[Bun](https://bun.sh) is fast and furious indeed", "Bun is fast and furious").ok).toBe(true)
    expect(verifyQuote("Bun is fast and furious indeed ok", "[Bun](https://bun.sh) is fast and furious").ok).toBe(true)
  })

  test("short-fragment refusal: every ellipsis fragment and every single quote needs 12+ characters", () => {
    expect(verifyQuote(GATES, "short").reason).toContain("too short")
    expect(verifyQuote(GATES, "abcdefghijk").ok).toBe(false)
    expect(verifyQuote("abcdefghijkl rest of the text here ok", "abcdefghijkl").ok).toBe(true)
    const short = verifyQuote(GATES, "Alpha gates keep ... hi ... honest under heavy load")
    expect(short.ok).toBe(false)
    expect(short.reason).toContain("fragment")
    expect(verifyQuote(GATES, "Alpha gates keep ... honest under heavy load").ok).toBe(true)
  })

  test("unicode normalisation: NFKC, curly quotes, dashes and NBSP fold before matching", () => {
    expect(verifyQuote("ﬁligree work is quite delicate indeed", "filigree work is quite").ok).toBe(true)
    expect(verifyQuote("café society is quite lively today", "café society is quite").ok).toBe(true)
    // Composed vs decomposed acute accents match after NFKC.
    expect(verifyQuote("café society is quite lively today", "café society is quite").ok).toBe(true)
    expect(verifyQuote("He said “hello world, friends” ok", 'said "hello world, friends"').ok).toBe(true)
    expect(verifyQuote("fast — reliable service for all users", "fast - reliable service").ok).toBe(true)
    expect(verifyQuote("hello world friends and more text", "hello world friends and more").ok).toBe(true)
    // Case still matters: normalisation is not case folding.
    expect(verifyQuote(GATES, "alpha gates keep agents honest").ok).toBe(false)
  })
})

describe("auditor downgrade rules (#187: verbatim grounds, paraphrase and plants do not)", () => {
  test("verbatim VERIFIED grounds; a paraphrase stays ungrounded (flagged, never re-tagged)", async () => {
    const cache = sealed()
    const source = await cache.put({
      url: "https://gates.test/run",
      text: "Mechanical gates catch regressions before review, which keeps autonomous agents honest under heavy load.",
      provider: "fetch",
    })
    const good = await auditMarkdown(
      `- Gates catch regressions early [VERIFIED: sha256:${source.meta.sha256} "catch regressions before review"]`,
      cache,
    )
    expect(good.coverage).toMatchObject({ claims: 1, grounded: 1, ungrounded: 0 })
    expect(good.passed).toBe(true)
    expect(good.cited).toEqual([source.meta.sha256])
    const paraphrased = await auditMarkdown(
      `- Gates catch failures ahead of inspection [VERIFIED: sha256:${source.meta.sha256} "catch failures ahead of inspection"]`,
      cache,
    )
    expect(paraphrased.coverage).toMatchObject({ claims: 1, grounded: 0, ungrounded: 1 })
    expect(paraphrased.passed).toBe(false)
    expect(paraphrased.claims[0]?.reason).toContain("not found verbatim")
  })

  test("a planted unsealed entry is refused by the sealed cache; the legacy constructor still reads it (#251)", async () => {
    const text = "Planted findings about gate latency on reference hardware."
    const hash = sha256(normalizeSourceText(text))
    await mkdir(path.join(dir, "sources"), { recursive: true })
    await writeFile(path.join(dir, "sources", `${hash}.md`), normalizeSourceText(text))
    await writeFile(
      path.join(dir, "sources", `${hash}.json`),
      `${JSON.stringify({ sha256: hash, url: "https://evil.test/planted", retrieved: new Date().toISOString(), provider: "fetch", bytes: Buffer.byteLength(normalizeSourceText(text)) })}\n`,
    )
    expect(await sealed().get(hash)).toBeUndefined()
    const audit = await auditMarkdown(
      `- Planted latency wins [VERIFIED: sha256:${hash} "gate latency on reference"]`,
      sealed(),
    )
    expect(audit.coverage).toMatchObject({ claims: 1, grounded: 0, ungrounded: 1 })
    expect(audit.claims[0]?.reason).toContain("not in the cache")
    expect(audit.passed).toBe(false)
    // Current legacy behaviour (bug #251): without a state dir nothing is verified.
    expect((await new SourceCache(path.join(dir, "sources")).get(hash))?.text).toContain("gate latency")
  })

  test("short and missing quotes stay ungrounded; substantive other tags ground, stubs are malformed", async () => {
    const cache = sealed()
    const source = await cache.put({
      url: "https://gates.test/short",
      text: "Mechanical gates catch regressions before review, which keeps autonomous agents honest under heavy load.",
      provider: "fetch",
    })
    const audit = await auditMarkdown(
      [
        `- Too short [VERIFIED: sha256:${source.meta.sha256} "tiny"]`,
        `- Missing quote [VERIFIED: no quote here]`,
        `- Fewer tools to install [INFERRED: one binary covers the runner and the bundler]`,
        `- Maybe faster [HYPOTHESIS: rerun the benchmark with n=30]`,
        `- Nothing else found [NEGATIVE_KNOWLEDGE: searched for gate failures on ARM]`,
        `- Stub [INFERRED: ok]`,
        "- No tag at all",
      ].join("\n"),
      cache,
    )
    // "tiny" fails verification (ungrounded); "no quote here" has no
    // source/quote shape and the stub INFERRED body is malformed.
    expect(audit.coverage).toMatchObject({
      claims: 7,
      grounded: 3,
      ungrounded: 1,
      untagged: 1,
      malformed: 2,
    })
    expect(audit.passed).toBe(false)
  })
})
