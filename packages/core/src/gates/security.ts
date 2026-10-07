// External security scanners: gitleaks (secrets) and OSV (known-vulnerable
// dependencies). Used when installed; OSV falls back to its public API.
// A dependency change that cannot be checked is UNVERIFIED and fails closed.
import { accessSync, constants } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { GateFinding } from "../schema/gates.ts"
import { parseJsonc } from "../util/jsonc.ts"
import { run } from "../util/proc.ts"

const which = new Map<string, boolean>()

/** Is `binary` an executable on PATH? Pure lookup (no shell), so no injection. */
export function installed(binary: string): boolean {
  if (!which.has(binary)) which.set(binary, onPath(binary))
  return which.get(binary)!
}

function onPath(binary: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    try {
      accessSync(path.join(dir, binary), constants.X_OK)
      return true
    } catch {
      // not executable here; keep looking
    }
  }
  return false
}

export async function gitleaks(dir: string, files: readonly string[]): Promise<GateFinding[] | undefined> {
  if (!installed("gitleaks") || files.length === 0) return undefined
  const findings: GateFinding[] = []
  for (const file of files) {
    const result = await run(
      [
        "gitleaks",
        "dir",
        file,
        "--no-banner",
        "--redact",
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--exit-code",
        "0",
      ],
      { cwd: dir, timeoutMs: 60_000 },
    )
    const start = result.stdout.indexOf("[")
    if (start < 0) continue
    try {
      for (const item of JSON.parse(result.stdout.slice(start)) as any[])
        findings.push({
          file: path
            .relative(dir, path.resolve(dir, item.File ?? file))
            .split(path.sep)
            .join("/"),
          line: item.StartLine,
          rule: `security/gitleaks-${item.RuleID ?? "secret"}`,
          severity: "error",
          message: `gitleaks: ${item.Description ?? "secret detected"}`,
          fixHint: "Remove the secret and rotate it.",
          check: "gitleaks",
        })
    } catch {
      // unparseable report: built-in scanner still ran
    }
  }
  return findings
}

// ----------------------------------------------------------------- OSV

export interface Dependency {
  readonly ecosystem: "npm" | "PyPI" | "crates.io" | "Go"
  readonly name: string
  readonly version: string
}

const LOCKFILES = ["package-lock.json", "bun.lock", "requirements.txt", "Cargo.lock", "go.sum"]
export const DEPENDENCY_FILES = new Set([
  ...LOCKFILES,
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "bun.lockb",
])

export async function lockfileDependencies(dir: string): Promise<Dependency[]> {
  const out: Dependency[] = []
  const read = (name: string) => readFile(path.join(dir, name), "utf8").catch(() => undefined)
  const npmLock = await read("package-lock.json")
  if (npmLock) {
    const lock = JSON.parse(npmLock)
    for (const [key, value] of Object.entries<any>(lock.packages ?? {}))
      if (key.startsWith("node_modules/") && value?.version)
        out.push({ ecosystem: "npm", name: key.slice(key.lastIndexOf("node_modules/") + 13), version: value.version })
  }
  const bunLock = await read("bun.lock")
  if (bunLock) {
    const lock = parseJsonc<{ packages?: Record<string, unknown[]> }>(bunLock)
    for (const value of Object.values(lock.packages ?? {})) {
      const spec = typeof value?.[0] === "string" ? (value[0] as string) : undefined
      const at = spec?.lastIndexOf("@") ?? -1
      if (spec && at > 0 && !spec.includes("workspace:"))
        out.push({ ecosystem: "npm", name: spec.slice(0, at), version: spec.slice(at + 1) })
    }
  }
  const requirements = await read("requirements.txt")
  for (const match of requirements?.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*==\s*([\w.+-]+)/gm) ?? [])
    out.push({ ecosystem: "PyPI", name: match[1]!, version: match[2]! })
  const cargo = await read("Cargo.lock")
  for (const match of cargo?.matchAll(/\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g) ?? [])
    out.push({ ecosystem: "crates.io", name: match[1]!, version: match[2]! })
  const goSum = await read("go.sum")
  for (const match of goSum?.matchAll(/^(\S+) v([^\s/]+?)(?:\/go\.mod)? h1:/gm) ?? [])
    out.push({ ecosystem: "Go", name: match[1]!, version: match[2]! })
  const seen = new Set<string>()
  return out.filter((dep) => {
    const key = `${dep.ecosystem}:${dep.name}@${dep.version}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface OsvOptions {
  readonly mode: "auto" | "api"
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
}

/** Vulnerability findings; an "UNVERIFIED" error finding when OSV could not be consulted. */
export async function osvFindings(dir: string, options: OsvOptions): Promise<GateFinding[]> {
  if (options.mode === "auto" && installed("osv-scanner")) {
    const result = await run(["osv-scanner", "scan", "source", "--format", "json", "-r", "."], {
      cwd: dir,
      timeoutMs: 180_000,
    })
    try {
      const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")))
      const findings: GateFinding[] = []
      for (const item of report.results ?? [])
        for (const pkg of item.packages ?? [])
          for (const vuln of pkg.vulnerabilities ?? [])
            findings.push({
              file:
                path
                  .relative(dir, item.source?.path ?? ".")
                  .split(path.sep)
                  .join("/") || ".",
              rule: `security/vuln-${vuln.id}`,
              severity: "error",
              message: `${pkg.package?.name}@${pkg.package?.version}: ${vuln.summary ?? vuln.id}`,
              fixHint: "Upgrade to a fixed version or waive with a reason.",
              check: "osv",
            })
      return findings
    } catch {
      // fall through to the API
    }
  }
  const deps = await lockfileDependencies(dir)
  if (deps.length === 0) return []
  const doFetch = options.fetch ?? fetch
  const findings: GateFinding[] = []
  try {
    for (let i = 0; i < deps.length; i += 500) {
      const batch = deps.slice(i, i + 500)
      const response = await doFetch("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queries: batch.map((dep) => ({
            package: { name: dep.name, ecosystem: dep.ecosystem },
            version: dep.version,
          })),
        }),
        signal: options.signal ?? AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`OSV API ${response.status}`)
      const body = (await response.json()) as { results?: Array<{ vulns?: Array<{ id: string }> }> }
      body.results?.forEach((result, index) => {
        const dep = batch[index]!
        for (const vuln of result.vulns ?? [])
          findings.push({
            file: ".",
            rule: `security/vuln-${vuln.id}`,
            severity: "error",
            message: `${dep.ecosystem} ${dep.name}@${dep.version} is affected by ${vuln.id}`,
            fixHint: `See https://osv.dev/vulnerability/${vuln.id}; upgrade or waive with a reason.`,
            check: "osv",
          })
      })
    }
  } catch (error) {
    return [
      {
        file: ".",
        rule: "security/osv-unverified",
        severity: "error",
        message: `Dependencies changed but OSV could not be consulted (${error instanceof Error ? error.message : String(error)}); status UNVERIFIED.`,
        fixHint: "Retry with network access, install osv-scanner, or waive with a reason.",
        check: "osv",
      },
    ]
  }
  return findings
}
