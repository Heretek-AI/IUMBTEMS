// Automated semantic rebase across stack branches (#165, Phase 7).
//
// Upstream fixes cascade downstream without a human replaying commits:
// unique commits on `to` are rebased onto `from`'s tip in a scratch
// worktree, TypeScript-import and JSON conflicts resolve AST-aware, and the
// target branch moves ONLY when the post-rebase tests pass — otherwise the
// previous SHA is restored (the monotonic test guarantee). `to` is never
// touched before the green verdict, so a failure always leaves it intact.

import { randomInt } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as Git from "./git.ts"

export class RebaseError extends Error {}

interface ParsedImport {
  readonly module: string
  readonly def?: string
  readonly named: string[]
  readonly typeOnly: boolean
  readonly raw: string
}

/** An import-opening line (leading whitespace tolerated; side-effect imports count). */
const isImportLine = (line: string): boolean => {
  const text = line.trimStart()
  return (
    text.startsWith("import ") ||
    text.startsWith("import\t") ||
    text.startsWith('import"') ||
    text.startsWith("import'") ||
    text === "import"
  )
}

/**
 * Single-line import parser with no backtracking (linear scan): split the
 * trailing quoted module first, then require a standalone `from` keyword.
 * The naive `import\s+(.+?)\s+from…` regex is polynomial-ReDoS on hostile input.
 */
function parseImportLine(line: string): ParsedImport | undefined {
  let rest = line.trim()
  if (!rest.startsWith("import")) return undefined
  rest = rest.slice("import".length)
  if (!rest.startsWith(" ") && !rest.startsWith("\t")) return undefined
  rest = rest.trimStart()
  const tail = /(["'])([^"']+)\1\s*;?$/.exec(rest)
  if (tail?.[2] === undefined) return undefined
  let clause = rest.slice(0, rest.length - tail[0].length).trimEnd()
  if (clause !== "from" && !clause.endsWith(" from") && !clause.endsWith("\tfrom")) return undefined
  clause = clause.slice(0, clause.length - "from".length).trim()
  // A surviving inner `from` means the line is not the simple shape we merge.
  if (!clause || /\bfrom\b/.test(clause)) return undefined
  const trimmed = clause.trim()
  const typeOnly = trimmed === "type" || trimmed.startsWith("type ") || trimmed.startsWith("type\t")
  const bare = (typeOnly ? trimmed.slice("type".length) : trimmed).trim()
  const braced = bare.startsWith("{") && bare.endsWith("}")
  const named = braced
    ? bare
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : []
  if (bare.startsWith("{") && !named.length) return undefined
  const def = bare.startsWith("{") ? undefined : bare || undefined
  if (def === undefined && !named.length) return undefined
  return { module: tail[2]!, def, named, typeOnly, raw: line }
}

/** Combine two parsed imports for the same module, or undefined on structural clash. */
function combineImports(existing: ParsedImport, incoming: ParsedImport): ParsedImport | undefined {
  if (existing.typeOnly !== incoming.typeOnly) return undefined
  if (existing.def !== undefined && incoming.def !== undefined && existing.def !== incoming.def) return undefined
  return {
    module: existing.module,
    def: existing.def ?? incoming.def,
    named: [...new Set([...existing.named, ...incoming.named])].sort((a, b) => a.localeCompare(b)),
    typeOnly: existing.typeOnly,
    raw: existing.raw,
  }
}

/** Merge two single-line-import TypeScript sources; undefined when unsafe. */
export function mergeTypeScriptImports(ours: string, theirs: string): string | undefined {
  // Multi-line imports need a real parser: refuse rather than guess. A line
  // that opens an import without a `from "module"` (and is not a bare
  // side-effect import) continues on the next line.
  const multiline = (text: string) =>
    text
      .split("\n")
      .some((line) => isImportLine(line) && !line.includes("from") && !line.includes('"') && !line.includes("'"))
  if (multiline(ours) || multiline(theirs)) return undefined
  const oursLines = ours.split("\n")
  const theirsLines = theirs.split("\n")
  // Only import lines may differ; anything else means a real code conflict.
  const strip = (lines: string[]) => lines.filter((line) => line.trim() && !isImportLine(line)).join("\n")
  if (strip(oursLines) !== strip(theirsLines)) return undefined
  const merged = new Map<string, ParsedImport>()
  for (const line of [...oursLines, ...theirsLines]) {
    if (!line.trim() || !isImportLine(line)) continue
    const parsed = parseImportLine(line)
    if (!parsed) return undefined
    const existing = merged.get(parsed.module)
    if (!existing) merged.set(parsed.module, parsed)
    else {
      const combined = combineImports(existing, parsed)
      if (!combined) return undefined
      merged.set(parsed.module, combined)
    }
  }
  const rendered = [...merged.values()].map((entry) => {
    const parts: string[] = []
    if (entry.def) parts.push(entry.def)
    if (entry.named.length) parts.push(`{ ${entry.named.join(", ")} }`)
    const quote = entry.raw.includes('"') ? '"' : "'"
    return `import${entry.typeOnly ? " type" : ""} ${parts.join(", ")} from ${quote}${entry.module}${quote}`
  })
  const body = strip(oursLines)
  return [...rendered, ...(body ? [body] : []), ""].join("\n")
}

const semverParts = (version: string): number[] =>
  version
    .replace(/^[\^~>=<\s]+/, "")
    .split(/[.+_-]/)
    .map(Number)
    .filter((n) => Number.isFinite(n))

const newer = (a: string, b: string): string => {
  const pa = semverParts(a)
  const pb = semverParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? a : b
  }
  return b
}

/** Deep-merge two JSON documents (theirs wins scalars, objects merge, arrays union). */
export function mergeJson(oursText: string, theirsText: string): string | undefined {
  let ours: unknown
  let theirs: unknown
  try {
    ours = JSON.parse(oursText)
    theirs = JSON.parse(theirsText)
  } catch {
    return undefined
  }
  const merge = (a: unknown, b: unknown): unknown => {
    if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b])]
    if (a && b && typeof a === "object" && typeof b === "object") {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
      for (const [key, value] of Object.entries(b as Record<string, unknown>))
        out[key] = key in out ? merge(out[key], value) : value
      return out
    }
    return b
  }
  return `${JSON.stringify(merge(ours, theirs), null, 2)}\n`
}

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

/**
 * Merge two package.json texts: dependency ranges union, with the higher
 * semver winning a conflict on the same key. Undefined when either side is
 * not valid JSON with object dependencies.
 */
export function mergePackageJson(oursText: string, theirsText: string): string | undefined {
  let ours: Record<string, unknown>
  let theirs: Record<string, unknown>
  try {
    ours = JSON.parse(oursText)
    theirs = JSON.parse(theirsText)
  } catch {
    return undefined
  }
  if (!ours || typeof ours !== "object" || !theirs || typeof theirs !== "object") return undefined
  const out: Record<string, unknown> = { ...ours }
  for (const section of DEPENDENCY_SECTIONS) {
    const merged = mergeDependencySection(ours, theirs, section)
    if (merged && Object.keys(merged).length) out[section] = merged
  }
  for (const [key, value] of Object.entries(theirs))
    if (!DEPENDENCY_SECTIONS.includes(key) && !(key in out)) out[key] = value
  return `${JSON.stringify(out, null, 2)}\n`
}

/** Union one dependency section, with the higher semver winning a conflict on the same key. */
function mergeDependencySection(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  section: string,
): Record<string, string> | undefined {
  const a = (ours[section] ?? {}) as Record<string, string>
  const b = (theirs[section] ?? {}) as Record<string, string>
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return undefined
  const merged: Record<string, string> = { ...a }
  for (const [key, value] of Object.entries(b)) merged[key] = key in merged ? newer(merged[key]!, value) : value
  return merged
}

/** AST-aware conflict resolution by path. Returns merged text, or undefined when a human must decide. */
export function resolveConflict(file: string, oursText: string, theirsText: string): string | undefined {
  if (oursText === theirsText) return oursText
  if (/\.m?[tj]sx?$/.test(file)) return mergeTypeScriptImports(oursText, theirsText)
  if (file.endsWith(".json"))
    return path.basename(file) === "package.json"
      ? (mergePackageJson(oursText, theirsText) ?? mergeJson(oursText, theirsText))
      : mergeJson(oursText, theirsText)
  return undefined
}

export interface CascadeOptions {
  /** Upstream branch carrying the fix (rebase destination). */
  readonly from: string
  /** Downstream branch to replay onto `from` (moves only on green tests). */
  readonly to: string
  /** Post-rebase verification in the rebased tree. Defaults to marker/JSON sanity. */
  readonly runTests?: (dir: string) => Promise<boolean>
  /** Scratch parent for the rebase worktree (defaults to the OS tmp dir). */
  readonly scratchDir?: string
}

export interface CascadeResult {
  readonly ok: boolean
  readonly previousSha: string
  readonly newSha?: string
  readonly rolledBack: boolean
  /** Files auto-resolved during the cascade. */
  readonly resolutions: readonly string[]
  readonly reason?: string
}

const IDENTITY = ["-c", "user.name=Epistemic Swarm", "-c", "user.email=factory@epistemic-swarm.local"] as const

const unmerged = async (dir: string): Promise<string[]> => {
  const status = (await Git.git(dir, ["status", "--porcelain=v1", "-uall"])).stdout
  return status
    .split("\n")
    .filter((line) => line.startsWith("UU "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
}

const rebaseActive = async (dir: string): Promise<boolean> => {
  const { exists } = await import("../util/fs.ts")
  for (const seq of ["rebase-merge", "rebase-apply"]) {
    const gitPath = (await Git.git(dir, ["rev-parse", "--git-path", seq])).stdout.trim()
    if (await exists(path.isAbsolute(gitPath) ? gitPath : path.join(dir, gitPath))) return true
  }
  return false
}

/** Marker/JSON sanity of a rebased tree: no conflict markers, every JSON file parses. */
export async function sanityTests(dir: string, files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8").catch(() => undefined)
    if (text === undefined) continue
    if (/^<<<<<<<|^=======$|^>>>>>>>/m.test(text)) return false
    if (file.endsWith(".json"))
      try {
        JSON.parse(text)
      } catch {
        return false
      }
  }
  return true
}

/**
 * Cascade `to` onto `from`: replay `to`'s unique commits onto `from`'s tip,
 * auto-resolving TS/JSON conflicts, then move `to` only when `runTests`
 * passes in the rebased tree. Any failure (conflict, tests) leaves `to` at
 * its previous SHA and reports `rolledBack: true`.
 */
export async function cascadeRebase(root: string, options: CascadeOptions): Promise<CascadeResult> {
  // Stack branches only: main advances through the human release flow, never
  // through an autonomous cascade (same bar as the machine key, #164).
  if (options.to === "main" || options.from === "main")
    throw new RebaseError("cascades involving main are refused: main advances through the human release flow")
  const previousSha = await Git.revParse(root, options.to)
  const fromTip = await Git.revParse(root, options.from)
  if (previousSha === fromTip) return { ok: true, previousSha, newSha: previousSha, rolledBack: false, resolutions: [] }
  if (await Git.isAncestor(root, fromTip, previousSha))
    // `to` already contains the fix (and possibly more): moving it back to
    // `fromTip` would drop commits, so this is a no-op success.
    return { ok: true, previousSha, newSha: previousSha, rolledBack: false, resolutions: [] }
  if (await Git.isAncestor(root, previousSha, fromTip)) {
    // `to` is strictly behind: a pure fast-forward, no replay needed.
    await Git.setBranch(root, options.to, fromTip)
    return { ok: true, previousSha, newSha: fromTip, rolledBack: false, resolutions: [] }
  }
  return replayCascade(root, options, previousSha)
}

/** Read both conflict stages for every unmerged file in parallel. */
async function readConflictStages(
  worktree: string,
  files: readonly string[],
): Promise<Array<{ readonly file: string; readonly ours: string; readonly theirs: string } | undefined>> {
  return Promise.all(
    files.map(async (file) => {
      const [ours, theirs] = await Promise.all([
        Git.git(worktree, ["show", `:2:${file}`], { allowFail: true }),
        Git.git(worktree, ["show", `:3:${file}`], { allowFail: true }),
      ])
      if (ours.code !== 0 || theirs.code !== 0) return undefined
      return { file, ours: ours.stdout, theirs: theirs.stdout }
    }),
  )
}

/**
 * Resolve one round of unmerged files and continue the sequencer.
 * Returns the resolved files, or a human-readable reason to abort.
 */
async function resolveRound(
  worktree: string,
  files: readonly string[],
): Promise<{ resolved: string[] } | { reason: string }> {
  const stages = await readConflictStages(worktree, files)
  const merged = new Map<string, string>()
  for (let i = 0; i < files.length; i++) {
    const stage = stages[i]
    if (!stage) return { reason: `conflict in ${files[i]}: stages unreadable` }
    const text = resolveConflict(stage.file, stage.ours, stage.theirs)
    if (text === undefined)
      return { reason: `unresolvable conflict in ${files.join(", ")}: a human must rebase by hand` }
    merged.set(stage.file, text)
  }
  for (const [file, text] of merged) {
    await writeFile(path.join(worktree, file), text)
    await Git.git(worktree, ["add", "--", file])
  }
  const continued = await Git.git(worktree, [...IDENTITY, "-c", "core.editor=true", "rebase", "--continue"], {
    allowFail: true,
  })
  if (continued.code !== 0 && (await unmerged(worktree)).length > 0) {
    await Git.git(worktree, ["rebase", "--abort"], { allowFail: true })
    return { reason: `conflict re-emerged after resolution: ${(continued.stderr || continued.stdout).trim()}` }
  }
  return { resolved: files.slice() }
}

/**
 * Drive the rebase sequencer to settlement: resolve rounds, skip empty
 * picks, abort on anything else. Returns resolutions or an abort reason.
 */
async function settleRebase(worktree: string, from: string): Promise<{ resolutions: string[] } | { reason: string }> {
  const resolutions: string[] = []
  const start = await Git.git(worktree, [...IDENTITY, "rebase", from], { allowFail: true })
  if (start.code !== 0 && !(await rebaseActive(worktree)) && (await unmerged(worktree)).length === 0)
    return { reason: `rebase onto ${from} failed to start: ${(start.stderr || start.stdout).trim()}` }
  for (let step = 0; step < 100; step++) {
    const uu = await unmerged(worktree)
    if (uu.length) {
      const round = await resolveRound(worktree, uu)
      if ("reason" in round) {
        await Git.git(worktree, ["rebase", "--abort"], { allowFail: true })
        return round
      }
      resolutions.push(...round.resolved)
      continue
    }
    if (!(await rebaseActive(worktree))) return { resolutions }
    // No unmerged files but the sequencer is stuck (empty pick): skip it.
    const skipped = await Git.git(worktree, [...IDENTITY, "-c", "core.editor=true", "rebase", "--skip"], {
      allowFail: true,
    })
    if (skipped.code !== 0) {
      await Git.git(worktree, ["rebase", "--abort"], { allowFail: true })
      return { reason: `rebase sequencer stalled: ${(skipped.stderr || skipped.stdout).trim()}` }
    }
  }
  await Git.git(worktree, ["rebase", "--abort"], { allowFail: true })
  return { reason: "rebase did not settle within 100 sequencer steps" }
}

/** The replay path of cascadeRebase: scratch worktree, settle, test, move-or-restore. */
async function replayCascade(root: string, options: CascadeOptions, previousSha: string): Promise<CascadeResult> {
  const scratch = await mkdtemp(path.join(options.scratchDir ?? tmpdir(), "es-rebase-"))
  const worktree = path.join(scratch, "tree")
  const resolutions: string[] = []
  const fail = async (reason: string): Promise<CascadeResult> => {
    await Git.removeWorktree(root, worktree).catch(() => undefined)
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    // Explicit restore: `to` never moved (all work happened in scratch),
    // but the monotonic guarantee pins it back to the witnessed SHA anyway.
    await Git.setBranch(root, options.to, previousSha)
    return { ok: false, previousSha, rolledBack: true, resolutions, reason }
  }
  try {
    await Git.git(root, [
      "worktree",
      "add",
      "-B",
      `es-rebase-scratch-${Date.now()}-${randomInt(1_000_000)}`,
      worktree,
      options.to,
    ])
    const settled = await settleRebase(worktree, options.from)
    if ("reason" in settled) return fail(settled.reason)
    resolutions.push(...settled.resolutions)
    const newTip = await Git.headCommit(worktree)
    const changed = (await Git.git(worktree, ["diff", "--name-only", previousSha, newTip], { allowFail: true })).stdout
      .split("\n")
      .filter(Boolean)
    const runTests = options.runTests ?? ((dir) => sanityTests(dir, changed))
    if (!(await runTests(worktree))) return fail("post-rebase tests failed: restored the previous SHA")
    await Git.setBranch(root, options.to, newTip)
    await Git.removeWorktree(root, worktree)
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    return { ok: true, previousSha, newSha: newTip, rolledBack: false, resolutions }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
