// Rule-evaluation semantics vendored from OpenCode v2 (MIT License,
// Copyright (c) 2025 opencode), pinned at v2 HEAD 2026-10-09:
//   packages/core/src/util/wildcard.ts  → matchWildcard (Wildcard.match)
//   packages/core/src/permission.ts     → evaluatePermission (Permission.evaluate)
// Pure functions only: no Effect, no schemas, no host imports. The probe suite
// (#100) evaluates the COMPILED registry permission rules with the identical
// logic the host applies, so a matrix assertion means what the host enforces.
// Re-pin by re-reading those two files and updating VENDORED_AT.
export const VENDORED_AT = "opencode v2 HEAD 2026-10-09"

export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/** Wildcard.match: `*` spans separators, `?` is one character, backslashes normalize. */
export function matchWildcard(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

/** Permission.evaluate: the LAST matching rule wins; nothing matching asks. */
export function evaluatePermission(action: string, resource: string, rules: readonly PermissionRule[]): PermissionRule {
  return (
    rules.findLast((rule) => matchWildcard(action, rule.action) && matchWildcard(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}
