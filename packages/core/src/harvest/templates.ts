// Full-text licence matching against SPDX license-list templates (v3.29.0,
// bundled in assets/licenses and pinned by sha256). A permissive verdict needs
// the whole file to match a template: words are compared after the SPDX-style
// normalisation (case, punctuation between words, quotes/dashes, a few
// equivalent spellings); `<<var>>` spans are checked with their own regex over
// the original span, `<<beginOptional>>` blocks may be absent. Anything left
// over — an extra clause, a rider, a changed sentence — is not a match, so the
// caller fails closed. The leading copyright var only absorbs copyright,
// "all rights reserved" and short title lines, so a prepended rider (such as
// the Commons Clause) cannot hide in it. Matching is memoised over (item,
// position), with no backtracking regex over the whole text.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** SPDX ids with bundled templates, and the sha256 of each template file. */
export const LICENSE_TEMPLATES: Readonly<Record<string, string>> = {
  MIT: "9b91e12dfe57d42e91ea96d2acb7624040bffc54182bd164d39d0fae33e77794",
  "Apache-2.0": "5567209d3a634ebd6ed122a7302563b9668ab141941149a4e30d9c7b887f41b9",
  "BSD-2-Clause": "922ac644c79e7c2aa31bacac531a5d4d5b9d183853a3dc44a253fd9267c3c890",
  "BSD-3-Clause": "c42368b683ceef1ad41b6f17999adf3b7534e3c47fbdd51449ed6690edb1fc5f",
  ISC: "a382ee687364e5fa6361f299be089d79ded228a7ccbf1d4352a30fa22bfddb8f",
  "0BSD": "5b5b3cf0d303e1bed3144433e570f46f92810f6d9cb31073fb089786ff5472ff",
  Unlicense: "e6a01517253c197874d66ab30ca3f596cfce601aafcc310ec2944585a4a254bd",
  "CC0-1.0": "11b0f2c2841f449603f36bf727342f194ffdda8cc98cb9b3416d7a1e1b31628e",
}

const TEMPLATE_DIR = fileURLToPath(new URL("../../assets/licenses/", import.meta.url))

type Item =
  | { readonly kind: "word"; readonly word: string }
  | {
      readonly kind: "var"
      readonly pattern: RegExp | undefined
      readonly original: readonly string[]
      readonly copyrightBlock: boolean
    }
  | { readonly kind: "opt"; readonly id: number; readonly items: readonly Item[] }

interface Template {
  readonly id: number
  readonly items: readonly Item[]
}

/** Remove `<!-- … -->` comments (markdown LICENSE files often start with one), linearly. */
function stripHtmlComments(text: string): string {
  let out = ""
  let i = 0
  for (;;) {
    const open = text.indexOf("<!--", i)
    if (open < 0) return out + text.slice(i)
    const close = text.indexOf("-->", open + 4)
    out += `${text.slice(i, open)} `
    if (close < 0) return out
    i = close + 3
  }
}

/** Lowercase, straighten typography and fold the SPDX equivalent spellings we rely on. */
export function prepareLicenseText(text: string): string {
  return stripHtmlComments(text)
    .replace(/\r\n?/g, "\n")
    .toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -​  　\f\v]/g, " ")
    .replace(/©/g, "(c)")
    .replace(/\bnon[- \t\n]+infringement\b/g, "noninfringement")
    .replace(/\blicenc(e|es|ed|ing)\b/g, "licens$1")
    .replace(/\backnowledgement\b/g, "acknowledgment")
    .replace(/\bhttps:/g, "http:")
}

interface Token {
  readonly text: string
  readonly start: number
  readonly end: number
}

function tokenize(prepared: string): Token[] {
  const out: Token[] = []
  for (const match of prepared.matchAll(/[a-z0-9]+/g))
    out.push({ text: match[0], start: match.index, end: match.index + match[0].length })
  return out
}

const words = (text: string) => tokenize(prepareLicenseText(text)).map((token) => token.text)

let nextId = 0

/** Parse SPDX template markup into word, var and optional items. */
export function parseTemplate(source: string): Template {
  const stack: Item[][] = [[]]
  const push = (item: Item) => stack.at(-1)!.push(item)
  let i = 0
  while (i < source.length) {
    const open = source.indexOf("<<", i)
    const literal = source.slice(i, open < 0 ? source.length : open)
    for (const word of words(literal)) push({ kind: "word", word })
    if (open < 0) break
    if (source.startsWith("<<beginOptional>>", open)) {
      stack.push([])
      i = open + "<<beginOptional>>".length
    } else if (source.startsWith("<<endOptional>>", open)) {
      const items = stack.pop()!
      if (!stack.length) throw new Error("unbalanced <<endOptional>>")
      push({ kind: "opt", id: nextId++, items })
      i = open + "<<endOptional>>".length
    } else if (source.startsWith("<<var;", open)) {
      const end = source.indexOf('">>', open)
      if (end < 0) throw new Error("unterminated <<var>>")
      const inner = source.slice(open + "<<var;".length, end + 1)
      const name = /name="([^"]*)"/.exec(inner)?.[1] ?? ""
      const original = /original="(.*?)";match=/s.exec(inner)?.[1] ?? ""
      const match = /;match="(.*)"$/s.exec(inner)?.[1]
      let pattern: RegExp | undefined
      try {
        pattern = match === undefined ? undefined : new RegExp(`^(?:${match})$`, "is")
      } catch {
        pattern = undefined // fall back to the original text
      }
      push({
        kind: "var",
        pattern,
        original: words(original),
        copyrightBlock: name === "copyright" && /^\s*copyright/i.test(original),
      })
      i = end + '">>'.length
    } else {
      push({ kind: "word", word: "" })
      i = open + 2
    }
  }
  if (stack.length !== 1) throw new Error("unbalanced <<beginOptional>>")
  return { id: nextId++, items: stack[0]!.filter((item) => item.kind !== "word" || item.word) }
}

const loaded = new Map<string, Template>()

/** The parsed, hash-verified template for a bundled SPDX id. */
export function licenseTemplate(spdx: string): Template {
  const cached = loaded.get(spdx)
  if (cached) return cached
  const pin = LICENSE_TEMPLATES[spdx]
  if (!pin) throw new Error(`no bundled template for ${spdx}`)
  const bytes = readFileSync(`${TEMPLATE_DIR}${spdx}.template.txt`)
  if (createHash("sha256").update(bytes).digest("hex") !== pin)
    throw new Error(`bundled template for ${spdx} does not match its pinned sha256`)
  const template = parseTemplate(bytes.toString("utf8"))
  loaded.set(spdx, template)
  return template
}

/** A copyright span: only copyright / "all rights reserved" / short title lines (or blank). */
function isCopyrightBlock(span: string): boolean {
  return span.split("\n").every((raw) => {
    const line = raw.trim()
    if (!line) return true
    if (/^(copyright\b|\(c\)|all rights reserved)/.test(line)) return true
    // A short title line: "MIT License", "(MIT)", "The ISC License (ISC)", "BSD 3-Clause License".
    const count = (line.match(/[a-z0-9]+/g) ?? []).length
    return (
      count <= 10 &&
      /\b(license|mit|isc|bsd|apache|unlicense|cc0|0bsd)\b/.test(line) &&
      !/\b(shall|must|may not|provided that|permission)\b/.test(line)
    )
  })
}

const GENERIC_VAR_TOKENS = 40
const COPYRIGHT_VAR_TOKENS = 400

/** Does the whole of `text` match the template (full coverage, nothing left over)? */
export function matchesTemplate(template: Template, text: string): boolean {
  const prepared = prepareLicenseText(text)
  const tokens = tokenize(prepared)
  const memo = new Map<string, ReadonlySet<number>>()
  const spanText = (start: number, end: number) =>
    end > start ? prepared.slice(tokens[start]!.start, tokens[end - 1]!.end) : ""

  const accepts = (item: Extract<Item, { kind: "var" }>, start: number, end: number) => {
    const span = spanText(start, end)
    if (item.copyrightBlock) return isCopyrightBlock(span)
    if (item.pattern) return item.pattern.test(span.replace(/\s+/g, " "))
    return end - start === item.original.length && item.original.every((word, k) => tokens[start + k]?.text === word)
  }

  const run = (items: readonly Item[], key: number, index: number, pos: number): ReadonlySet<number> => {
    // Consecutive words advance without recursion.
    while (index < items.length && items[index]!.kind === "word") {
      if (tokens[pos]?.text !== (items[index] as { word: string }).word) return new Set()
      index++
      pos++
    }
    if (index === items.length) return new Set([pos])
    const memoKey = `${key}:${index}:${pos}`
    const hit = memo.get(memoKey)
    if (hit) return hit
    const out = new Set<number>()
    const item = items[index]!
    if (item.kind === "opt") {
      for (const end of run(items, key, index + 1, pos)) out.add(end)
      for (const mid of run(item.items, item.id, 0, pos))
        for (const end of run(items, key, index + 1, mid)) out.add(end)
    } else if (item.kind === "var") {
      const cap = item.copyrightBlock ? COPYRIGHT_VAR_TOKENS : GENERIC_VAR_TOKENS
      for (let length = 0; length <= cap && pos + length <= tokens.length; length++)
        if (accepts(item, pos, pos + length)) for (const end of run(items, key, index + 1, pos + length)) out.add(end)
    }
    memo.set(memoKey, out)
    return out
  }

  return run(template.items, template.id, 0, 0).has(tokens.length)
}

/** The bundled template the whole text matches, if any. */
export function matchLicenseTemplate(text: string): string | undefined {
  return Object.keys(LICENSE_TEMPLATES).find((spdx) => matchesTemplate(licenseTemplate(spdx), text))
}
