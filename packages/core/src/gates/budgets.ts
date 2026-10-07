// Budget checks over the change set: diff size, file length, complexity,
// dependency justification, and "behaviour change needs a test change".
// Complexity is a decision-point count per function for brace languages and
// Python (text heuristic; the tree-sitter index powers affected-test selection).
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { GateBudgets, GateFinding } from "../schema/gates.ts"
import { git } from "../worktree/git.ts"

const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/\n]+\.py$|_test\.(?:py|go)$|(?:^|\/)tests\/[^/\n]*\.rs$/
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|hpp|cpp|swift|java|php|cs|kt|rb|py|rs|go|h|cc|c)$/
const DOC_OR_CONFIG = /(?:(?:^|\/)(?:docs?|\.factory|\.github)\/)|(?:\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|lock)$)/

export const isTestFile = (file: string) => TEST_FILE.test(file)
export const isSourceFile = (file: string) =>
  SOURCE_FILE.test(file) && !TEST_FILE.test(file) && !DOC_OR_CONFIG.test(file)

export interface BudgetInput {
  readonly dir: string
  readonly files: readonly string[]
  readonly budgets: GateBudgets
  readonly base?: string
  readonly diff?: { added: number; removed: number }
  /** Text of DEPENDENCIES.md for the active phase, if any. */
  readonly dependencyJustification?: string
}

export async function checkBudgets(input: BudgetInput): Promise<GateFinding[]> {
  const { dir, files, budgets } = input
  const findings: GateFinding[] = []
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8").catch(() => undefined)
    if (text === undefined || text.includes("\u0000")) continue
    const lines = text.split("\n").length
    if (lines > budgets.maxFileLines && isSourceFile(file))
      findings.push({
        file,
        line: budgets.maxFileLines,
        rule: "budget/file-length",
        severity: "error",
        message: `${lines} lines exceeds the ${budgets.maxFileLines}-line budget`,
        fixHint: "Split the module along a seam.",
        check: "budgets",
      })
    if (isSourceFile(file))
      for (const fn of complexity(file, text))
        if (fn.score > budgets.maxComplexity)
          findings.push({
            file,
            line: fn.line,
            rule: "budget/complexity",
            severity: "error",
            message: `${fn.name} has ~${fn.score} decision points (budget ${budgets.maxComplexity})`,
            fixHint: "Extract helpers or table-drive the branches.",
            check: "budgets",
          })
  }
  if (input.diff) {
    const total = input.diff.added + input.diff.removed
    if (total > budgets.maxDiffLines)
      findings.push({
        file: ".",
        rule: "budget/diff-size",
        severity: "error",
        message: `${total} changed lines exceeds the ${budgets.maxDiffLines}-line phase budget`,
        fixHint: "Split the phase into smaller vertical slices.",
        check: "budgets",
      })
  }
  if (budgets.requireTestWithBehavior) {
    const source = files.filter(isSourceFile)
    if (source.length > 0 && !files.some(isTestFile))
      findings.push({
        file: source[0]!,
        rule: "budget/test-with-behavior",
        severity: "error",
        message: `${source.length} source file(s) changed without any test change`,
        fixHint: "Add or update a test that covers the behaviour change.",
        check: "budgets",
      })
  }
  if (budgets.requireDepJustification && input.base) findings.push(...(await dependencyFindings(input)))
  return findings
}

// ------------------------------------------------------------- dependencies

const MANIFESTS: Record<string, (text: string) => string[]> = {
  "package.json": (text) => {
    try {
      const pkg = JSON.parse(text)
      return Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      })
    } catch {
      return []
    }
  },
  "requirements.txt": (text) =>
    text
      .split("\n")
      .map((line) => /^\s*([A-Za-z0-9_.-]+)/.exec(line.replace(/#.*/, ""))?.[1])
      .filter((name): name is string => Boolean(name)),
  "pyproject.toml": (text) => {
    const block = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? ""
    return [...block.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((match) => match[1]!)
  },
  "Cargo.toml": (text) => {
    const names: string[] = []
    let inDeps = false
    for (const line of text.split("\n")) {
      if (/^\s*\[/.test(line)) inDeps = /^\s*\[(dev-|build-)?dependencies\]/.test(line)
      else if (inDeps) {
        const name = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]
        if (name) names.push(name)
      }
    }
    return names
  },
  "go.mod": (text) => {
    // `require host.tld/path vX` lines and the lines of a require ( … ) block.
    const names: string[] = []
    for (const raw of text.split("\n")) {
      let line = raw.trim()
      if (/^require\s/.test(line)) line = line.slice("require".length).trimStart()
      const [name = "", version = ""] = line.split(/\s+/)
      const slash = name.indexOf("/")
      const host = name.slice(0, Math.max(slash, 0))
      if (version.startsWith("v") && slash > 0 && slash < name.length - 1 && /^[\w-]+(\.[\w-]+)+$/.test(host))
        names.push(name)
    }
    return names
  },
}

async function dependencyFindings(input: BudgetInput): Promise<GateFinding[]> {
  const findings: GateFinding[] = []
  for (const file of input.files) {
    const parse = MANIFESTS[path.basename(file)]
    if (!parse) continue
    const after = await readFile(path.join(input.dir, file), "utf8").catch(() => "")
    const before = (await git(input.dir, ["show", `${input.base}:${file}`], { allowFail: true })).stdout
    const previous = new Set(parse(before))
    const added = parse(after).filter((name) => !previous.has(name))
    const justification = input.dependencyJustification ?? ""
    for (const name of added)
      if (
        !new RegExp(`(^|[\\s\`*'"(])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\`*'":),]|$)`, "m").test(
          justification,
        )
      )
        findings.push({
          file,
          rule: "budget/dependency-justification",
          severity: "error",
          message: `New dependency "${name}" has no justification`,
          fixHint: "Add it to the phase's DEPENDENCIES.md with the reason, license and maintenance check.",
          check: "budgets",
        })
  }
  return findings
}

// ------------------------------------------------------------- complexity

export interface FunctionComplexity {
  readonly name: string
  readonly line: number
  readonly score: number
}

const DECISION = /\b(if|for|while|case|catch|elif|except|match)\b|&&|\|\||\?\?|(?<![?.])\?(?![.?:])/g

export function complexity(file: string, text: string): FunctionComplexity[] {
  return file.endsWith(".py") ? pythonComplexity(text) : braceComplexity(text)
}

function stripLiterals(line: string) {
  let out = ""
  let i = 0
  while (i < line.length) {
    const char = line[i]!
    if (char === "/" && line[i + 1] === "/") break
    if (char === '"' || char === "'" || char === "`") {
      i += 1
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2
          continue
        }
        if (line[i] === char) {
          i += 1
          break
        }
        i += 1
      }
      out += '""'
      continue
    }
    out += char
    i += 1
  }
  return out
}

const HEADER_MODIFIERS = ["public", "private", "protected", "static", "async", "override", "readonly"]

const isIdentChar = (char: string | undefined): boolean =>
  char !== undefined &&
  ((char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_" ||
    char === "$")

function readIdent(text: string, from: number): string {
  let i = from
  while (i < text.length && isIdentChar(text[i])) i++
  return text.slice(from, i)
}

function skipSpaces(text: string, from: number): number {
  let i = from
  while (i < text.length && text[i] === " ") i++
  return i
}

/** Index of `word` in `text` at a word boundary, or -1. */
function wordAt(text: string, word: string, from = 0): number {
  for (let i = text.indexOf(word, from); i >= 0; i = text.indexOf(word, i + 1)) {
    if (!isIdentChar(i > 0 ? text[i - 1] : undefined) && !isIdentChar(text[i + word.length])) return i
  }
  return -1
}

/** Index of the `)` matching the `(` at `open` (literals are already blanked), or -1. */
function matchingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++
    else if (text[i] === ")" && --depth === 0) return i
  }
  return -1
}

/**
 * After a parameter list closing at `close`: skip an optional `: ReturnType`
 * and return where `terminator` ("{" or "=>") starts, or -1.
 */
function afterSignature(text: string, close: number, terminator: "{" | "=>"): number {
  if (close < 0) return -1
  const k = skipSpaces(text, close + 1)
  if (text.startsWith(terminator, k)) return k
  if (text[k] !== ":") return -1
  const at = text.indexOf(terminator, k + 1)
  return at < 0 || text.slice(k + 1, at).includes(";") ? -1 : at
}

/** The name a line declares a function/arrow/method under, without a regex. */
function detectHeader(flat: string): string | undefined {
  const candidates: Array<{ name: string; index: number }> = []
  const push = (name: string, index: number) => {
    if (name) candidates.push({ name, index })
  }
  const fn = wordAt(flat, "function")
  if (fn >= 0) {
    let i = fn + "function".length
    if (flat[i] === "*") i++
    i = skipSpaces(flat, i)
    const name = readIdent(flat, i)
    i = skipSpaces(flat, i + name.length)
    if (flat[i] === "(") push(name, fn)
  }
  const rust = wordAt(flat, "fn")
  if (rust >= 0) push(readIdent(flat, skipSpaces(flat, rust + 2)), rust)
  const go = wordAt(flat, "func")
  if (go >= 0) {
    let i = skipSpaces(flat, go + "func".length)
    if (flat[i] === "(") {
      const closing = matchingParen(flat, i)
      i = closing < 0 ? i : skipSpaces(flat, closing + 1)
    }
    push(readIdent(flat, i), go)
  }
  for (let i = 0; i < flat.length; i++) {
    if (!isIdentChar(flat[i]) || isIdentChar(i > 0 ? flat[i - 1] : undefined)) continue
    const name = readIdent(flat, i)
    let j = skipSpaces(flat, i + name.length)
    if (flat[j] !== "=" && flat[j] !== ":") continue
    j = skipSpaces(flat, j + 1)
    if (flat.startsWith("async ", j)) j = skipSpaces(flat, j + "async".length)
    if (flat.startsWith("function", j) && !isIdentChar(flat[j + "function".length])) {
      push(name, i)
      continue
    }
    if (flat[j] === "(") {
      if (afterSignature(flat, matchingParen(flat, j), "=>") >= 0) push(name, i)
      continue
    }
    const target = readIdent(flat, j)
    const k = skipSpaces(flat, j + target.length)
    if (target && flat.startsWith("=>", k)) push(name, i)
  }
  {
    let i = 0
    while (flat[i] === " ") i++
    for (;;) {
      const modifier = HEADER_MODIFIERS.find((word) => flat.startsWith(`${word} `, i))
      if (!modifier) break
      i += modifier.length + 1
    }
    const name = readIdent(flat, i)
    const j = skipSpaces(flat, i + name.length)
    if (name && flat[j] === "(" && afterSignature(flat, matchingParen(flat, j), "{") >= 0) push(name, i)
  }
  candidates.sort((a, b) => a.index - b.index)
  return candidates[0]?.name
}

function braceComplexity(text: string): FunctionComplexity[] {
  const results: FunctionComplexity[] = []
  const stack: Array<{ name: string; line: number; depth: number; score: number; opened: boolean }> = []
  let depth = 0
  const close = (done: { name: string; line: number; score: number }) =>
    results.push({ name: done.name, line: done.line, score: done.score })
  text.split("\n").forEach((raw, index) => {
    const line = stripLiterals(raw)
    const flat = line.replace(/[ \t]+/g, " ")
    const name = detectHeader(flat)
    if (name && !/^(if|for|while|switch|catch|return)$/.test(name))
      stack.push({ name, line: index + 1, depth, score: 1, opened: false })
    const decisions = line.match(DECISION)?.length ?? 0
    if (stack.length) stack.at(-1)!.score += decisions
    for (const char of line) {
      if (char === "{") {
        depth++
        const top = stack.at(-1)
        if (top && !top.opened && depth === top.depth + 1) top.opened = true
      } else if (char === "}") {
        depth--
        while (stack.length && stack.at(-1)!.opened && depth <= stack.at(-1)!.depth) close(stack.pop()!)
      }
    }
    // Expression-bodied functions (arrows without braces) end with their line.
    while (stack.length && !stack.at(-1)!.opened && stack.at(-1)!.line === index + 1) close(stack.pop()!)
  })
  for (const done of stack) close(done)
  return results
}

function pythonComplexity(text: string): FunctionComplexity[] {
  const results: FunctionComplexity[] = []
  let current: { name: string; line: number; indent: number; score: number } | undefined
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim() || raw.trim().startsWith("#")) return
    const indent = raw.length - raw.trimStart().length
    const def = /^\s*(?:async\s+)?def\s+(\w+)/.exec(raw)
    if (current && indent <= current.indent && !def) {
      results.push(current)
      current = undefined
    }
    if (def) {
      if (current) results.push(current)
      current = { name: def[1]!, line: index + 1, indent, score: 1 }
      return
    }
    if (current) current.score += (stripLiterals(raw).match(/\b(if|elif|for|while|except|and|or|case)\b/g) ?? []).length
  })
  if (current) results.push(current)
  return results.map(({ name, line, score }) => ({ name, line, score }))
}
