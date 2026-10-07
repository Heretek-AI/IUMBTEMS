// The minimal runtime-dependency rule for `@heretek-ai/es-core`. The plan fixes
// core's dependency set to zod, web-tree-sitter, vscode-jsonrpc and
// vscode-languageserver-protocol; anything beyond it needs a recorded
// justification, enforced on this repository by `bun run deps:check`.

/** Runtime dependencies core may use without a recorded justification. */
export const CORE_DEPENDENCY_ALLOWLIST = [
  "zod",
  "web-tree-sitter",
  "vscode-jsonrpc",
  "vscode-languageserver-protocol",
] as const

export interface DependencyViolation {
  readonly name: string
  readonly reason: string
}

export interface DependencyCheck {
  readonly ok: boolean
  readonly violations: readonly DependencyViolation[]
}

/**
 * Check a package's runtime dependencies. Anything outside `allowlist` must
 * have a non-blank entry in `justifications` (name → reason), or it is a
 * violation. Pure function of its inputs.
 */
export function checkDependencies(
  dependencies: Record<string, string>,
  justifications: Record<string, string> = {},
  allowlist: readonly string[] = CORE_DEPENDENCY_ALLOWLIST,
): DependencyCheck {
  const violations: DependencyViolation[] = []
  for (const name of Object.keys(dependencies).sort()) {
    if (allowlist.includes(name)) continue
    if ((justifications[name] ?? "").trim().length > 0) continue
    violations.push({ name, reason: "not in the allowlist and has no recorded justification" })
  }
  return { ok: violations.length === 0, violations }
}
