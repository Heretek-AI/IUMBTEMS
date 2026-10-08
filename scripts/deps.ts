// The plan's minimal-dependency rule, enforced on this repository: core's
// runtime dependencies must stay within the allowlist, and anything else needs
// a recorded justification in .factory/dependencies.json. Run by `bun run check`
// in CI (AGENTS.md: the allowlist is "enforced by our own gate"). It also holds
// the package boundaries from docs/adr/0001-monorepo.md.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { CORE_DEPENDENCY_ALLOWLIST, checkDependencies } from "../packages/core/src/gates/minimal-deps.ts"

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
const BOUNDARIES = [
  { pkg: "core", banned: ["cli", "opencode"] },
  { pkg: "cli", banned: ["opencode"] },
] as const
const NPM_NAME: Record<string, string> = { cli: "@heretek-ai/es-cli", opencode: "@heretek-ai/epistemic-swarm" }
const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g

const crossings: string[] = []
for (const { pkg, banned } of BOUNDARIES) {
  const src = path.join(root, "packages", pkg, "src")
  const files = (await readdir(src, { recursive: true })).filter((file) => /\.tsx?$/.test(file))
  for (const file of files) {
    const absolute = path.join(src, file)
    for (const [, specifier] of (await readFile(absolute, "utf8")).matchAll(SPECIFIER)) {
      const target = specifier!.startsWith(".") ? path.resolve(path.dirname(absolute), specifier!) : undefined
      const hit = banned.find((other) =>
        target
          ? target.startsWith(path.join(root, "packages", other) + path.sep)
          : specifier === NPM_NAME[other] || specifier!.startsWith(`${NPM_NAME[other]}/`),
      )
      if (hit) crossings.push(`packages/${pkg}/src/${file} imports ${specifier} (${hit})`)
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
