// Harvest sources: the GitHub/GitLab discovery APIs (injectable fetch), a
// shallow git clone, and package-registry metadata. A failed network call
// throws or returns a warning; nothing unverified is ever silently treated as
// fact — profiles record provenance and the matrix policy blocks unverified
// licenses from depend/vendor verdicts.
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { run } from "../util/proc.ts"

export interface RemoteRepo {
  readonly id: string
  readonly name: string
  readonly fullName?: string
  readonly url: string
  readonly description?: string
  readonly stars?: number
  readonly updatedAt?: string
  readonly license?: string
  readonly topics?: readonly string[]
}

export interface ApiOptions {
  readonly fetch?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
}

const fetchImpl = (options: ApiOptions) => options.fetch ?? fetch

async function getJson<T>(url: string, options: ApiOptions, headers: Record<string, string>): Promise<T> {
  const response = await fetchImpl(options)(url, {
    headers: { accept: "application/json", "user-agent": "epistemic-swarm", ...headers },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
  return (await response.json()) as T
}

export function githubApi(options: ApiOptions = {}) {
  const env = options.env ?? process.env
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
  const map = (item: any): RemoteRepo => ({
    id: String(item.full_name ?? item.name ?? ""),
    name: String(item.name ?? item.full_name ?? ""),
    fullName: item.full_name ? String(item.full_name) : undefined,
    url: String(item.html_url ?? ""),
    ...(item.description ? { description: String(item.description) } : {}),
    ...(typeof item.stargazers_count === "number" ? { stars: item.stargazers_count } : {}),
    ...(item.pushed_at ? { updatedAt: String(item.pushed_at) } : {}),
    ...(item.license?.spdx_id && item.license.spdx_id !== "NOASSERTION"
      ? { license: String(item.license.spdx_id) }
      : {}),
    ...(Array.isArray(item.topics) ? { topics: item.topics.map(String) } : {}),
  })
  return {
    async search(query: string, limit = 10): Promise<RemoteRepo[]> {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 50)}&sort=stars`
      const data = await getJson<{ items?: unknown[] }>(url, options, headers)
      return (data.items ?? []).map(map)
    },
    async repo(fullName: string): Promise<RemoteRepo> {
      return map(await getJson(`https://api.github.com/repos/${fullName}`, options, headers))
    },
  }
}

export function gitlabApi(options: ApiOptions = {}) {
  const env = options.env ?? process.env
  const token = env.GITLAB_TOKEN
  const headers: Record<string, string> = { ...(token ? { "private-token": token } : {}) }
  const map = (item: any): RemoteRepo => ({
    id: String(item.path_with_namespace ?? item.id ?? ""),
    name: String(item.name ?? item.path ?? ""),
    fullName: item.path_with_namespace ? String(item.path_with_namespace) : undefined,
    url: String(item.web_url ?? ""),
    ...(item.description ? { description: String(item.description) } : {}),
    ...(typeof item.star_count === "number" ? { stars: item.star_count } : {}),
    ...(item.last_activity_at ? { updatedAt: String(item.last_activity_at) } : {}),
    ...(item.license?.spdx_identifier ? { license: String(item.license.spdx_identifier) } : {}),
    ...(Array.isArray(item.topics) ? { topics: item.topics.map(String) } : {}),
  })
  return {
    async search(query: string, limit = 10): Promise<RemoteRepo[]> {
      const base = env.GITLAB_HOST ?? "https://gitlab.com"
      const url = `${base}/api/v4/projects?search=${encodeURIComponent(query)}&per_page=${Math.min(limit, 50)}&order_by=star_count&sort=desc`
      const data = await getJson<unknown[]>(url, options, headers)
      return (Array.isArray(data) ? data : []).map(map)
    },
  }
}

/**
 * Shallow, quiet clone into `dir` (removed first). Throws with the git error.
 * Only network transports are allowed (local paths with `allowFile`), never
 * `ext::` or other helpers; LFS smudging and submodules stay off, so cloning
 * fetches bytes and runs nothing from the repository.
 */
export async function shallowClone(
  url: string,
  dir: string,
  options: { signal?: AbortSignal; timeoutMs?: number; allowFile?: boolean } = {},
): Promise<string> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(path.dirname(dir), { recursive: true })
  const result = await run(["git", "clone", "--depth", "1", "--quiet", "--no-recurse-submodules", "--", url, dir], {
    cwd: path.dirname(dir),
    timeoutMs: options.timeoutMs ?? 300_000,
    ...(options.signal ? { signal: options.signal } : {}),
    passEnv: ["HOME", "GIT_SSH_COMMAND"],
    env: {
      GIT_ALLOW_PROTOCOL: options.allowFile ? "https:http:ssh:git:file" : "https:http:ssh:git",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
    },
  })
  if (result.code !== 0)
    throw new Error(`git clone ${url} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  return dir
}

export type RegistryId = "npm" | "pypi" | "crates"

export interface RegistryPackage {
  readonly registry: RegistryId
  readonly name: string
  readonly version?: string
  readonly license?: string
  readonly description?: string
  readonly homepage?: string
}

const CLASSIFIER: Readonly<Record<string, string>> = {
  "mit license": "MIT",
  "apache software license": "Apache-2.0",
  "bsd license": "BSD-3-Clause",
  "isc license": "ISC",
  "mozilla public license 2.0": "MPL-2.0",
  "gnu general public license v3 (gplv3)": "GPL-3.0",
  "gnu affero general public license v3": "AGPL-3.0",
}

/** Registry metadata for a package. Self-reported license fields only. */
export async function registryMetadata(
  registry: RegistryId,
  name: string,
  options: ApiOptions = {},
): Promise<RegistryPackage> {
  if (registry === "npm") {
    const data = await getJson<any>(`https://registry.npmjs.org/${encodeURIComponent(name)}`, options, {})
    const latest = data["dist-tags"]?.latest as string | undefined
    const version = latest ? data.versions?.[latest] : undefined
    const license = typeof version?.license === "string" ? version.license : version?.license?.type
    return {
      registry,
      name,
      ...(latest ? { version: latest } : {}),
      ...(license ? { license: String(license) } : {}),
      ...(data.description ? { description: String(data.description) } : {}),
      ...(data.homepage ? { homepage: String(data.homepage) } : {}),
    }
  }
  if (registry === "pypi") {
    const data = await getJson<any>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, options, {})
    const info = data.info ?? {}
    const classifiers: string[] = Array.isArray(info.classifiers) ? info.classifiers : []
    const fromClassifier = classifiers
      .map((item) => /^License :: OSI Approved :: (.+)$/.exec(item)?.[1]?.trim().toLowerCase())
      .map((item) => (item ? CLASSIFIER[item] : undefined))
      .find(Boolean)
    const declared = typeof info.license === "string" && info.license.length < 120 ? info.license.trim() : undefined
    return {
      registry,
      name: info.name ? String(info.name) : name,
      ...(info.version ? { version: String(info.version) } : {}),
      ...(fromClassifier || declared ? { license: fromClassifier ?? declared } : {}),
      ...(info.summary ? { description: String(info.summary) } : {}),
      ...(info.home_page ? { homepage: String(info.home_page) } : {}),
    }
  }
  const data = await getJson<any>(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, options, {})
  const crate = data.crate ?? {}
  return {
    registry,
    name: crate.name ? String(crate.name) : name,
    ...(crate.max_version ? { version: String(crate.max_version) } : {}),
    ...(crate.license ? { license: String(crate.license) } : {}),
    ...(crate.description ? { description: String(crate.description) } : {}),
    ...(crate.homepage ? { homepage: String(crate.homepage) } : {}),
  }
}
