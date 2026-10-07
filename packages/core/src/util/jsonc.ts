// JSONC: JSON with // and /* */ comments and trailing commas (opencode.jsonc,
// tsconfig.json). Two string-aware passes, then JSON.parse.

function scan(text: string, onOutside: (text: string, i: number, out: string[]) => number): string {
  const out: string[] = []
  let i = 0
  let inString = false
  while (i < text.length) {
    const char = text[i]!
    if (inString) {
      out.push(char)
      if (char === "\\") {
        out.push(text[i + 1] ?? "")
        i += 2
        continue
      }
      if (char === '"') inString = false
      i++
      continue
    }
    if (char === '"') {
      inString = true
      out.push(char)
      i++
      continue
    }
    i = onOutside(text, i, out)
  }
  return out.join("")
}

const stripComments = (text: string) =>
  scan(text, (source, i, out) => {
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++
      return i
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++
      return i + 2
    }
    out.push(source[i]!)
    return i + 1
  })

const stripTrailingCommas = (text: string) =>
  scan(text, (source, i, out) => {
    if (source[i] === ",") {
      let j = i + 1
      while (j < source.length && /\s/.test(source[j]!)) j++
      if (source[j] === "}" || source[j] === "]") return i + 1
    }
    out.push(source[i]!)
    return i + 1
  })

export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text))
}

export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T
}
