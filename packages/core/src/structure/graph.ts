// Import graph over a project's source files, and the tests a change can
// affect (reverse reachability). Resolution covers relative JS/TS specifiers
// (".js" → ".ts", index files), workspace packages (package.json exports),
// Python relative and absolute modules, and Go module-path imports
// (package directories). Unresolved specifiers are external.
import { lstat, open, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { git } from "../worktree/git.ts"
import { extractStructure, type FileStructure } from "./extract.ts"
import { type GrammarOptions, grammarFor } from "./grammars.ts"

export interface ImportGraph {
  readonly dir: string
  readonly files: ReadonlyMap<string, FileStructure>
  /** file → files it imports (POSIX paths relative to dir). */
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>
  /** file → files that import it. */
  readonly reverse: ReadonlyMap<string, ReadonlySet<string>>
  /** file → specifiers that resolved to nothing in the project (external). */
  readonly external: ReadonlyMap<string, readonly string[]>
  readonly parsers: { readonly treeSitter: number; readonly regex: number }
}

export interface GraphOptions extends GrammarOptions {
  /** Explicit file list (relative); default: git-tracked plus untracked, non-ignored files. */
  readonly files?: readonly string[]
  readonly maxFiles?: number
  readonly regexOnly?: boolean
  /**
   * Harvested (untrusted) content: list files by walking instead of running
   * git (a repository's own config could execute code), and never read
   * through a symlink.
   */
  readonly untrusted?: boolean
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".factory",
  "dist",
  "build",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  "coverage",
])

/**
 * Source files with a grammar: git's view when available, else a bounded walk
 * (always the walk for untrusted content). The walk never follows symlinks.
 */
export async function listSourceFiles(
  dir: string,
  maxFiles = 20_000,
  options: { untrusted?: boolean } = {},
): Promise<string[]> {
  const listed = options.untrusted
    ? undefined
    : await git(dir, ["ls-files", "-co", "--exclude-standard", "-z"], { allowFail: true }).catch(() => undefined)
  let files: string[]
  if (listed && listed.code === 0) files = listed.stdout.split("\0").filter(Boolean)
  else {
    files = []
    const walk = async (rel: string) => {
      if (files.length >= maxFiles) return
      const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const child = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(child)
        } else if (entry.isFile()) files.push(child)
      }
    }
    await walk("")
  }
  return files.filter((file) => grammarFor(file) !== undefined && !file.split("/").some((part) => SKIP_DIRS.has(part)))
}

// Per-path cache keyed by mtime+size so repeated gate runs re-read only changed files.
const fileCache = new Map<string, { mtimeMs: number; size: number; regexOnly: boolean; structure: FileStructure }>()

async function structureOf(absolute: string, rel: string, options: GraphOptions) {
  if (options.untrusted && !(await lstat(absolute).catch(() => undefined))?.isFile()) return undefined
  // Open once and stat the descriptor, so the size/mtime check and the read
  // cannot race with a concurrent replacement of the path.
  const handle = await open(absolute, "r").catch(() => undefined)
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 2_000_000) return undefined
    const cached = fileCache.get(absolute)
    if (
      cached &&
      cached.mtimeMs === info.mtimeMs &&
      cached.size === info.size &&
      cached.regexOnly === Boolean(options.regexOnly)
    )
      return cached.structure
    const text = await handle.readFile("utf8")
    const structure = await extractStructure(rel, text, options)
    if (structure) {
      if (fileCache.size > 50_000) fileCache.clear()
      fileCache.set(absolute, {
        mtimeMs: info.mtimeMs,
        size: info.size,
        regexOnly: Boolean(options.regexOnly),
        structure,
      })
    }
    return structure
  } finally {
    await handle.close()
  }
}

// ------------------------------------------------------------- resolution

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"]
const SWAP: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
}

interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly exports?: unknown
  readonly main?: string
}

const CONDITIONS = ["bun", "source", "types", "import", "module", "default", "require", "node"]

function pickCondition(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(pickCondition).find(Boolean)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of CONDITIONS) if (key in record) return pickCondition(record[key])
  }
  return undefined
}

/** package.json "exports" for a subpath ("." or "./x"), including "./*" patterns. */
function exportTarget(exports: unknown, subpath: string): string | undefined {
  if (typeof exports === "string" || Array.isArray(exports)) return subpath === "." ? pickCondition(exports) : undefined
  if (!exports || typeof exports !== "object") return undefined
  const map = exports as Record<string, unknown>
  if (!Object.keys(map).some((key) => key.startsWith("."))) return subpath === "." ? pickCondition(map) : undefined
  if (subpath in map) return pickCondition(map[subpath])
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf("*")
    if (star < 0) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const target = pickCondition(value)
      return target?.replaceAll("*", subpath.slice(prefix.length, subpath.length - suffix.length))
    }
  }
  return undefined
}

class Resolver {
  constructor(
    private readonly files: ReadonlySet<string>,
    private readonly packages: readonly WorkspacePackage[],
    private readonly goModules: ReadonlyArray<{ module: string; dir: string }>,
  ) {}

  private jsCandidates(base: string): string | undefined {
    const normal = path.posix.normalize(base)
    if (this.files.has(normal)) return normal
    const ext = path.posix.extname(normal)
    for (const swap of SWAP[ext] ?? []) {
      const candidate = normal.slice(0, -ext.length) + swap
      if (this.files.has(candidate)) return candidate
    }
    for (const suffix of JS_EXTS) if (this.files.has(normal + suffix)) return normal + suffix
    for (const suffix of JS_EXTS) if (this.files.has(`${normal}/index${suffix}`)) return `${normal}/index${suffix}`
    return undefined
  }

  js(from: string, specifier: string): string | undefined {
    if (specifier.startsWith(".")) return this.jsCandidates(path.posix.join(path.posix.dirname(from), specifier))
    if (specifier.startsWith("/")) return undefined
    const pkg = this.packages
      .filter((item) => specifier === item.name || specifier.startsWith(`${item.name}/`))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (!pkg) return undefined
    const subpath = specifier === pkg.name ? "." : `./${specifier.slice(pkg.name.length + 1)}`
    const join = (target: string) => (pkg.dir ? path.posix.join(pkg.dir, target) : path.posix.normalize(target))
    const target = pkg.exports !== undefined ? exportTarget(pkg.exports, subpath) : undefined
    if (target) return this.jsCandidates(join(target))
    if (subpath === ".")
      return (
        (pkg.main ? this.jsCandidates(join(pkg.main)) : undefined) ??
        this.jsCandidates(join("src/index")) ??
        this.jsCandidates(join("index"))
      )
    return this.jsCandidates(join(subpath))
  }

  private pyModule(base: string): string | undefined {
    for (const candidate of [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`])
      if (this.files.has(path.posix.normalize(candidate))) return path.posix.normalize(candidate)
    return undefined
  }

  python(from: string, specifier: string, names: readonly string[] = []): string[] {
    const out: string[] = []
    const dots = /^\.*/.exec(specifier)![0].length
    const rest = specifier.slice(dots).split(".").filter(Boolean).join("/")
    const roots: string[] = []
    if (dots > 0) {
      let base = path.posix.dirname(from)
      for (let i = 1; i < dots; i++) base = path.posix.dirname(base)
      roots.push(base === "." ? "" : base)
    } else {
      const own = path.posix.dirname(from)
      roots.push("", "src", "lib", own === "." ? "" : own)
    }
    for (const root of new Set(roots)) {
      const base = root ? (rest ? `${root}/${rest}` : root) : rest
      const module = base ? this.pyModule(base) : undefined
      if (module) out.push(module)
      // `from pkg import sub` may name submodules.
      for (const name of names)
        if (name !== "*") {
          const sub = this.pyModule(base ? `${base}/${name}` : name)
          if (sub) out.push(sub)
        }
      if (out.length) break
    }
    return out
  }

  go(specifier: string): string[] {
    const module = this.goModules
      .filter((item) => specifier === item.module || specifier.startsWith(`${item.module}/`))
      .sort((a, b) => b.module.length - a.module.length)[0]
    if (!module) return []
    const rest = specifier.slice(module.module.length).replace(/^\//, "")
    const dir = path.posix.join(module.dir || ".", rest)
    return [...this.files].filter(
      (file) =>
        file.endsWith(".go") && !file.endsWith("_test.go") && path.posix.dirname(file) === path.posix.normalize(dir),
    )
  }
}

/** Read a manifest; for untrusted content only a regular file (never a symlink). */
async function readManifest(file: string, untrusted: boolean): Promise<string | undefined> {
  if (untrusted && !(await lstat(file).catch(() => undefined))?.isFile()) return undefined
  return readFile(file, "utf8").catch(() => undefined)
}

async function workspacePackages(
  dir: string,
  files: readonly string[],
  untrusted: boolean,
): Promise<WorkspacePackage[]> {
  const manifests = new Set(["package.json"])
  for (const file of files) {
    const parts = file.split("/")
    for (let i = 1; i < parts.length && i <= 3; i++) manifests.add(`${parts.slice(0, i).join("/")}/package.json`)
  }
  const out: WorkspacePackage[] = []
  for (const manifest of manifests) {
    const text = await readManifest(path.join(dir, manifest), untrusted)
    if (!text) continue
    try {
      const pkg = JSON.parse(text) as { name?: string; exports?: unknown; main?: string }
      if (!pkg.name) continue
      const pkgDir = path.posix.dirname(manifest)
      out.push({
        name: pkg.name,
        dir: pkgDir === "." ? "" : pkgDir,
        ...(pkg.exports !== undefined ? { exports: pkg.exports } : {}),
        ...(pkg.main ? { main: pkg.main } : {}),
      })
    } catch {}
  }
  return out
}

async function goModules(dir: string, files: readonly string[], untrusted: boolean) {
  // A go.mod sits at a module root, not necessarily beside each file: walk up
  // from every .go file and collect the manifests found along the way.
  const candidates = new Set<string>()
  for (const file of files) {
    if (!file.endsWith(".go")) continue
    let current = path.posix.dirname(file)
    while (!candidates.has(current)) {
      candidates.add(current)
      if (current === "." || current === "") break
      current = path.posix.dirname(current)
    }
  }
  const out: Array<{ module: string; dir: string }> = []
  for (const candidate of candidates) {
    const text = await readManifest(path.join(dir, candidate, "go.mod"), untrusted)
    const module = text ? /^module\s+(\S+)/m.exec(text)?.[1] : undefined
    if (module) out.push({ module, dir: candidate === "." ? "" : candidate })
  }
  return out
}

// ------------------------------------------------------------- graph

export async function buildImportGraph(dir: string, options: GraphOptions = {}): Promise<ImportGraph | undefined> {
  const maxFiles = options.maxFiles ?? 10_000
  const untrusted = options.untrusted === true
  const list = options.files ? [...options.files] : await listSourceFiles(dir, maxFiles + 1, { untrusted })
  if (list.length > maxFiles) return undefined
  const files = new Map<string, FileStructure>()
  let treeSitter = 0
  let regex = 0
  for (const rel of list) {
    const structure = await structureOf(path.join(dir, rel), rel, options)
    if (!structure) continue
    files.set(rel, structure)
    if (structure.parser === "tree-sitter") treeSitter++
    else regex++
  }
  const names = new Set(files.keys())
  const resolver = new Resolver(
    names,
    await workspacePackages(dir, list, untrusted),
    await goModules(dir, list, untrusted),
  )
  const edges = new Map<string, Set<string>>()
  const reverse = new Map<string, Set<string>>()
  const external = new Map<string, string[]>()
  const link = (from: string, to: string) => {
    if (from === to) return
    if (!edges.has(from)) edges.set(from, new Set())
    edges.get(from)!.add(to)
    if (!reverse.has(to)) reverse.set(to, new Set())
    reverse.get(to)!.add(from)
  }
  const goByDir = new Map<string, string[]>()
  for (const [file, structure] of files) {
    if (structure.language === "go") {
      const key = path.posix.dirname(file)
      goByDir.set(key, [...(goByDir.get(key) ?? []), file])
    }
    for (const ref of structure.imports) {
      const targets =
        structure.language === "python"
          ? resolver.python(file, ref.specifier, ref.names)
          : structure.language === "go"
            ? resolver.go(ref.specifier)
            : [resolver.js(file, ref.specifier)].filter((item): item is string => Boolean(item))
      if (targets.length) for (const target of targets) link(file, target)
      else external.set(file, [...(external.get(file) ?? []), ref.specifier])
    }
  }
  // Go: files of one package see each other; tests see the whole package.
  for (const group of goByDir.values())
    for (const file of group)
      for (const other of group) if (!other.endsWith("_test.go") || file.endsWith("_test.go")) link(file, other)
  return { dir, files, edges, reverse, external, parsers: { treeSitter, regex } }
}

/** Every file that (transitively) imports one of `changed`, plus `changed` itself. */
export function dependentsOf(graph: ImportGraph, changed: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const queue = changed.filter((file) => graph.files.has(file))
  for (const file of queue) seen.add(file)
  while (queue.length) {
    const file = queue.shift()!
    for (const parent of graph.reverse.get(file) ?? [])
      if (!seen.has(parent)) {
        seen.add(parent)
        queue.push(parent)
      }
  }
  return seen
}

/**
 * Files a test runner executes: `*.test.*` / `*.spec.*` / `*_test.*`,
 * `__tests__/*`, `test_*.py`, `*_test.py`, `*_test.go`. Helpers that merely
 * live under test/ are traversed by the graph but never selected.
 */
const RUNNABLE_TEST =
  /(?:^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$|[._](?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/
export const isRunnableTest = (file: string) => RUNNABLE_TEST.test(file)

export interface AffectedTests {
  readonly tests: readonly string[]
  /** Changed files the graph knows about. */
  readonly known: readonly string[]
  readonly graph: ImportGraph
}

/**
 * Tests reachable from the change set through the reverse import graph.
 * Undefined when the graph cannot help (no graphable files changed, or the
 * project is too large), so callers fall back to runner-native selection.
 */
export async function affectedTests(
  dir: string,
  changed: readonly string[],
  options: GraphOptions = {},
): Promise<AffectedTests | undefined> {
  if (!changed.some((file) => grammarFor(file))) return undefined
  const graph = await buildImportGraph(dir, options)
  if (!graph) return undefined
  const known = changed.filter((file) => graph.files.has(file))
  if (!known.length) return undefined
  const tests = [...dependentsOf(graph, known)].filter(isRunnableTest).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { tests, known, graph }
}
