// Portable glob matching (Node >=22 and Bun) with gitignore-like semantics:
// `**` crosses directories, `*` and `?` stay within a segment, `{a,b}` and
// `[...]` are supported. Paths are compared in POSIX form.

const cache = new Map<string, RegExp>()

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob)
  if (cached) return cached
  let out = "^"
  let i = 0
  let braceDepth = 0
  while (i < glob.length) {
    const char = glob[i]!
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/"
        const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === "/"
        if (atSegmentStart && atSegmentEnd) {
          // "**/" matches zero or more directories; trailing "**" matches everything below.
          if (glob[i + 2] === "/") {
            out += "(?:[^/]*(?:/|$))*"
            i += 3
          } else {
            out += ".*"
            i += 2
          }
          continue
        }
        out += "[^/]*"
        i += 2
        continue
      }
      out += "[^/]*"
    } else if (char === "?") out += "[^/]"
    else if (char === "{") {
      braceDepth++
      out += "(?:"
    } else if (char === "}" && braceDepth > 0) {
      braceDepth--
      out += ")"
    } else if (char === "," && braceDepth > 0) out += "|"
    else if (char === "[") {
      const close = glob.indexOf("]", i + 1)
      if (close === -1) out += "\\["
      else {
        let body = glob.slice(i + 1, close)
        if (body.startsWith("!")) body = `^${body.slice(1)}`
        out += `[${body.replace(/\\/g, "\\\\")}]`
        i = close
      }
    } else out += /[.+^$()|\\]/.test(char) ? `\\${char}` : char
    i++
  }
  const regex = new RegExp(`${out}$`)
  cache.set(glob, regex)
  return regex
}

const toPosix = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "")

export function matchGlob(file: string, glob: string): boolean {
  return globToRegExp(toPosix(glob)).test(toPosix(file))
}

export function matchAny(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchGlob(file, glob))
}
