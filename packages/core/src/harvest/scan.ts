// Project scanning: resolve a candidate source to a directory (cloning when
// needed), build the structural picture with the shared tree-sitter index,
// detect the license deterministically, and assemble the profile with
// per-field provenance and explicit warnings. Reads of candidate content are
// bounded by a per-candidate token budget (readCandidate), so the harvester
// pays for what it reads.
import { open, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import type { HarvestProfile, LicenseFinding, Provenance } from "../schema/harvest.ts"
import { buildImportGraph } from "../structure/index.ts"
import { relativeTo } from "../trust/paths.ts"
import { readJson, writeJson } from "../util/fs.ts"
import { git } from "../worktree/git.ts"
import { type ApiOptions, type RegistryId, registryMetadata, shallowClone } from "./sources.ts"
import { detectLicense, familyOf, normalizeLicenseId } from "./spdx.ts"

export type HarvestSource =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "git"; readonly url: string }
  | { readonly kind: "github"; readonly repo: string }
  | { readonly kind: "gitlab"; readonly repo: string }
  | { readonly kind: "registry"; readonly registry: RegistryId; readonly name: string }

export const sourceLabel = (source: HarvestSource): string => {
  switch (source.kind) {
    case "local":
      return `local:${source.path}`
    case "git":
      return `git:${source.url}`
    case "github":
      return `github:${source.repo}`
    case "gitlab":
      return `gitlab:${source.repo}`
    case "registry":
      return `${source.registry}:${source.name}`
  }
}

/** "local:./path", "git:https://…", "github:owner/repo", "npm:name", or a path. */
export function parseSource(spec: string): HarvestSource {
  const trimmed = spec.trim()
  const prefix = /^([a-z]+):(.*)$/s.exec(trimmed)
  if (prefix) {
    const [, kind, rest] = prefix
    if (kind === "local" || kind === "path") return { kind: "local", path: rest! }
    if (kind === "git") return { kind: "git", url: rest! }
    if (kind === "github") return { kind: "github", repo: rest! }
    if (kind === "gitlab") return { kind: "gitlab", repo: rest! }
    if (kind === "npm" || kind === "pypi" || kind === "crates") return { kind: "registry", registry: kind, name: rest! }
    if (rest!.startsWith("//")) return { kind: "git", url: trimmed } // https://…
  }
  if (/^(https?:\/\/|git@)/.test(trimmed)) return { kind: "git", url: trimmed }
  return { kind: "local", path: trimmed }
}

export const candidateId = (name: string) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
  let start = 0
  let end = slug.length
  while (start < end && slug[start] === "-") start += 1
  while (end > start && slug[end - 1] === "-") end -= 1
  return slug.slice(start, end).slice(0, 64) || "candidate"
}

/** Read a file through one descriptor so the size cap and the read cannot race. */
async function readCapped(absolute: string, file: string): Promise<string> {
  const handle = await open(absolute, "r").catch(() => undefined)
  if (!handle) throw new Error(`no such file: ${file}`)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`no such file: ${file}`)
    if (info.size > 2_000_000) throw new Error(`"${file}" is larger than 2 MB; read a slice by an editor instead`)
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

export const harvestRuntimeDir = (root: string, id: string) => path.join(factoryLayout(root).runtime, "harvest", id)
export const harvestRepoDir = (root: string, id: string) => path.join(harvestRuntimeDir(root, id), "repo")

export interface ScanOptions extends ApiOptions {
  /** Override the clone step (tests). */
  readonly clone?: (url: string, dir: string) => Promise<unknown>
  readonly maxFiles?: number
  readonly regexOnly?: boolean
  readonly cacheDir?: string
  readonly offline?: boolean
}

const MANIFESTS = {
  async npm(dir: string): Promise<{ runtime: string[]; dev: string[] } | undefined> {
    const text = await readFile(path.join(dir, "package.json"), "utf8").catch(() => undefined)
    if (!text) return undefined
    try {
      const pkg = JSON.parse(text) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      return { runtime: Object.keys(pkg.dependencies ?? {}), dev: Object.keys(pkg.devDependencies ?? {}) }
    } catch {
      return undefined
    }
  },
  async python(dir: string): Promise<{ runtime: string[]; dev: string[] } | undefined> {
    const requirements = await readFile(path.join(dir, "requirements.txt"), "utf8").catch(() => undefined)
    if (requirements !== undefined)
      return {
        runtime: requirements
          .split("\n")
          .map((line) => /^\s*([A-Za-z0-9_.-]+)/.exec(line.replace(/#.*/, ""))?.[1])
          .filter((name): name is string => Boolean(name)),
        dev: [],
      }
    return undefined
  },
  async cargo(dir: string): Promise<{ runtime: string[]; dev: string[] } | undefined> {
    const text = await readFile(path.join(dir, "Cargo.toml"), "utf8").catch(() => undefined)
    if (text === undefined) return undefined
    const names: string[] = []
    let inDeps = false
    for (const line of text.split("\n")) {
      if (/^\s*\[/.test(line)) inDeps = /^\s*\[(?:dev-)?dependencies\]/.test(line)
      else if (inDeps) {
        const name = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]
        if (name) names.push(name)
      }
    }
    return { runtime: names, dev: [] }
  },
}

async function dependenciesOf(dir: string): Promise<{ runtime: string[]; dev: string[] }> {
  const runtime = new Set<string>()
  const dev = new Set<string>()
  for (const parse of [MANIFESTS.npm, MANIFESTS.python, MANIFESTS.cargo]) {
    const found = await parse(dir)
    if (found) {
      for (const name of found.runtime) runtime.add(name)
      for (const name of found.dev) dev.add(name)
    }
  }
  return { runtime: [...runtime].sort(), dev: [...dev].sort() }
}

/** Scan a candidate and return its profile. Also records where its bytes live. */
export async function scanSource(
  root: string,
  id: string,
  source: HarvestSource,
  options: ScanOptions = {},
): Promise<HarvestProfile> {
  const scannedAt = new Date().toISOString()
  const warnings: string[] = []

  if (source.kind === "registry") {
    const pkg = await registryMetadata(source.registry, source.name, options)
    const spdx = pkg.license ? normalizeLicenseId(pkg.license) : "unknown"
    const license: LicenseFinding = {
      spdx,
      family: familyOf(spdx),
      source: "registry",
      confidence: "medium",
      verified: false,
      note: "self-reported registry metadata; no license text inspected",
    }
    if (spdx === "unknown") warnings.push("the registry declares no license; treat as unknown")
    else warnings.push(`license "${spdx}" is self-reported registry metadata, not text-verified`)
    return {
      version: 1,
      id,
      name: pkg.name,
      origin: `${source.registry}:${source.name}`,
      ...(pkg.version ? { release: pkg.version } : {}),
      license,
      languages: {},
      dependencies: { runtime: [], dev: [] },
      size: { files: 0, bytes: 0, tokens: 0 },
      graph: { internalEdges: 0, external: 0, parsers: { treeSitter: 0, regex: 0 } },
      provenance: {
        name: { kind: "registry", source: `${source.registry}:${source.name}`, verified: true },
        origin: { kind: "registry", source: `${source.registry}:${source.name}`, verified: true },
        license: { kind: "registry", source: `${source.registry}:${source.name}`, verified: false },
        dependencies: { kind: "inferred", verified: false, note: "registry metadata has no dependency list" },
      },
      warnings,
      scannedAt,
    }
  }

  let dir: string
  let provenanceKind: Provenance["kind"]
  if (source.kind === "local") {
    dir = path.resolve(root, source.path)
    provenanceKind = "local"
    const info = await stat(dir).catch(() => undefined)
    if (!info?.isDirectory()) throw new Error(`not a directory: ${dir}`)
  } else {
    const url =
      source.kind === "git"
        ? source.url
        : source.kind === "github"
          ? `https://github.com/${source.repo}.git`
          : `https://gitlab.com/${source.repo}.git`
    dir = harvestRepoDir(root, id)
    provenanceKind = "clone"
    await (options.clone ?? ((remote: string, target: string) => shallowClone(remote, target, options)))(url, dir)
  }
  await writeJson(path.join(harvestRuntimeDir(root, id), "source.json"), { source, dir })

  const license = await detectLicense(dir)
  if (license.spdx === "unknown")
    warnings.push("no license text or manifest field found; unknown licenses are clean-room only")
  else if (!license.verified)
    warnings.push(`license "${license.spdx}" is self-reported (${license.source}), not text-verified`)

  const maxFiles = options.maxFiles ?? 5_000
  const graph = await buildImportGraph(dir, {
    maxFiles,
    ...(options.regexOnly ? { regexOnly: true } : {}),
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    ...(options.offline !== undefined ? { offline: options.offline } : {}),
  })
  if (!graph) warnings.push(`the project is larger than the ${maxFiles}-file index cap; structure is best effort`)
  const files = graph ? [...graph.files.keys()] : []
  const languages: Record<string, number> = {}
  let bytes = 0
  for (const file of files) {
    const language = file.split(".").at(-1) ?? "other"
    languages[language] = (languages[language] ?? 0) + 1
    bytes += await stat(path.join(dir, file)).then(
      (info) => info.size,
      () => 0,
    )
  }
  const internalEdges = graph ? [...graph.edges.values()].reduce((total, set) => total + set.size, 0) : 0
  const external = graph ? [...graph.external.values()].reduce((total, list) => total + list.length, 0) : 0
  const dependencies = await dependenciesOf(dir)
  const pkgJson = await readFile(path.join(dir, "package.json"), "utf8").catch(() => undefined)
  let name = path.basename(dir)
  if (pkgJson) {
    try {
      name = (JSON.parse(pkgJson) as { name?: string }).name ?? name
    } catch {}
  }
  const commit = (await git(dir, ["rev-parse", "HEAD"], { allowFail: true })).stdout.trim()
  const verified = provenanceKind === "local" || provenanceKind === "clone"
  const licenseKind: Provenance["kind"] =
    license.source === "license-file" || license.source === "spdx-header" ? provenanceKind : "inferred"
  return {
    version: 1,
    id,
    name,
    origin: sourceLabel(source),
    ...(commit ? { commit } : {}),
    license,
    languages,
    dependencies,
    size: { files: files.length, bytes, tokens: Math.ceil(bytes / 4) },
    graph: {
      internalEdges,
      external,
      parsers: graph?.parsers ?? { treeSitter: 0, regex: 0 },
    },
    provenance: {
      name: {
        kind: pkgJson ? provenanceKind : "inferred",
        ...(pkgJson ? { source: "package.json" } : {}),
        verified: verified && Boolean(pkgJson),
      },
      origin: { kind: provenanceKind, source: sourceLabel(source), verified: true },
      ...(commit ? { commit: { kind: provenanceKind, source: "git rev-parse HEAD", verified: true } } : {}),
      license: {
        kind: licenseKind,
        ...(license.file ? { source: license.file } : {}),
        verified: license.verified,
        ...(license.note ? { note: license.note } : {}),
      },
      languages: { kind: provenanceKind, source: "structural index", verified: Boolean(graph) },
      size: { kind: provenanceKind, source: "structural index", verified: Boolean(graph) },
      graph: { kind: provenanceKind, source: "structural index", verified: Boolean(graph) },
      dependencies: { kind: provenanceKind, source: "manifests", verified: true },
    },
    warnings,
    scannedAt,
  }
}

// ------------------------------------------------------------- bounded reads

export interface HarvestRead {
  readonly text: string
  readonly file: string
  readonly offset: number
  readonly tokens: number
  readonly spent: number
  readonly budget: number
  readonly truncated: boolean
}

interface ReadsState {
  entries: Array<{ file: string; tokens: number; at: string }>
}

const readsFile = (root: string, id: string) => path.join(harvestRuntimeDir(root, id), "reads.json")

/** Read candidate content on demand, inside the per-candidate token budget. */
export async function readCandidate(
  root: string,
  id: string,
  file: string,
  options: { offset?: number; maxChars?: number; budgetTokens: number },
): Promise<HarvestRead> {
  const record = await readJson<{ dir: string }>(path.join(harvestRuntimeDir(root, id), "source.json"))
  if (!record?.dir) throw new Error(`candidate "${id}" has not been scanned`)
  const absolute = path.resolve(record.dir, file)
  if (relativeTo(record.dir, absolute) === undefined) throw new Error(`"${file}" is outside the candidate directory`)
  const state = (await readJson<ReadsState>(readsFile(root, id))) ?? { entries: [] }
  const spent = state.entries.reduce((total, entry) => total + entry.tokens, 0)
  if (spent >= options.budgetTokens)
    throw new Error(
      `the read budget for "${id}" is exhausted (${spent}/${options.budgetTokens} tokens); use what you have or raise the budget`,
    )
  const content = await readCapped(absolute, file)
  const offset = Math.max(0, options.offset ?? 0)
  const remainingChars = Math.max(0, (options.budgetTokens - spent) * 4)
  const maxChars = Math.min(options.maxChars ?? 8_000, remainingChars)
  const text = content.slice(offset, offset + maxChars)
  const tokens = Math.ceil(text.length / 4)
  state.entries.push({ file, tokens, at: new Date().toISOString() })
  await writeJson(readsFile(root, id), state)
  return {
    text,
    file,
    offset,
    tokens,
    spent: spent + tokens,
    budget: options.budgetTokens,
    truncated: offset + maxChars < content.length,
  }
}
