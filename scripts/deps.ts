// The plan's minimal-dependency rule, enforced on this repository: core's
// runtime dependencies must stay within the allowlist, and anything else needs
// a recorded justification in .factory/dependencies.json. Run by `bun run check`
// in CI (AGENTS.md: the allowlist is "enforced by our own gate"). It also holds
// the package boundaries from docs/adr/0001-monorepo.md.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { CORE_DEPENDENCY_ALLOWLIST, checkDependencies } from "../packages/core/src/gates/minimal-deps.ts"
import { workspacePackages } from "./packages.ts"

const root = path.resolve(import.meta.dir, "..")
const pkg = JSON.parse(await readFile(path.join(root, "packages/core/package.json"), "utf8")) as {
  dependencies?: Record<string, string>
}
const justifications = await readFile(path.join(root, ".factory/dependencies.json"), "utf8")
  .then((text) => JSON.parse(text) as Record<string, string>)
  .catch(() => ({}) as Record<string, string>)

const dependencies = pkg.dependencies ?? {}
const check = checkDependencies(dependencies, justifications)
if (!check.ok) {
  console.error("Core dependency gate failed:")
  for (const violation of check.violations) console.error(`  - ${violation.name}: ${violation.reason}`)
  console.error(`Allowlist: ${CORE_DEPENDENCY_ALLOWLIST.join(", ")}`)
  console.error("Add the dependency to .factory/dependencies.json with a reason, or remove it.")
  process.exit(1)
}

// Package boundaries (docs/adr/0001-monorepo.md): core stays harness-neutral,
// so it may not import the CLI or the plugin, and the CLI may not import the
// plugin. Both bare specifiers and relative paths into another package count.
// Every workspace package needs an entry: a new surface fails the gate until
// it declares which packages it may not import, and core and cli may never
// import a new surface (their entries must ban it).
const BOUNDARIES = [
  { pkg: "core", banned: ["cli", "opencode", "testkit", "fleet", "web"] },
  { pkg: "cli", banned: ["opencode", "testkit", "fleet", "web"] },
  // The plugin never imports the fleet daemon or the web UI (AGENTS.md: core,
  // CLI and plugin never import fleet; nothing imports web).
  { pkg: "opencode", banned: ["fleet", "web"] },
  // The test harness never imports the fleet daemon or the web UI either.
  { pkg: "testkit", banned: ["fleet", "web"] },
  // Fleet depends on core only (#122): never on the CLI or the plugin.
  // It serves the built web UI as static files (#129), never as an import.
  { pkg: "fleet", banned: ["cli", "opencode", "web"] },
  // Web is a leaf surface (#129): nothing imports it, and it imports
  // nothing at runtime except the fleet API's schema types (type-only).
  // `fleet` stays banned with a type-only exemption below: `import type`
  // (or `export type`, or an all-`type` named import) carries no runtime
  // dependency, so only a value import of fleet from web fails the gate.
  // The test-only exception lives in `test/`, outside this gate's `src/`
  // scan: packages/web/test/bus.contract.test.ts runtime-imports the fleet
  // server harness for the WS contract test.
  { pkg: "web", banned: ["core", "cli", "opencode", "testkit", "fleet"] },
] as const

// One static import/export statement (`from "specifier"`), a dynamic
// `import("specifier")`, or a side-effect `import "specifier"`. The leading
// keyword and clause decide whether a fleet import from web is type-only.
const IMPORT_STMT = /(import|export)\s+([^;]*?)\s*from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g

/** A fleet import from web with no runtime dependency: `import type` (or
 * `export type`), or a named import where every member is `type`-prefixed. */
function isTypeOnlyClause(keyword: string, clause: string): boolean {
  const head = clause.trim()
  if (/^type\b/.test(head)) return true
  if (keyword !== "import") return false
  const named = /^\{([^}]*)\}/.exec(head)
  if (!named) return false
  const members = named[1]!
    .split(",")
    .map((member) => member.trim())
    .filter(Boolean)
  return members.length > 0 && members.every((member) => member === "type" || /^type\s/.test(member))
}

const crossings: string[] = []

// The workspace is the universe: a package with no BOUNDARIES entry fails
// until it declares its bans, and core/cli entries must ban every other
// surface, so a new package cannot be silently imported by (or silently
// importable from) the harness-neutral layers. Bare-specifier names come
// from the same list (AGENTS.md one-list rule, #102): no second hand map
// that could miss a surface (a bare `@heretek-ai/es-core` import from web
// used to pass because the old map had no `core` key).
const workspace = await workspacePackages(root)
const NPM_NAME: Record<string, string> = Object.fromEntries(workspace.map((pkg) => [pkg.dir, pkg.name]))
const universe = workspace.map((pkg) => pkg.dir)
for (const pkg of universe)
  if (!BOUNDARIES.some((entry) => entry.pkg === pkg))
    crossings.push(`packages/${pkg} has no BOUNDARIES entry: declare which packages ${pkg} may not import`)
for (const outer of ["core", "cli"] as const) {
  const bans = BOUNDARIES.find((entry) => entry.pkg === outer)?.banned ?? []
  for (const pkg of universe)
    if (pkg !== outer && pkg !== "core" && pkg !== "cli" && !(bans as readonly string[]).includes(pkg))
      crossings.push(`packages/${outer} may import packages/${pkg}: new surfaces stay out of core and the CLI`)
}
for (const { pkg, banned } of BOUNDARIES) {
  const src = path.join(root, "packages", pkg, "src")
  const files = (await readdir(src, { recursive: true })).filter((file) => /\.tsx?$/.test(file))
  for (const file of files) {
    const absolute = path.join(src, file)
    const text = await readFile(absolute, "utf8")
    for (const match of text.matchAll(IMPORT_STMT)) {
      const specifier = match[3] ?? match[4] ?? match[5]!
      const target = specifier.startsWith(".") ? path.resolve(path.dirname(absolute), specifier) : undefined
      const hit = banned.find((other) =>
        target
          ? target.startsWith(path.join(root, "packages", other) + path.sep)
          : specifier === NPM_NAME[other] || specifier.startsWith(`${NPM_NAME[other]}/`),
      )
      if (!hit) continue
      // Web's fleet exemption: a type-only import carries no runtime
      // dependency, so only a value import of fleet from web crosses.
      if (pkg === "web" && hit === "fleet" && match[3] !== undefined && isTypeOnlyClause(match[1]!, match[2]!))
        continue
      crossings.push(`packages/${pkg}/src/${file} imports ${specifier} (${hit})`)
    }
  }
}
if (crossings.length) {
  console.error("Package boundary gate failed (docs/adr/0001-monorepo.md):")
  for (const crossing of crossings) console.error(`  - ${crossing}`)
  console.error("Core may not import the CLI or the plugin; the CLI may not import the plugin.")
  process.exit(1)
}

console.log(
  `deps: ok (${Object.keys(dependencies).length} core runtime dependencies; all allowlisted or justified; package boundaries hold)`,
)
