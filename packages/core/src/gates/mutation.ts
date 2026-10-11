// AST mutation gate (#169): tautological tests fail closed.
//
// An LLM-written test can expect the exact buggy behaviour of LLM-written
// code, so QA and the programmer both pass on broken code. The mutation gate
// injects subtle mutants into touched source (negated conditions, mutated
// arithmetic, stripped calls) and runs the touched suite against each one.
// A suite that lets mutants survive has a low kill rate, and the phase is
// rejected when the kill rate is below MUTATION_KILL_THRESHOLD (80%).
//
// The operators are text spans over the source, one occurrence per mutant,
// each carrying its file, line and a description. Results are cached by file
// content hash so unchanged files never rerun the suite.
import { timingSafeEqual } from "node:crypto"
import type { GateFinding } from "../schema/gates.ts"
import { sha256 } from "../util/hash.ts"

/** A phase is rejected when its mutation kill rate is below this. */
export const MUTATION_KILL_THRESHOLD = 0.8

/** Cap on mutants per file, so one giant file cannot stall the gate. */
export const MAX_MUTANTS_PER_FILE = 50

export type MutantKind = "condition" | "arithmetic" | "call" | "return"

export interface Mutant {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly kind: MutantKind
  readonly description: string
  /** The full file source with exactly this mutation applied. */
  readonly mutated: string
}

export interface MutationOutcome {
  readonly mutant: Mutant
  readonly killed: boolean
}

export interface MutationReport {
  readonly total: number
  readonly killed: number
  readonly survived: number
  readonly killRate: number
  readonly passed: boolean
  readonly threshold: number
  /** Files whose cached result was reused without rerunning the suite. */
  readonly cached: readonly string[]
  /** The cache to pass to the next run (unchanged files skip the suite). */
  readonly cache: MutationCacheState
}

/** Per-file cached outcome, keyed by file, valid only for its content hash. */
export interface MutationCacheEntry {
  readonly hash: string
  readonly killed: readonly string[]
  readonly total: number
}

export type MutationCacheState = Readonly<Record<string, MutationCacheEntry>>

interface Replacement {
  readonly kind: MutantKind
  readonly from: string
  readonly to: string
  readonly description: string
}

// One occurrence per mutant: the scanner walks the source and emits a mutant
// for every match. Guards keep compound operators intact (`===` before `==`,
// `++`/`--`/`+=` never split into arithmetic mutants).
const CONDITION_REPLACEMENTS: readonly Replacement[] = [
  { kind: "condition", from: "===", to: "!==", description: "strict equality negated (=== → !==)" },
  { kind: "condition", from: "!==", to: "===", description: "strict inequality negated (!== → ===)" },
  { kind: "condition", from: " && ", to: " || ", description: "conjunction loosened (&& → ||)" },
  { kind: "condition", from: " || ", to: " && ", description: "disjunction tightened (|| → &&)" },
]

const ARITHMETIC_REPLACEMENTS: readonly Replacement[] = [
  { kind: "arithmetic", from: " + ", to: " - ", description: "addition mutated (+ → -)" },
  { kind: "arithmetic", from: " - ", to: " + ", description: "subtraction mutated (- → +)" },
  { kind: "arithmetic", from: " * ", to: " / ", description: "multiplication mutated (* → /)" },
  { kind: "arithmetic", from: " / ", to: " * ", description: "division mutated (/ → *)" },
]

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length

const splice = (source: string, index: number, from: string, to: string): string =>
  source.slice(0, index) + to + source.slice(index + from.length)

/** A `name(args)` call statement on its own line, stripped to `undefined`. */
const CALL_STATEMENT = /^([ \t]*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\([^;]*\);?[ \t]*$/gm

/** `return <expr>` (non-void), mutated to `return undefined`. */
const RETURN_EXPR = /^([ \t]*return )(?!undefined\b)([^;]+);[ \t]*$/gm

/**
 * Every mutant for one source file: condition negations, arithmetic swaps,
 * stripped call statements and voided returns. Deterministic (source order),
 * capped at `maxPerFile`.
 */
export function generateMutants(file: string, source: string, maxPerFile = MAX_MUTANTS_PER_FILE): Mutant[] {
  const mutants: Mutant[] = []
  const push = (kind: MutantKind, index: number, from: string, to: string, description: string) => {
    if (mutants.length >= maxPerFile) return
    mutants.push({
      id: `${file}#${mutants.length + 1}`,
      file,
      line: lineOf(source, index),
      kind,
      description,
      mutated: splice(source, index, from, to),
    })
  }
  // Token replacements first (source order per operator class below is
  // stable): strict equality before any looser operator, and arithmetic only
  // with surrounding spaces so `++`, `--`, `+=` and friends never split.
  for (const replacement of [...CONDITION_REPLACEMENTS, ...ARITHMETIC_REPLACEMENTS]) {
    let index = source.indexOf(replacement.from)
    while (index !== -1 && mutants.length < maxPerFile) {
      push(replacement.kind, index, replacement.from, replacement.to, replacement.description)
      index = source.indexOf(replacement.from, index + replacement.from.length)
    }
    if (mutants.length >= maxPerFile) return mutants
  }
  CALL_STATEMENT.lastIndex = 0
  for (const match of source.matchAll(CALL_STATEMENT)) {
    if (mutants.length >= maxPerFile) break
    const index = match.index ?? 0
    push("call", index, match[0], `${match[1]}undefined;`, `call stripped (${match[2]}(...) → undefined)`)
  }
  RETURN_EXPR.lastIndex = 0
  for (const match of source.matchAll(RETURN_EXPR)) {
    if (mutants.length >= maxPerFile) break
    const index = match.index ?? 0
    push("return", index, match[0], `${match[1]}undefined;`, "return voided (return <expr> → return undefined)")
  }
  return mutants
}

/** Content hash scoping one file's cached mutation result. */
export function mutantCacheKey(file: string, content: string): string {
  return sha256(`${file}\n${content}`)
}

/**
 * Cache-hash equality: length-guarded constant-time compare (repo precedent:
 * trust/sidecar.ts, research/seal.ts). Cache fingerprints are content hashes,
 * not secrets, but the timing-safe compare keeps the security scanners quiet.
 */
export function cacheHashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Cache fingerprint for one source file: its own content plus the content of
 * the in-scope test files. Weakening (or strengthening) the tests changes
 * the fingerprint, so a stale verdict can never green-light edited tests —
 * the suite reruns.
 */
export async function mutationFingerprint(
  readFile: (file: string) => Promise<string | undefined>,
  file: string,
  source: string,
  testFiles: readonly string[],
): Promise<string> {
  const tests: string[] = []
  for (const candidate of testFiles) {
    if (candidate === file) continue
    const content = await readFile(candidate)
    if (content !== undefined) tests.push(`${candidate}\n${content}`)
  }
  return mutantCacheKey(file, `${source}\n${tests.join("\n")}`)
}

export function evaluateMutations(
  outcomes: readonly MutationOutcome[],
  threshold = MUTATION_KILL_THRESHOLD,
): { killRate: number; passed: boolean; killed: number; survived: number; total: number } {
  const total = outcomes.length
  const killed = outcomes.filter((outcome) => outcome.killed).length
  // No mutants means nothing checked the suite: fail closed, never vacuously green.
  const killRate = total === 0 ? 0 : killed / total
  return { killRate, passed: total > 0 && killRate >= threshold, killed, survived: total - killed, total }
}

/** The gate finding: an error below threshold, a warning-free pass at/above it. */
export function mutationFindings(
  report: Pick<MutationReport, "killRate" | "killed" | "total" | "passed" | "threshold">,
  files: readonly string[],
): GateFinding[] {
  if (report.passed) return []
  return [
    {
      file: files[0] ?? ".",
      rule: "mutation/kill-rate",
      severity: "error",
      message:
        report.total === 0
          ? "mutation gate found no mutants: the touched sources have no mutable operators, so the suite is unproven"
          : `mutation kill rate ${(report.killRate * 100).toFixed(1)}% (${report.killed}/${report.total} killed) is below ${(report.threshold * 100).toFixed(0)}%: the suite lets mutants survive, so it may assert buggy behaviour`,
      fixHint:
        "Strengthen the touched tests until they fail on negated conditions, swapped arithmetic and stripped calls.",
      check: "mutation",
    },
  ]
}

export interface MutationGateOptions {
  /** Source files (relative to the run dir) to mutate. */
  readonly files: readonly string[]
  readonly readFile: (file: string) => Promise<string | undefined>
  /**
   * Run the touched suite against one mutant: `killed: true` when the suite
   * failed (the mutant was caught), `false` when it still passed (survived).
   */
  readonly runTests: (mutant: Mutant) => Promise<{ killed: boolean }>
  /** Reused across runs: unchanged files skip the suite. */
  readonly cache?: MutationCacheState
  /** Test files whose content joins the cache fingerprint (edited tests rerun the suite). */
  readonly testFiles?: readonly string[]
  readonly threshold?: number
  readonly maxPerFile?: number
}

/**
 * Mutate each file and run the suite per mutant. Files whose content hash
 * matches the cache reuse their stored outcome without touching the suite.
 */
export async function runMutationGate(options: MutationGateOptions): Promise<MutationReport> {
  const threshold = options.threshold ?? MUTATION_KILL_THRESHOLD
  const maxPerFile = options.maxPerFile ?? MAX_MUTANTS_PER_FILE
  const cache: Record<string, MutationCacheEntry> = { ...options.cache }
  const cached: string[] = []
  const outcomes: MutationOutcome[] = []
  for (const file of options.files) {
    const source = await options.readFile(file)
    if (source === undefined) continue
    const hash = await mutationFingerprint(options.readFile, file, source, options.testFiles ?? [])
    const entry = cache[file]
    if (entry && cacheHashesEqual(entry.hash, hash)) {
      cached.push(file)
      const killed = new Set(entry.killed)
      for (let index = 0; index < entry.total; index++)
        outcomes.push({
          mutant: {
            id: `${file}#${index + 1}`,
            file,
            line: 1,
            kind: "condition",
            description: "cached",
            mutated: source,
          },
          killed: killed.has(`${file}#${index + 1}`),
        })
      continue
    }
    const mutants = generateMutants(file, source, maxPerFile)
    const killedIds: string[] = []
    for (const mutant of mutants) {
      const result = await options.runTests(mutant)
      outcomes.push({ mutant, killed: result.killed })
      if (result.killed) killedIds.push(mutant.id)
    }
    cache[file] = { hash, killed: killedIds, total: mutants.length }
  }
  const evaluated = evaluateMutations(outcomes, threshold)
  return {
    total: evaluated.total,
    killed: evaluated.killed,
    survived: evaluated.survived,
    killRate: evaluated.killRate,
    passed: evaluated.passed,
    threshold,
    cached,
    cache,
  }
}
