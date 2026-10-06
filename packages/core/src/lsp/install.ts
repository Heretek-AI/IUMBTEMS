// Pinned, checksummed, ask-once installs of language servers. A human
// consents once per server (CLI or TUI); the installer fetches the exact npm
// tarball, verifies its sha512 against the pinned integrity, and installs it
// with scripts disabled into the user-global state dir.
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import path from "node:path"
import { stateDir as defaultStateDir } from "../layout.ts"
import { exists, readJson, withLock, writeJson } from "../util/fs.ts"
import { run } from "../util/proc.ts"
import type { NpmInstall, ServerSpec } from "./registry.ts"

interface ConsentFile {
  version: 1
  servers: Record<string, { allowed: boolean; by: string; at: string }>
}

const consentFile = (dir = defaultStateDir()) => path.join(dir, "lsp-consent.json")
export const installDir = (server: ServerSpec, dir = defaultStateDir()) =>
  path.join(dir, "lsp", `${server.id}-${server.install?.packages.map((item) => item.version).join("-") ?? "local"}`)

export async function consent(id: string, dir?: string): Promise<boolean | undefined> {
  return (await readJson<ConsentFile>(consentFile(dir)))?.servers[id]?.allowed
}

/** Human-only: record the ask-once answer for a server install. */
export async function recordConsent(id: string, allowed: boolean, dir?: string): Promise<void> {
  const file = consentFile(dir)
  await withLock(file, async () => {
    const current = (await readJson<ConsentFile>(file)) ?? { version: 1, servers: {} }
    current.servers[id] = { allowed, by: userInfo().username, at: new Date().toISOString() }
    await writeJson(file, current)
  })
}

export async function installedBin(server: ServerSpec, dir?: string): Promise<string | undefined> {
  if (!server.install) return undefined
  const bin = path.join(installDir(server, dir), "node_modules", ".bin", server.install.bin)
  return (await exists(bin)) ? bin : undefined
}

export const sri = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`

/** Download and verify each pinned tarball, then install them together with scripts disabled. */
export async function installServer(
  server: ServerSpec,
  options: { stateDir?: string; npm?: string } = {},
): Promise<string> {
  const install = server.install as NpmInstall | undefined
  if (!install) throw new Error(`${server.id} has no pinned install; install it yourself and put it on PATH`)
  if ((await consent(server.id, options.stateDir)) !== true)
    throw new Error(`Installing ${server.id} needs a human's consent first (es lsp install ${server.id})`)
  const npm = options.npm ?? "npm"
  const target = installDir(server, options.stateDir)
  const scratch = await mkdtemp(path.join(tmpdir(), "es-lsp-"))
  try {
    const tarballs: string[] = []
    for (const pkg of install.packages) {
      const packed = await run([npm, "pack", `${pkg.name}@${pkg.version}`, "--pack-destination", scratch, "--json"], {
        cwd: scratch,
        timeoutMs: 180_000,
        passEnv: ["npm_config_registry", "NPM_CONFIG_REGISTRY", "HTTPS_PROXY", "HTTP_PROXY"],
      })
      if (packed.code !== 0)
        throw new Error(`npm pack ${pkg.name}@${pkg.version} failed: ${packed.stderr.trim().slice(-300)}`)
      const filename = (JSON.parse(packed.stdout.slice(packed.stdout.indexOf("["))) as Array<{ filename: string }>)[0]!
        .filename
      const file = path.join(scratch, path.basename(filename))
      const actual = sri(await readFile(file))
      if (actual !== pkg.integrity)
        throw new Error(`${pkg.name}@${pkg.version} integrity mismatch: expected ${pkg.integrity}, got ${actual}`)
      tarballs.push(file)
    }
    await mkdir(target, { recursive: true })
    const installed = await run(
      [npm, "install", "--prefix", target, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
      {
        cwd: target,
        timeoutMs: 600_000,
        passEnv: ["npm_config_registry", "NPM_CONFIG_REGISTRY", "HTTPS_PROXY", "HTTP_PROXY"],
      },
    )
    if (installed.code !== 0) throw new Error(`npm install failed: ${installed.stderr.trim().slice(-300)}`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const bin = await installedBin(server, options.stateDir)
  if (!bin) throw new Error(`${server.id} installed but ${install.bin} was not found`)
  return bin
}
