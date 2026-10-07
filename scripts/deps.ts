// The plan's minimal-dependency rule, enforced on this repository: core's
// runtime dependencies must stay within the allowlist, and anything else needs
// a recorded justification in .factory/dependencies.json. Run by `bun run check`
// in CI (AGENTS.md: the allowlist is "enforced by our own gate").
import { readFile } from "node:fs/promises"
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
console.log(
  `deps: ok (${Object.keys(dependencies).length} core runtime dependencies; all allowlisted or justified)`,
)
