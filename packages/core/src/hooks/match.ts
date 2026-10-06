// Claude Code matcher semantics and the `if` permission-rule filter.
//
// Matcher: "*", "" or omitted matches everything; a value of only letters,
// digits, "_", "-", spaces, "," and "|" is an exact-match list; anything else
// is an unanchored JavaScript regular expression. For tool events we test the
// canonical (Claude) tool name and the host-native name, so matchers written
// for either harness work.
import path from "node:path"
import { matchGlob } from "../util/glob.ts"

const EXACT = /^[A-Za-z0-9_\- ,|]+$/

export function matcherMatches(matcher: string | undefined, values: readonly string[]): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true
  if (EXACT.test(matcher)) {
    const options = matcher
      .split(/[|,]/)
      .map((item) => item.trim())
      .filter(Boolean)
    return values.some((value) => options.includes(value))
  }
  let regex: RegExp
  try {
    regex = new RegExp(matcher)
  } catch {
    return false
  }
  return values.some((value) => regex.test(value))
}

/** Split a shell command into subcommands, including those inside $() and backticks; strip leading VAR=value. */
export function subcommands(command: string): { parts: string[]; opaque: boolean } {
  const parts: string[] = []
  const inner: string[] = []
  const opaque = /\$\(|`|\$[A-Za-z_{]/.test(command)
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) inner.push(match[1] ?? match[2] ?? "")
  for (const text of [command, ...inner])
    for (const piece of text.split(/\|\||&&|[;|\n&]/)) {
      const cleaned = piece
        .replace(/\$\([^()]*\)|`[^`]*`/g, " ")
        .trim()
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
      if (cleaned) parts.push(cleaned)
    }
  return { parts, opaque }
}

/** Claude permission-rule wildcards: "*" matches any run of characters (including "/" and spaces). */
function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")
  // "git *" also matches bare "git"
  const regex = new RegExp(`^${escaped}$`)
  return regex.test(value) || (pattern.endsWith(" *") && value === pattern.slice(0, -2))
}

export interface IfContext {
  /** Canonical tool name (Claude) and host name. */
  readonly toolNames: readonly string[]
  /** Canonical (Claude-shaped) tool input. */
  readonly toolInput: Record<string, unknown>
  readonly cwd: string
}

/**
 * Evaluate an `if` rule such as "Bash(git *)" or "Edit(src/**)". Like Claude
 * Code, when the shell command is opaque ($(), backticks, $VAR) and the
 * pattern names more than the command, the hook runs anyway (best effort).
 */
export function ifMatches(rule: string, context: IfContext): boolean {
  const match = /^([\w.-]+)(?:\((.*)\))?$/s.exec(rule.trim())
  if (!match) return false
  const [, tool, pattern] = match
  if (!context.toolNames.includes(tool!)) return false
  if (pattern === undefined || pattern === "" || pattern === "*") return true
  const command = context.toolInput.command
  if (typeof command === "string") {
    const { parts, opaque } = subcommands(command)
    if (parts.some((part) => wildcard(pattern, part))) return true
    // Patterns naming more than the command (two or more literal words) run on opaque commands.
    return (
      opaque &&
      pattern
        .trim()
        .split(/\s+/)
        .filter((word) => word !== "*").length > 1
    )
  }
  const file = context.toolInput.file_path ?? context.toolInput.path
  if (typeof file === "string") {
    const relative = path.isAbsolute(file) ? path.relative(context.cwd, file) : file
    const posix = relative.split(path.sep).join("/")
    if (pattern.startsWith("/") || pattern.startsWith("~")) return matchGlob(file, pattern)
    return matchGlob(posix, pattern)
  }
  const url = context.toolInput.url
  if (typeof url === "string") return wildcard(pattern.replace(/^domain:/, "*"), url)
  return wildcard(pattern, JSON.stringify(context.toolInput))
}
