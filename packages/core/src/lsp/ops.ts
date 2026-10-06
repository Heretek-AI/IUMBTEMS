// Harness-neutral language-server tools. Navigation and diagnostics are
// read-only ("lsp" permission action); applying a rename writes files and is
// a separate action ("lsp_rename") that also passes the write policy for the
// calling agent, file by file, before anything is written.
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
  Diagnostic,
  DocumentSymbol,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver-protocol"
import type { EsToolDef } from "../ops/tools.ts"
import { evaluateWrite, type PolicyContext } from "../trust/policy.ts"
import { fromUri } from "./client.ts"
import type { LspManager } from "./manager.ts"

const SEVERITY = ["", "error", "warning", "info", "hint"] as const

export function formatDiagnostics(
  root: string,
  file: string,
  diagnostics: readonly Diagnostic[],
  minSeverity = 2,
): string[] {
  const relative = path.relative(root, file)
  return diagnostics
    .filter((item) => (item.severity ?? 1) <= minSeverity)
    .map(
      (item) =>
        `${relative}:${item.range.start.line + 1}:${item.range.start.character + 1} ${SEVERITY[item.severity ?? 1]}${item.code !== undefined ? ` ${item.source ?? ""}${item.code}` : ""}: ${item.message}`,
    )
}

const at = (root: string, uri: string, line: number, character: number) =>
  `${path.relative(root, fromUri(uri))}:${line + 1}:${character + 1}`

function flattenSymbols(symbols: Array<DocumentSymbol | SymbolInformation>, root: string, depth = 0): string[] {
  const out: string[] = []
  for (const symbol of symbols) {
    if ("location" in symbol)
      out.push(
        `${"  ".repeat(depth)}${symbol.name} (kind ${symbol.kind}) ${at(root, symbol.location.uri, symbol.location.range.start.line, symbol.location.range.start.character)}`,
      )
    else {
      out.push(`${"  ".repeat(depth)}${symbol.name} (kind ${symbol.kind}) line ${symbol.selectionRange.start.line + 1}`)
      if (symbol.children?.length) out.push(...flattenSymbols(symbol.children, root, depth + 1))
    }
  }
  return out
}

function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const lines = text.split("\n")
  const offset = (line: number, character: number) => {
    let total = 0
    for (let i = 0; i < line; i++) total += (lines[i]?.length ?? 0) + 1
    return total + character
  }
  const sorted = [...edits].sort(
    (a, b) => offset(b.range.start.line, b.range.start.character) - offset(a.range.start.line, a.range.start.character),
  )
  let out = text
  for (const edit of sorted) {
    const start = offset(edit.range.start.line, edit.range.start.character)
    const end = offset(edit.range.end.line, edit.range.end.character)
    out = out.slice(0, start) + edit.newText + out.slice(end)
  }
  return out
}

function editsByFile(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const files = new Map<string, TextEdit[]>()
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) files.set(fromUri(uri), [...edits])
  for (const change of edit.documentChanges ?? [])
    if ("textDocument" in change)
      files.set(fromUri(change.textDocument.uri), [
        ...(files.get(fromUri(change.textDocument.uri)) ?? []),
        ...(change.edits as TextEdit[]),
      ])
  return files
}

export interface LspOpsContext {
  readonly root: string
  readonly manager: LspManager
  readonly policy: () => Promise<PolicyContext>
}

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})
const position = {
  path: { type: "string" },
  line: { type: "number", description: "1-based" },
  column: { type: "number", description: "1-based" },
}

export function lspTools(context: LspOpsContext): EsToolDef[] {
  const { root, manager } = context
  const client = async (file: string) => {
    const found = await manager.clientFor(file)
    if ("unavailable" in found) throw new Error(found.unavailable)
    return found.client
  }
  const abs = (file: string) => path.resolve(root, file)
  return [
    {
      name: "lsp_diagnostics",
      description: "Language-server diagnostics (errors and warnings) for a file, after syncing it from disk.",
      input: object({ path: { type: "string" } }, ["path"]),
      execute: async ({ path: file }) => {
        const result = await manager.diagnostics(file, { maxWaitMs: 10_000 })
        if (!Array.isArray(result)) return result.unavailable
        const lines = formatDiagnostics(root, abs(file), result)
        return lines.length ? lines.join("\n") : `${file}: no errors or warnings`
      },
    },
    {
      name: "lsp_definition",
      description: "Go to the definition of the symbol at a 1-based line and column.",
      input: object(position, ["path", "line", "column"]),
      execute: async ({ path: file, line, column }) => {
        const locations = await (await client(file)).definition(abs(file), line, column)
        return locations.length
          ? locations.map((item) => at(root, item.uri, item.range.start.line, item.range.start.character)).join("\n")
          : "No definition found."
      },
    },
    {
      name: "lsp_references",
      description: "Find all references to the symbol at a 1-based line and column.",
      input: object(position, ["path", "line", "column"]),
      execute: async ({ path: file, line, column }) => {
        const locations = await (await client(file)).references(abs(file), line, column)
        return locations.length
          ? locations.map((item) => at(root, item.uri, item.range.start.line, item.range.start.character)).join("\n")
          : "No references found."
      },
    },
    {
      name: "lsp_hover",
      description: "Type information and docs for the symbol at a 1-based line and column.",
      input: object(position, ["path", "line", "column"]),
      execute: async ({ path: file, line, column }) => {
        const hover = await (await client(file)).hover(abs(file), line, column)
        const contents = hover?.contents
        if (!contents) return "No hover information."
        if (typeof contents === "string") return contents
        if (Array.isArray(contents))
          return contents.map((item) => (typeof item === "string" ? item : item.value)).join("\n")
        return contents.value
      },
    },
    {
      name: "lsp_symbols",
      description: "Symbols of a file (path), or a workspace-wide symbol search (path plus query).",
      input: object({ path: { type: "string" }, query: { type: "string" } }, ["path"]),
      execute: async ({ path: file, query }) => {
        const lsp = await client(file)
        if (query) {
          const found = await lsp.workspaceSymbols(query)
          return found.length
            ? found
                .slice(0, 100)
                .map((item) =>
                  "range" in item.location
                    ? `${item.name} ${at(root, item.location.uri, item.location.range.start.line, item.location.range.start.character)}`
                    : `${item.name} ${path.relative(root, fromUri(item.location.uri))}`,
                )
                .join("\n")
            : "No symbols found."
        }
        const symbols = await lsp.documentSymbols(abs(file))
        return symbols.length ? flattenSymbols(symbols, root).join("\n") : "No symbols."
      },
    },
    {
      name: "lsp_rename",
      description:
        "Rename the symbol at a 1-based line and column across the workspace. Without apply:true it only previews the edits.",
      input: object({ ...position, newName: { type: "string" }, apply: { type: "boolean" } }, [
        "path",
        "line",
        "column",
        "newName",
      ]),
      execute: async ({ path: file, line, column, newName, apply }, toolContext) => {
        const edit = await (await client(file)).rename(abs(file), line, column, newName)
        if (!edit) return "The server returned no rename edits."
        const files = editsByFile(edit)
        const summary = [...files].map(([target, edits]) => `${path.relative(root, target)}: ${edits.length} edit(s)`)
        if (!apply) return `Preview (call again with apply:true to write):\n${summary.join("\n")}`
        const policy = await context.policy()
        for (const target of files.keys()) {
          const decision = evaluateWrite(policy, toolContext.agent, target)
          if (decision.effect !== "allow")
            throw new Error(
              `Rename not applied: ${decision.effect === "deny" ? decision.reason : `${path.relative(root, target)} needs approval`}`,
            )
        }
        for (const [target, edits] of files) await writeFile(target, applyEdits(await readFile(target, "utf8"), edits))
        for (const target of files.keys())
          await manager.clientFor(target).then((found) => ("client" in found ? found.client.sync(target) : undefined))
        return `Renamed to ${newName}:\n${summary.join("\n")}`
      },
    },
  ]
}
