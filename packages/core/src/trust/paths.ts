// Path canonicalisation for policy decisions. Every path an agent names is
// resolved against the project root, normalised (no "..") and passed through
// realpath for its longest existing prefix, so neither "docs/../src" nor a
// symlink into .factory can dodge a rule.
import { realpathSync } from "node:fs"
import path from "node:path"

/** Absolute, normalised, symlink-resolved form of `target` (relative to `base`). */
export function canonicalPath(target: string, base = process.cwd()): string {
  const absolute = path.resolve(base, target)
  const rest: string[] = []
  let prefix = absolute
  for (;;) {
    try {
      const real = realpathSync(prefix)
      return rest.length ? path.join(real, ...rest.reverse()) : real
    } catch {
      const parent = path.dirname(prefix)
      if (parent === prefix) return absolute
      rest.push(path.basename(prefix))
      prefix = parent
    }
  }
}

export interface ResolvedTarget {
  /** Canonical absolute path. */
  readonly absolute: string
  /** POSIX path relative to the canonical root, or undefined when outside it. */
  readonly relative: string | undefined
}

export function resolveTarget(root: string, target: string): ResolvedTarget {
  const canonicalRoot = canonicalPath(root)
  const absolute = canonicalPath(target, canonicalRoot)
  return { absolute, relative: relativeTo(canonicalRoot, absolute) }
}

/** POSIX relative path of `absolute` under `root`, "." for the root itself, undefined outside. */
export function relativeTo(root: string, absolute: string): string | undefined {
  const relative = path.relative(root, absolute)
  if (relative === "") return "."
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join("/")
}

export function isInside(root: string, absolute: string): boolean {
  return relativeTo(root, absolute) !== undefined
}
