// Structural extraction: the imports and top-level symbols of a source file.
// Tree-sitter (pinned grammars) when available; a conservative regex scanner
// otherwise, so the import graph still works offline.
import { createHash } from "node:crypto"
import type { Node } from "web-tree-sitter"
import { type GrammarId, type GrammarOptions, grammarFor, parserFor } from "./grammars.ts"

export interface ImportRef {
  /** As written: "./x.js", "a.b", ".m", "example.com/m/pkg". */
  readonly specifier: string
  readonly line: number
  readonly kind: "static" | "type" | "dynamic" | "require" | "reexport" | "side-effect"
  /** Imported names when known (Python `from x import a, b`). */
  readonly names?: readonly string[]
}

export interface SymbolRef {
  readonly name: string
  readonly kind: "function" | "class" | "interface" | "type" | "enum" | "variable" | "method" | "constant"
  readonly line: number
  readonly endLine: number
  readonly exported: boolean
}

export interface FileStructure {
  readonly language: GrammarId
  readonly parser: "tree-sitter" | "regex"
  readonly imports: readonly ImportRef[]
  readonly symbols: readonly SymbolRef[]
  /** Package name (Go). */
  readonly package?: string
  /** The tree had syntax errors (results are best effort). */
  readonly syntaxErrors?: boolean
}

const unquote = (text: string) => text.replace(/^[`'"]|[`'"]$/g, "")
const line = (node: Node) => node.startPosition.row + 1
const endLine = (node: Node) => node.endPosition.row + 1

function jsLike(root: Node): Pick<FileStructure, "imports" | "symbols"> {
  const imports: ImportRef[] = []
  const symbols: SymbolRef[] = []
  for (const node of root.descendantsOfType(["import_statement", "export_statement", "call_expression"])) {
    if (node.type === "import_statement") {
      const source = node.childForFieldName("source")
      if (!source) continue
      const typeOnly = node.child(1)?.type === "type"
      const clause = node.namedChildren.some((child) => child.type === "import_clause")
      imports.push({
        specifier: unquote(source.text),
        line: line(node),
        kind: typeOnly ? "type" : clause ? "static" : "side-effect",
      })
    } else if (node.type === "export_statement") {
      const source = node.childForFieldName("source")
      if (source) imports.push({ specifier: unquote(source.text), line: line(node), kind: "reexport" })
    } else {
      const fn = node.childForFieldName("function")
      const first = node.childForFieldName("arguments")?.namedChildren[0]
      if (!fn || first?.type !== "string") continue
      if (fn.type === "import") imports.push({ specifier: unquote(first.text), line: line(node), kind: "dynamic" })
      else if (fn.type === "identifier" && fn.text === "require")
        imports.push({ specifier: unquote(first.text), line: line(node), kind: "require" })
    }
  }
  const kinds: Record<string, SymbolRef["kind"]> = {
    function_declaration: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    abstract_class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
  }
  const visit = (node: Node, exported: boolean) => {
    const kind = kinds[node.type]
    if (kind) {
      const name = node.childForFieldName("name")
      if (name) symbols.push({ name: name.text, kind, line: line(node), endLine: endLine(node), exported })
      if (kind === "class")
        for (const member of node.childForFieldName("body")?.namedChildren ?? [])
          if (member.type === "method_definition") {
            const method = member.childForFieldName("name")
            if (method)
              symbols.push({
                name: `${name?.text ?? "?"}.${method.text}`,
                kind: "method",
                line: line(member),
                endLine: endLine(member),
                exported,
              })
          }
    } else if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      const constant = node.child(0)?.type === "const"
      for (const declarator of node.namedChildren)
        if (declarator.type === "variable_declarator") {
          const name = declarator.childForFieldName("name")
          const value = declarator.childForFieldName("value")
          if (name?.type !== "identifier") continue
          const fn = value && /function|arrow_function/.test(value.type)
          symbols.push({
            name: name.text,
            kind: fn ? "function" : constant ? "constant" : "variable",
            line: line(declarator),
            endLine: endLine(declarator),
            exported,
          })
        }
    }
  }
  for (const node of root.namedChildren) {
    if (node.type === "export_statement") {
      const declaration = node.childForFieldName("declaration")
      if (declaration) visit(declaration, true)
      else {
        // export { a, b } — mark already-seen local symbols as exported.
        for (const specifier of node.descendantsOfType("export_specifier")) {
          const name = specifier.childForFieldName("name")?.text
          const index = symbols.findIndex((symbol) => symbol.name === name)
          if (index >= 0) symbols[index] = { ...symbols[index]!, exported: true }
        }
      }
    } else visit(node, false)
  }
  return { imports, symbols }
}

function python(root: Node): Pick<FileStructure, "imports" | "symbols"> {
  const imports: ImportRef[] = []
  const symbols: SymbolRef[] = []
  for (const node of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (node.type === "import_statement") {
      for (const name of node.childrenForFieldName("name")) {
        const dotted = name.type === "aliased_import" ? name.childForFieldName("name") : name
        if (dotted) imports.push({ specifier: dotted.text, line: line(node), kind: "static" })
      }
    } else {
      const module = node.childForFieldName("module_name")
      if (!module) continue
      const names = node
        .childrenForFieldName("name")
        .map((name) => (name.type === "aliased_import" ? name.childForFieldName("name") : name)?.text)
        .filter((name): name is string => Boolean(name))
      const wildcard = node.namedChildren.some((child) => child.type === "wildcard_import")
      imports.push({
        specifier: module.text.replace(/\s+/g, ""),
        line: line(node),
        kind: "static",
        names: wildcard ? ["*"] : names,
      })
    }
  }
  const visit = (node: Node, owner?: string) => {
    const target = node.type === "decorated_definition" ? node.childForFieldName("definition") : node
    if (!target) return
    const name = target.childForFieldName("name")?.text
    if (!name) return
    if (target.type === "function_definition")
      symbols.push({
        name: owner ? `${owner}.${name}` : name,
        kind: owner ? "method" : "function",
        line: line(node),
        endLine: endLine(node),
        exported: !name.startsWith("_"),
      })
    else if (target.type === "class_definition") {
      symbols.push({ name, kind: "class", line: line(node), endLine: endLine(node), exported: !name.startsWith("_") })
      for (const member of target.childForFieldName("body")?.namedChildren ?? []) visit(member, name)
    }
  }
  for (const node of root.namedChildren) {
    if (node.type === "expression_statement") {
      const assignment = node.namedChildren[0]
      const left = assignment?.type === "assignment" ? assignment.childForFieldName("left") : undefined
      if (left?.type === "identifier")
        symbols.push({
          name: left.text,
          kind: /^[A-Z][A-Z0-9_]*$/.test(left.text) ? "constant" : "variable",
          line: line(node),
          endLine: endLine(node),
          exported: !left.text.startsWith("_"),
        })
    } else visit(node)
  }
  return { imports, symbols }
}

function go(root: Node): Pick<FileStructure, "imports" | "symbols" | "package"> {
  const imports: ImportRef[] = []
  const symbols: SymbolRef[] = []
  for (const spec of root.descendantsOfType("import_spec")) {
    const source = spec.childForFieldName("path")
    if (source) imports.push({ specifier: unquote(source.text), line: line(spec), kind: "static" })
  }
  const exported = (name: string) => /^\p{Lu}/u.test(name)
  for (const node of root.namedChildren) {
    if (node.type === "function_declaration" || node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text
      if (!name) continue
      const receiver = node.childForFieldName("receiver")?.descendantsOfType("type_identifier")[0]?.text
      symbols.push({
        name: receiver ? `${receiver}.${name}` : name,
        kind: receiver ? "method" : "function",
        line: line(node),
        endLine: endLine(node),
        exported: exported(name),
      })
    } else if (node.type === "type_declaration") {
      for (const spec of node.descendantsOfType(["type_spec", "type_alias"])) {
        const name = spec.childForFieldName("name")?.text
        const type = spec.childForFieldName("type")?.type
        if (name)
          symbols.push({
            name,
            kind: type === "interface_type" ? "interface" : type === "struct_type" ? "class" : "type",
            line: line(spec),
            endLine: endLine(spec),
            exported: exported(name),
          })
      }
    } else if (node.type === "var_declaration" || node.type === "const_declaration") {
      for (const spec of node.descendantsOfType(["var_spec", "const_spec"]))
        for (const name of spec.childrenForFieldName("name"))
          symbols.push({
            name: name.text,
            kind: node.type === "const_declaration" ? "constant" : "variable",
            line: line(spec),
            endLine: endLine(spec),
            exported: exported(name.text),
          })
    }
  }
  const pkg = root.namedChildren.find((node) => node.type === "package_clause")?.namedChildren[0]?.text
  return { imports, symbols, ...(pkg ? { package: pkg } : {}) }
}

/** Blank out `/* … *\/` block comments, preserving newlines (linear, no backtracking). */
function blankBlockComments(source: string): string {
  let out = ""
  let i = 0
  for (;;) {
    const start = source.indexOf("/*", i)
    if (start < 0) return out + source.slice(i)
    out += source.slice(i, start)
    const end = source.indexOf("*/", start + 2)
    const stop = end < 0 ? source.length : end + 2
    out += source.slice(start, stop).replace(/[^\n]/g, " ")
    i = stop
  }
}

/** Blank out `//` line comments, keeping the preceding-character guard. */
function blankLineComments(source: string): string {
  let out = ""
  let i = 0
  for (;;) {
    const newline = source.indexOf("\n", i)
    const end = newline < 0 ? source.length : newline
    const line = source.slice(i, end)
    const at = lineCommentIndex(line)
    out += at < 0 ? line : line.slice(0, at) + " ".repeat(line.length - at)
    if (newline < 0) return out
    out += "\n"
    i = newline + 1
  }
}

const COMMENT_GUARD = new Set([":", '"', "'", "`", "\\"])

function lineCommentIndex(line: string): number {
  for (let i = 0; i < line.length - 1; i++)
    if (line[i] === "/" && line[i + 1] === "/") {
      const previous = i > 0 ? line[i - 1]! : ""
      if (i === 0 || !COMMENT_GUARD.has(previous)) return i
    }
  return -1
}

const isWordCode = (code: number) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95

/** The last `\w+` run in `text` (Go receiver names), without a regex. */
function lastWord(text: string): string {
  let end = text.length
  while (end > 0 && !isWordCode(text.codePointAt(end - 1) ?? 0)) end--
  let start = end
  while (start > 0 && isWordCode(text.codePointAt(start - 1) ?? 0)) start--
  return text.slice(start, end)
}

const isWordChar = (char: string | undefined) => char !== undefined && /\w/.test(char)
const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char)

/**
 * `import … from "x"` and `import type … from "x"`, scanned without a
 * backtracking regex: after `import` (and `type`), the first quote must close
 * a `… from` clause; a semicolon or backtick (and, outside type imports, a
 * parenthesis) first means it is not one.
 */
function fromImports(text: string): Array<{ index: number; kind: "type" | "static"; specifier: string }> {
  const out: Array<{ index: number; kind: "type" | "static"; specifier: string }> = []
  for (let at = text.indexOf("import"); at >= 0; at = text.indexOf("import", at + 6)) {
    if (isWordChar(text[at - 1]) || !isSpace(text[at + 6])) continue
    let j = at + 6
    while (isSpace(text[j])) j++
    const type = text.startsWith("type", j) && !isWordChar(text[j + 4])
    if (type && !isSpace(text[j + 4])) continue
    const from = type ? j + 4 : j
    let k = from
    while (k < text.length && !`'"\`;`.includes(text[k]!) && (type || (text[k] !== "(" && text[k] !== ")"))) k++
    const quote = text[k]
    if (quote !== "'" && quote !== '"') continue
    const before = text.slice(from, k).trimEnd()
    if (!before.endsWith("from") || isWordChar(before[before.length - 5])) continue
    let end = k + 1
    while (end < text.length && text[end] !== "'" && text[end] !== '"') end++
    if (text[end] !== quote || end === k + 1) continue
    out.push({ index: at, kind: type ? "type" : "static", specifier: text.slice(k + 1, end) })
  }
  return out
}

/** Regex fallback: imports only (symbols best effort), comments stripped first. */
export function extractWithRegex(language: GrammarId, source: string): FileStructure {
  const imports: ImportRef[] = []
  const symbols: SymbolRef[] = []
  const lines = source.split("\n")
  const at = (index: number) => source.slice(0, index).split("\n").length
  if (language === "python") {
    lines.forEach((text, index) => {
      const flat = text.replace(/[ \t]+/g, " ")
      const from = /^ *from ([.\w]+) import (.+)$/.exec(flat)
      if (from) {
        const names = from[2]!
          .replace(/[()]/g, "")
          .split(",")
          .map((name) => name.trim().split(" as ")[0]!)
          .filter(Boolean)
        imports.push({ specifier: from[1]!, line: index + 1, kind: "static", names })
        return
      }
      const plain = /^ *import (.+)$/.exec(flat)
      if (plain)
        for (const part of plain[1]!.split(","))
          imports.push({ specifier: part.trim().split(" as ")[0]!, line: index + 1, kind: "static" })
      const def = /^ *(?:async )?def (\w+)|^ *class (\w+)/.exec(flat)
      if (def) {
        const name = (def[1] ?? def[2])!
        symbols.push({
          name,
          kind: def[1] ? "function" : "class",
          line: index + 1,
          endLine: index + 1,
          exported: !name.startsWith("_"),
        })
      } else {
        const assign = /^([A-Za-z_]\w*)\s*=/.exec(text)
        if (assign) {
          const name = assign[1]!
          symbols.push({
            name,
            kind: /^[A-Z][A-Z0-9_]*$/.test(name) ? "constant" : "variable",
            line: index + 1,
            endLine: index + 1,
            exported: !name.startsWith("_"),
          })
        }
      }
    })
    return { language, parser: "regex", imports, symbols }
  }
  if (language === "go") {
    const stripped = blankBlockComments(source)
    for (const block of stripped.matchAll(/^import\s*\(([\s\S]*?)\)/gm))
      for (const spec of block[1]!.matchAll(/"([^"]+)"/g))
        imports.push({ specifier: spec[1]!, line: at(block.index! + block[0].indexOf(spec[0])), kind: "static" })
    for (const single of stripped.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm))
      imports.push({ specifier: single[1]!, line: at(single.index!), kind: "static" })
    for (const fn of stripped.matchAll(/^func[ \t]+(?:\(([^)]*)\)[ \t]+)?(\w+)/gm)) {
      const receiver = fn[1] ? lastWord(fn[1]) : undefined
      const name = fn[2]!
      symbols.push({
        name: receiver ? `${receiver}.${name}` : name,
        kind: receiver ? "method" : "function",
        line: at(fn.index!),
        endLine: at(fn.index!),
        exported: /^\p{Lu}/u.test(name),
      })
    }
    const pkg = /^package\s+(\w+)/m.exec(stripped)?.[1]
    for (const decl of stripped.matchAll(/^(const|var)\s+(\w+)/gm)) {
      const name = decl[2]!
      symbols.push({
        name,
        kind: decl[1] === "const" ? "constant" : "variable",
        line: at(decl.index!),
        endLine: at(decl.index!),
        exported: /^\p{Lu}/u.test(name),
      })
    }
    return { language, parser: "regex", imports, symbols, ...(pkg ? { package: pkg } : {}) }
  }
  // JS/TS: blank out comments, keep offsets.
  const stripped = blankLineComments(blankBlockComments(source))
  const seen = new Set<number>()
  const found = fromImports(stripped)
  for (const kind of ["type", "static"] as const)
    for (const item of found.filter((entry) => entry.kind === kind)) {
      seen.add(item.index)
      imports.push({ specifier: item.specifier, line: at(item.index), kind })
    }
  const patterns: Array<[RegExp, ImportRef["kind"]]> = [
    [/\bimport\s*(['"])([^'"]+)\1/g, "side-effect"],
    [/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*(['"])([^'"]+)\1/g, "reexport"],
    [/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, "dynamic"],
    [/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, "require"],
  ]
  for (const [pattern, kind] of patterns)
    for (const match of stripped.matchAll(pattern)) {
      if (seen.has(match.index!)) continue
      seen.add(match.index!)
      imports.push({ specifier: match[2]!, line: at(match.index!), kind })
    }
  imports.sort((a, b) => a.line - b.line)
  for (const decl of stripped.matchAll(
    /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function\*?|abstract\s+class|class|interface|type|enum|const|let|var)\s+(\w+)/gm,
  )) {
    const word = decl[2]!.replace(/^abstract\s+/, "").replaceAll("*", "")
    const kind: SymbolRef["kind"] =
      word === "function"
        ? "function"
        : word === "class"
          ? "class"
          : word === "interface"
            ? "interface"
            : word === "type"
              ? "type"
              : word === "enum"
                ? "enum"
                : word === "const"
                  ? "constant"
                  : "variable"
    symbols.push({ name: decl[3]!, kind, line: at(decl.index!), endLine: at(decl.index!), exported: Boolean(decl[1]) })
  }
  return { language, parser: "regex", imports, symbols }
}

const memo = new Map<string, FileStructure>()
const MEMO_LIMIT = 5_000

/** Extract a file's structure. `file` selects the grammar by extension. */
export async function extractStructure(
  file: string,
  source: string,
  options: GrammarOptions & { regexOnly?: boolean } = {},
): Promise<FileStructure | undefined> {
  const language = grammarFor(file)
  if (!language) return undefined
  const key = `${language}:${options.regexOnly ? "r" : "t"}:${createHash("sha256").update(source).digest("hex")}`
  const hit = memo.get(key)
  if (hit) return hit
  let result: FileStructure
  try {
    if (options.regexOnly) throw new Error("regex only")
    const parser = await parserFor(language, options)
    const tree = parser.parse(source)
    if (!tree) throw new Error("parse failed")
    try {
      const root = tree.rootNode
      const extracted = language === "python" ? python(root) : language === "go" ? go(root) : jsLike(root)
      result = {
        language,
        parser: "tree-sitter",
        ...extracted,
        ...(root.hasError ? { syntaxErrors: true } : {}),
      }
    } finally {
      tree.delete()
      parser.delete()
    }
  } catch {
    result = extractWithRegex(language, source)
  }
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!)
  memo.set(key, result)
  return result
}
