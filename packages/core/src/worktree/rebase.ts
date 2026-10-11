// Automated semantic rebase across stack branches (#165, Phase 7).
//
// Upstream fixes cascade downstream without a human replaying commits:
// unique commits on `to` are rebased onto `from`'s tip in a scratch
// worktree, TypeScript-import and JSON conflicts resolve AST-aware, and the
// target branch moves ONLY when the post-rebase tests pass — otherwise the
// previous SHA is restored (the monotonic test guarantee). `to` is never
// touched before the green verdict, so a failure always leaves it intact.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as Git from "./git.ts"

export class RebaseError extends Error {}

/** Merge two single-line-import TypeScript sources; undefined when unsafe. */
export function mergeTypeScriptImports(ours: string, theirs: string): string | undefined {
  // Multi-line imports need a real parser: refuse rather than guess. A line
  // that opens an import without a `from "module"` (and is not a bare
  // side-effect import) continues on the next line.
  const multiline = (text: string) =>
    text
      .split("\n")
      .some((line) => /^\s*import\s+/.test(line) && !/from\s*["']/.test(line) && !/^\s*import\s*["']/.test(line))
  if (multiline(ours) || multiline(theirs)) return undefined
  interface Parsed {
    readonly module: string
    readonly def?: string
    readonly named: string[]
    readonly typeOnly: boolean
    readonly raw: string
  }
  const parse = (line: string): Parsed | undefined => {
    const match = /^\s*import\s+(.+?)\s+from\s*(["'])(.+?)\2\s*;?\s*$/.exec(line)
    if (!match) return undefined
    const clause = match[1]!
    const typeOnly = /^type\b/.test(clause.trim())
    const bare = typeOnly
      ? clause
          .trim()
          .replace(/^type\b/, "")
          .trim()
      : clause.trim()
    const named =
      /^\{([^}]*)\}$/
        .exec(bare)?.[1]
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? []
    if (/^\{/.test(bare) && !named.length) return undefined
    const def = /^\{/.test(bare) ? undefined : bare || undefined
    if (def === undefined && !named.length) return undefined
    return { module: match[3]!, def, named, typeOnly, raw: line }
  }
  const oursLines = ours.split("\n")
  const theirsLines = theirs.split("\n")
  // Only import lines may differ; anything else means a real code conflict.
  const strip = (lines: string[]) => lines.filter((line) => line.trim() && !/^\s*import\s+/.test(line)).join("\n")
  if (strip(oursLines) !== strip(theirsLines)) return undefined
  for (const line of [...oursLines, ...theirsLines])
    if (line.trim() && !/^\s*import\s+/.test(line) && !/^\s*$/.test(line)) {
    }
  const merged = new Map<string, Parsed>()
  for (const line of [...oursLines, ...theirsLines]) {
    if (!line.trim() || !/^\s*import\s+/.test(line)) continue
    const parsed = parse(line)
    if (!parsed) return undefined
    const existing = merged.get(parsed.module)
    if (!existing) merged.set(parsed.module, parsed)
    else if (existing.typeOnly !== parsed.typeOnly) return undefined
    else if (existing.def !== undefined && parsed.def !== undefined && existing.def !== parsed.def) return undefined
    else
      merged.set(parsed.module, {
        module: parsed.module,
        def: existing.def ?? parsed.def,
        named: [...new Set([...existing.named, ...parsed.named])].sort(),
        typeOnly: existing.typeOnly,
        raw: existing.raw,
      })
  }
  const rendered = [...merged.values()].map((entry) => {
    const parts: string[] = []
    if (entry.def) parts.push(entry.def)
    if (entry.named.length) parts.push(`{ ${entry.named.join(", ")} }`)
    const quote = /"[^"]*" from/.test(entry.raw) || entry.raw.includes('"') ? '"' : "'"
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
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const a = (ours[section] ?? {}) as Record<string, string>
    const b = (theirs[section] ?? {}) as Record<string, string>
    if (typeof a !== "object" || typeof b !== "object") continue
    const merged: Record<string, string> = { ...a }
    for (const [key, value] of Object.entries(b)) merged[key] = key in merged ? newer(merged[key]!, value) : value
    if (Object.keys(merged).length) out[section] = merged
  }
  for (const [key, value] of Object.entries(theirs))
    if (!["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].includes(key) && !(key in out))
      out[key] = value
  return `${JSON.stringify(out, null, 2)}\n`
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
  const scratch = await mkdtemp(path.join(options.scratchDir ?? tmpdir(), "es-rebase-"))
  const resolutions: string[] = []
  const fail = async (reason: string, worktree?: string): Promise<CascadeResult> => {
    if (worktree) await Git.removeWorktree(root, worktree).catch(() => undefined)
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    // Explicit restore: `to` never moved (all work happened in scratch),
    // but the monotonic guarantee pins it back to the witnessed SHA anyway.
    await Git.setBranch(root, options.to, previousSha)
    return { ok: false, previousSha, rolledBack: true, resolutions, reason }
  }
  let worktree = ""
  try {
    worktree = path.join(scratch, "tree")
    await Git.git(root, [
      "worktree",
      "add",
      "-B",
      `es-rebase-scratch-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
      worktree,
      options.to,
    ])
    const start = await Git.git(worktree, [...IDENTITY, "rebase", options.from], { allowFail: true })
    if (start.code !== 0 && !(await rebaseActive(worktree)) && (await unmerged(worktree)).length === 0)
      return fail(`rebase onto ${options.from} failed to start: ${(start.stderr || start.stdout).trim()}`)
    for (let step = 0; step < 100; step++) {
      const uu = await unmerged(worktree)
      if (uu.length) {
        let resolvable = true
        for (const file of uu) {
          const ours = await Git.git(worktree, ["show", `:2:${file}`], { allowFail: true })
          const theirs = await Git.git(worktree, ["show", `:3:${file}`], { allowFail: true })
          if (ours.code !== 0 || theirs.code !== 0) {
            resolvable = false
            break
          }
          const merged = resolveConflict(file, ours.stdout, theirs.stdout)
          if (merged === undefined) {
            resolvable = false
            break
          }
          await writeFile(path.join(worktree, file), merged)
          await Git.git(worktree, ["add", "--", file])
          resolutions.push(file)
        }
        if (!resolvable) {
          await Git.git(worktree, ["rebase", "--abort"], { allowFail: true })
          return fail(`unresolvable conflict in ${uu.join(", ")}: a human must rebase by hand`)
        }
        const continued = await Git.git(worktree, [...IDENTITY, "-c", "core.editor=true", "rebase", "--continue"], {
          allowFail: true,
        })
        if (continued.code !== 0 && (await unmerged(worktree)).length > 0) {
          await Git.git(worktree, ["rebase", "--abort"], { allowFail: true })
          return fail(`conflict re-emerged after resolution: ${(continued.stderr || continued.stdout).trim()}`)
        }
        continue
      }
      if (!(await rebaseActive(worktree))) break
      // No unmerged files but the sequencer is stuck (empty pick): skip it.
      const skipped = await Git.git(worktree, [...IDENTITY, "-c", "core.editor=true", "rebase", "--skip"], {
        allowFail: true,
      })
      if (skipped.code !== 0) {
        await Git.git(worktree, ["rebase", "--abort"], { allowFail: true })
        return fail(`rebase sequencer stalled: ${(skipped.stderr || skipped.stdout).trim()}`)
      }
    }
    if (await rebaseActive(worktree)) {
      await Git.git(worktree, ["rebase", "--abort"], { allowFail: true })
      return fail("rebase did not settle within 100 sequencer steps")
    }
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
    return fail(error instanceof Error ? error.message : String(error), worktree || undefined)
  }
}
