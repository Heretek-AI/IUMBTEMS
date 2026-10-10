// One source of truth for the workspace and release package lists (#102).
// Shell scripts and workflows call the CLI (`bun scripts/packages.ts
// [--release] [--tsconfig] [--browser] [--no-browser]`); deps.ts imports the
// functions. Reads packages/*/package.json: release order comes from each
// manifest's `esRelease.order` (a public package without one is a bug, so
// `releasePackages` throws), and the `bun --conditions=browser` test split
// comes from each manifest's `esTest.conditions` (private packages never
// release).
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

export interface WorkspacePackage {
  /** Directory under packages/ (also the short name scripts use). */
  readonly dir: string
  readonly name: string
  readonly private: boolean
  /** Publish order for release packages; undefined when not released. */
  readonly order: number | undefined
  /** Bun test conditions (e.g. `browser` for the client Solid build). */
  readonly conditions: readonly string[]
  readonly hasTsconfig: boolean
}

const rootOf = (root?: string) => root ?? path.resolve(import.meta.dir, "..")

export async function workspacePackages(root?: string): Promise<WorkspacePackage[]> {
  const base = path.join(rootOf(root), "packages")
  const entries = await readdir(base, { withFileTypes: true })
  const found: WorkspacePackage[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifest = await readFile(path.join(base, entry.name, "package.json"), "utf8")
      .then((text) => JSON.parse(text) as Record<string, unknown>)
      .catch(() => undefined)
    if (!manifest || typeof manifest.name !== "string") continue
    const esRelease = manifest.esRelease as { order?: unknown } | undefined
    const order = typeof esRelease?.order === "number" ? esRelease.order : undefined
    const esTest = manifest.esTest as { conditions?: unknown } | undefined
    const conditions = Array.isArray(esTest?.conditions)
      ? esTest.conditions.filter((entry): entry is string => typeof entry === "string")
      : []
    const hasTsconfig = await readFile(path.join(base, entry.name, "tsconfig.json"), "utf8")
      .then(() => true)
      .catch(() => false)
    found.push({
      dir: entry.name,
      name: manifest.name,
      private: manifest.private === true,
      order,
      conditions,
      hasTsconfig,
    })
  }
  return found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}

/** Published packages in publish order: private unset, esRelease.order set. */
export async function releasePackages(root?: string): Promise<WorkspacePackage[]> {
  const all = await workspacePackages(root)
  // A public package without an order would silently drop out of the release:
  // fail loudly instead, so it declares `esRelease.order` or goes private.
  for (const pkg of all)
    if (!pkg.private && pkg.order === undefined)
      throw new Error(
        `packages/${pkg.dir} (${pkg.name}) is public but has no esRelease.order: declare its publish order or mark it "private": true`,
      )
  const ordered = all.filter(
    (pkg): pkg is WorkspacePackage & { order: number } => !pkg.private && pkg.order !== undefined,
  )
  return ordered.sort((a, b) => a.order - b.order || (a.dir < b.dir ? -1 : 1))
}

/** Tarball slug for a package name: @heretek-ai/es-core → heretek-ai-es-core. */
export const tarballSlug = (name: string) => name.replace(/^@/, "").replace(/\//g, "-")

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = rootOf()
  if (args.includes("--release"))
    for (const pkg of await releasePackages(root)) console.log(`${pkg.dir} ${tarballSlug(pkg.name)}`)
  else {
    const all = await workspacePackages(root)
    // The `bun --conditions=browser` test split: `--browser` lists only the
    // packages whose manifest declares that condition, `--no-browser` the rest.
    const conditioned = args.includes("--browser")
      ? all.filter((pkg) => pkg.conditions.includes("browser"))
      : args.includes("--no-browser")
        ? all.filter((pkg) => !pkg.conditions.includes("browser"))
        : all
    const list = args.includes("--tsconfig") ? conditioned.filter((pkg) => pkg.hasTsconfig) : conditioned
    for (const pkg of list) console.log(pkg.dir)
  }
}
