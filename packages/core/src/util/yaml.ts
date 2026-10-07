// A deliberately small YAML subset for frontmatter we author and validate
// ourselves (GOAL.md, prompts, SKILL.md). Supported: block maps by
// indentation, block lists ("- "), inline lists/maps of scalars, quoted and
// plain scalars, numbers, booleans, null, and "|"/">" block scalars.
// Anything else is a parse error, never a silent guess.

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`YAML line ${line}: ${message}`)
  }
}

type Line = { readonly indent: number; readonly text: string; readonly number: number }

export function parseYaml(source: string): unknown {
  const lines: Line[] = []
  source.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*(#.*)?$/.test(raw)) {
      lines.push({ indent: -1, text: "", number: index + 1 })
      return
    }
    if (/^\t/.test(raw)) throw new YamlError("tabs are not allowed for indentation", index + 1)
    const indent = raw.length - raw.trimStart().length
    lines.push({ indent, text: raw.trimEnd().slice(indent), number: index + 1 })
  })
  const state = { i: 0 }
  skipBlank(lines, state)
  if (state.i >= lines.length) return {}
  const value = parseBlock(lines, state, lines[state.i]!.indent)
  skipBlank(lines, state)
  if (state.i < lines.length) throw new YamlError("unexpected content", lines[state.i]!.number)
  return value
}

function skipBlank(lines: Line[], state: { i: number }) {
  while (state.i < lines.length && lines[state.i]!.indent === -1) state.i++
}

function parseBlock(lines: Line[], state: { i: number }, indent: number): unknown {
  const first = lines[state.i]!
  if (first.text.startsWith("- ") || first.text === "-") return parseList(lines, state, indent)
  return parseMap(lines, state, indent)
}

function parseList(lines: Line[], state: { i: number }, indent: number): unknown[] {
  const out: unknown[] = []
  for (;;) {
    skipBlank(lines, state)
    const line = lines[state.i]
    if (!line || line.indent < indent) return out
    if (line.indent > indent) throw new YamlError("bad indentation in list", line.number)
    if (!(line.text.startsWith("- ") || line.text === "-")) return out
    const rest = line.text === "-" ? "" : line.text.slice(2).trim()
    if (rest === "") {
      state.i++
      skipBlank(lines, state)
      const child = lines[state.i]
      if (!child || child.indent <= indent) out.push(null)
      else out.push(parseBlock(lines, state, child.indent))
      continue
    }
    if (/^[^"'[{][^:]*:(\s|$)/.test(rest) || /^["'][^"']*["']\s*:(\s|$)/.test(rest)) {
      // "- key: value" starts an inline map whose further keys align with "key".
      const virtualIndent = indent + 2
      const synthetic: Line = { indent: virtualIndent, text: rest, number: line.number }
      lines[state.i] = synthetic
      out.push(parseMap(lines, state, virtualIndent))
      continue
    }
    state.i++
    out.push(parseScalarOrBlock(rest, lines, state, indent, line.number))
  }
}

function parseMap(lines: Line[], state: { i: number }, indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (;;) {
    skipBlank(lines, state)
    const line = lines[state.i]
    if (!line || line.indent < indent) return out
    if (line.indent > indent) throw new YamlError("bad indentation in map", line.number)
    if (line.text.startsWith("- ")) return out
    const split = splitKey(line.text)
    if (!split) throw new YamlError(`expected "key: value", got "${line.text}"`, line.number)
    const key = unquote(split.key.trim())
    if (key in out) throw new YamlError(`duplicate key "${key}"`, line.number)
    const rest = split.rest.trim()
    state.i++
    if (rest === "") {
      skipBlank(lines, state)
      const child = lines[state.i]
      if (child && (child.indent > indent || (child.indent === indent && child.text.startsWith("- "))))
        out[key] = parseBlock(lines, state, child.indent)
      else out[key] = null
      continue
    }
    out[key] = parseScalarOrBlock(rest, lines, state, indent, line.number)
  }
}

function parseScalarOrBlock(
  rest: string,
  lines: Line[],
  state: { i: number },
  indent: number,
  number: number,
): unknown {
  if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
    const collected: string[] = []
    let blockIndent = -1
    while (state.i < lines.length) {
      const line = lines[state.i]!
      if (line.indent !== -1 && line.indent <= indent) break
      if (line.indent === -1) collected.push("")
      else {
        if (blockIndent === -1) blockIndent = line.indent
        collected.push(" ".repeat(Math.max(0, line.indent - blockIndent)) + line.text)
      }
      state.i++
    }
    while (collected.length && collected.at(-1) === "") collected.pop()
    const body = rest.startsWith("|") ? collected.join("\n") : collected.join(" ").replace(/\s+/g, " ").trim()
    return rest.endsWith("-") ? body : `${body}\n`
  }
  return parseInline(rest, number)
}

/**
 * `key: value` → { key, rest }. The key is "double-quoted" (with escapes),
 * 'single-quoted', or bare (no ":" or "#"); a quoted key that is not followed
 * by ":" is read as a bare key. After ":" comes the end of the line or
 * whitespace and the value.
 */
function splitKey(text: string): { key: string; rest: string } | undefined {
  const afterKey = (end: number) => {
    const after = text.slice(end).trimStart()
    if (!after.startsWith(":")) return undefined
    const rest = after.slice(1)
    if (rest !== "" && !/^\s/.test(rest)) return undefined
    return { key: text.slice(0, end), rest }
  }
  let quoted: { key: string; rest: string } | undefined
  if (text.startsWith('"')) {
    let i = 1
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1
    if (i < text.length) quoted = afterKey(i + 1)
  } else if (text.startsWith("'")) {
    const close = text.indexOf("'", 1)
    if (close > 0) quoted = afterKey(close + 1)
  }
  if (quoted) return quoted
  const colon = text.indexOf(":")
  if (colon <= 0 || text.slice(0, colon).includes("#")) return undefined
  return afterKey(colon)
}

function parseInline(text: string, number: number): unknown {
  // A comment starts at whitespace followed by "#".
  const hash = text.search(/\s#/)
  const value = (hash < 0 ? text : text.slice(0, hash)).trim()
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new YamlError("unterminated inline list", number)
    const inner = value.slice(1, -1).trim()
    return inner === "" ? [] : splitInline(inner).map((item) => parseInline(item, number))
  }
  if (value.startsWith("{")) {
    if (!value.endsWith("}")) throw new YamlError("unterminated inline map", number)
    const inner = value.slice(1, -1).trim()
    const out: Record<string, unknown> = {}
    if (inner === "") return out
    for (const pair of splitInline(inner)) {
      const index = pair.indexOf(":")
      if (index === -1) throw new YamlError(`bad inline map entry "${pair}"`, number)
      out[unquote(pair.slice(0, index).trim())] = parseInline(pair.slice(index + 1).trim(), number)
    }
    return out
  }
  return scalar(value)
}

function splitInline(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | undefined
  let current = ""
  for (const char of text) {
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    if (char === "[" || char === "{") depth++
    if (char === "]" || char === "}") depth--
    if (char === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function unquote(text: string): string {
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text) as string
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'")
  return text
}

function scalar(text: string): unknown {
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text)
  if (text === "null" || text === "~" || text === "") return null
  if (text === "true") return true
  if (text === "false") return false
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text)
  return text
}

// ---------------------------------------------------------------- emit

const plainSafe = /^[A-Za-z_./@][\w ./@()+-]*$/

function emitScalar(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  const text = String(value)
  if (
    plainSafe.test(text) &&
    !["true", "false", "null", "~"].includes(text) &&
    !/:\s|\s#/.test(text) &&
    text.trim() === text
  )
    return text
  return JSON.stringify(text)
}

export function stringifyYaml(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`
    return value
      .map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length > 0) {
          const nested = stringifyYaml(item, indent + 2)
          return `${pad}- ${nested.slice(indent + 2)}`
        }
        if (Array.isArray(item)) return `${pad}-\n${stringifyYaml(item, indent + 2)}`
        return `${pad}- ${emitScalar(item)}\n`
      })
      .join("")
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => {
        const name = /^[\w.-]+$/.test(key) ? key : JSON.stringify(key)
        if (Array.isArray(item))
          return item.length === 0 ? `${pad}${name}: []\n` : `${pad}${name}:\n${stringifyYaml(item, indent + 2)}`
        if (item && typeof item === "object")
          return Object.keys(item).length === 0
            ? `${pad}${name}: {}\n`
            : `${pad}${name}:\n${stringifyYaml(item, indent + 2)}`
        if (typeof item === "string" && item.includes("\n")) {
          const body = item.replace(/\n$/, "")
          return `${pad}${name}: |${item.endsWith("\n") ? "" : "-"}\n${body
            .split("\n")
            .map((line) => (line ? `${pad}  ${line}` : ""))
            .join("\n")}\n`
        }
        return `${pad}${name}: ${emitScalar(item)}\n`
      })
      .join("")
  }
  return `${pad}${emitScalar(value)}\n`
}

// ---------------------------------------------------------------- frontmatter

export interface Frontmatter<T = unknown> {
  readonly data: T
  readonly body: string
}

/** Split "---\n<yaml>\n---\n<body>". A document without frontmatter yields {} data. */
export function parseFrontmatter(source: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source)
  if (!match) return { data: {}, body: source }
  return { data: parseYaml(match[1]!), body: match[2]! }
}

export function stringifyFrontmatter(data: unknown, body: string): string {
  return `---\n${stringifyYaml(data)}---\n${body.startsWith("\n") ? body.slice(1) : body}`
}
