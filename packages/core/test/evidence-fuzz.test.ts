// #251.1: verifier fuzz corpus. Pins the quote verifier against the
// acceptance list in the issue: zero-width/bidi/compatibility characters,
// `..` vs `...` vs `....`, entities at the quote, and markdown-rendered
// quotes. Static review found no false accepts; these tests pin that.
import { describe, expect, test } from "bun:test"
import { normalizeForQuote, verifyQuote } from "../src/research/quote.ts"

const SRC = "The quick brown fox jumps over the lazy dog near the riverbank today."

describe("zero-width, bidi and compatibility characters (#251.1)", () => {
  test("U+200B folds to a word break (documented TYPOGRAPHY fold, pinned)", () => {
    // U+200B sits at the end of the folded whitespace range, so a quote
    // carrying it matches a source with a plain space, and vice versa.
    expect(verifyQuote(SRC, "quick brown fox\u200Bjumps over the").ok).toBe(true)
    expect(verifyQuote("quick brown fox\u200Bjumps over the lazy dog today", "quick brown fox jumps over").ok).toBe(
      true,
    )
    expect(normalizeForQuote("a\u200Bb")).toBe("a b")
  })

  test("joiners, soft hyphen, word joiner and bidi controls never fold: quotes carrying them refuse", () => {
    // None of U+200C U+200D U+00AD U+2060 U+200E U+200F U+202A U+202C U+2066
    // is in the fold table, so the normalised quote keeps the control and
    // misses the source.
    for (const ch of ["\u200C", "\u200D", "\u00AD", "\u2060", "\u200E", "\u200F", "\u202A", "\u202C", "\u2066"]) {
      const check = verifyQuote(SRC, `quick brown fox${ch} jumps over the`)
      expect([ch.codePointAt(0)!.toString(16), check.ok]).toEqual([ch.codePointAt(0)!.toString(16), false])
      expect(check.reason).toContain("not found verbatim")
    }
  })

  test("compatibility characters fold through NFKC (documented, pinned)", () => {
    expect(verifyQuote("The \uFB01ligree parses correctly here", "filigree parses correctly").ok).toBe(true)
    expect(verifyQuote("The ABC label is printed here", "\uFF21\uFF22\uFF23 label is printed").ok).toBe(true)
  })

  test("matching is case-sensitive: casing alone never folds", () => {
    expect(verifyQuote(SRC, "QUICK BROWN FOX JUMPS OVER").ok).toBe(false)
  })
})

describe("ellipsis edge cases: `..` vs `...` vs `....` (#251.1)", () => {
  test("two dots are literal: no fragment split", () => {
    expect(verifyQuote("Version 1..2 released yesterday morning", "Version 1..2 released").ok).toBe(true)
    expect(verifyQuote("Version 1..2 released yesterday morning", "Version 1..3 released").ok).toBe(false)
  })

  test("three dots (or …) split into ordered fragments, each 12+ characters", () => {
    expect(verifyQuote(SRC, "quick brown fox ... lazy dog near").ok).toBe(true)
    expect(verifyQuote(SRC, "quick brown fox \u2026 lazy dog near").ok).toBe(true)
    expect(verifyQuote(SRC, "lazy dog near ... quick brown fox").ok).toBe(false)
  })

  test("four dots are an ellipsis plus a literal dot that must match", () => {
    // "...." splits on the first "...", leaving ". lazy dog near" starting
    // with a dot the source does not have there.
    const check = verifyQuote(SRC, "quick brown fox .... lazy dog near")
    expect(check.ok).toBe(false)
    expect(check.reason).toContain("not found verbatim")
  })
})

describe("entities at the quote (#251.1)", () => {
  test("no entity decoding on either side: `&`, `&amp;` and `&#38;` are distinct literals", () => {
    const plain = "Fish & chips are tasty indeed"
    const encoded = "Fish &amp; chips are tasty indeed"
    const numeric = "Fish &#38; chips are tasty indeed"
    expect(verifyQuote(plain, "Fish & chips are tasty").ok).toBe(true)
    expect(verifyQuote(plain, "Fish &amp; chips are tasty").ok).toBe(false)
    expect(verifyQuote(plain, "Fish &#38; chips are tasty").ok).toBe(false)
    expect(verifyQuote(encoded, "Fish & chips are tasty").ok).toBe(false)
    expect(verifyQuote(numeric, "Fish & chips are tasty").ok).toBe(false)
    // Identical literals still match.
    expect(verifyQuote(encoded, "Fish &amp; chips are tasty").ok).toBe(true)
  })
})

describe("markdown-rendered quotes (#251.1)", () => {
  test("links, emphasis and code spans strip on both sides (documented, pinned)", () => {
    expect(verifyQuote("[Bun](https://bun.sh) is fast and furious today", "Bun is fast and furious").ok).toBe(true)
    expect(verifyQuote("This is **very important** news today ok", "This is very important news").ok).toBe(true)
    expect(verifyQuote("Run `bun add zod` to install it now", "Run bun add zod to install").ok).toBe(true)
    // Emphasis marks in the quote match a plain source (documented strip).
    expect(verifyQuote("Bun is fast and furious today", "**Bun** is fast and furious").ok).toBe(true)
  })

  test("a link target is not quotable text", () => {
    expect(verifyQuote("[Bun](https://bun.sh) is fast and furious today", "https://bun.sh is fast and").ok).toBe(false)
  })
})
