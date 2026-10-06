// One language-server process: JSON-RPC over stdio (vscode-jsonrpc), full
// document sync, push + pull diagnostics with a debounced settle, navigation
// requests, and graceful shutdown.
import { type ChildProcess, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node"
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  InitializeResult,
  Location,
  LocationLink,
  SymbolInformation,
  WorkspaceEdit,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol"
import { languageId } from "./registry.ts"

export const toUri = (file: string) => pathToFileURL(file).href
export const fromUri = (uri: string) => (uri.startsWith("file:") ? fileURLToPath(uri) : uri)

export interface ClientOptions {
  readonly id: string
  readonly command: readonly string[]
  readonly root: string
  readonly env?: Readonly<Record<string, string>>
  readonly initialization?: Readonly<Record<string, unknown>>
}

interface OpenDoc {
  version: number
  text: string
}

export class LspClient {
  private connection: MessageConnection | undefined
  private process: ChildProcess | undefined
  private capabilities: InitializeResult["capabilities"] | undefined
  private readonly docs = new Map<string, OpenDoc>()
  private readonly diagnostics = new Map<string, Diagnostic[]>()
  private readonly diagnosticsAt = new Map<string, number>()
  private readonly waiters = new Set<() => void>()
  private stderr = ""
  lastUsed = Date.now()
  exited = false

  constructor(readonly options: ClientOptions) {}

  async start(timeoutMs = 30_000): Promise<void> {
    const [command, ...args] = this.options.command
    const child = spawn(command!, args, {
      cwd: this.options.root,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.process = child
    child.stderr!.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000)
    })
    const exited = new Promise<never>((_, reject) => {
      child.on("error", (error) => reject(new Error(`${this.options.id}: ${error.message}`)))
      child.on("exit", (code) => {
        this.exited = true
        reject(new Error(`${this.options.id} exited (${code}) before initializing: ${this.stderr.trim().slice(-500)}`))
      })
    })
    exited.catch(() => undefined)
    child.stdin!.on("error", () => {})
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!),
    )
    this.connection = connection
    connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: { uri: string; diagnostics: Diagnostic[] }) => {
        this.diagnostics.set(params.uri, params.diagnostics)
        this.diagnosticsAt.set(params.uri, Date.now())
        for (const wake of this.waiters) wake()
      },
    )
    // Servers ask for configuration and register capabilities; answer politely.
    connection.onRequest("workspace/configuration", (params: { items: unknown[] }) =>
      params.items.map(() => this.options.initialization ?? {}),
    )
    connection.onRequest("client/registerCapability", () => null)
    connection.onRequest("window/workDoneProgress/create", () => null)
    connection.onNotification(() => undefined)
    connection.listen()
    const root = toUri(this.options.root)
    const init = connection.sendRequest<InitializeResult>("initialize", {
      processId: process.pid,
      rootUri: root,
      workspaceFolders: [{ uri: root, name: "root" }],
      initializationOptions: this.options.initialization ?? {},
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: false },
        },
      },
    })
    const result = await Promise.race([
      init,
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${this.options.id} did not initialize within ${timeoutMs}ms`)), timeoutMs),
      ),
    ])
    this.capabilities = result.capabilities
    connection.sendNotification("initialized", {})
  }

  get supportsPull(): boolean {
    return Boolean(this.capabilities?.diagnosticProvider)
  }

  /** Open or update a document from disk (full sync). */
  async sync(file: string, text?: string): Promise<string> {
    this.lastUsed = Date.now()
    const uri = toUri(file)
    const content = text ?? (await readFile(file, "utf8"))
    const doc = this.docs.get(uri)
    if (!doc) {
      this.docs.set(uri, { version: 1, text: content })
      this.diagnosticsAt.delete(uri)
      await this.connection!.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(file), version: 1, text: content },
      })
    } else if (doc.text !== content) {
      doc.version += 1
      doc.text = content
      this.diagnosticsAt.delete(uri)
      await this.connection!.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text: content }],
      })
      await this.connection!.sendNotification("textDocument/didSave", { textDocument: { uri } })
    }
    return uri
  }

  /**
   * Diagnostics for a file after syncing it: pull when supported, else wait for
   * a push, settling for `quietMs` after the last push (max `maxWaitMs`).
   */
  async fileDiagnostics(file: string, options: { maxWaitMs?: number; quietMs?: number } = {}): Promise<Diagnostic[]> {
    const uri = await this.sync(file)
    if (this.supportsPull) {
      try {
        const report = await this.connection!.sendRequest<{ kind: string; items?: Diagnostic[] }>(
          "textDocument/diagnostic",
          { textDocument: { uri } },
        )
        if (report.kind === "full") return report.items ?? []
      } catch {
        // fall back to push
      }
    }
    const maxWait = options.maxWaitMs ?? 5_000
    const quiet = options.quietMs ?? 300
    const started = Date.now()
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        this.waiters.delete(check)
        if (timer) clearTimeout(timer)
        clearTimeout(cap)
        resolve()
      }
      const check = () => {
        const at = this.diagnosticsAt.get(uri)
        if (at === undefined) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(finish, quiet)
      }
      const cap = setTimeout(finish, Math.max(0, maxWait - (Date.now() - started)))
      this.waiters.add(check)
      check()
    })
    return this.diagnostics.get(uri) ?? []
  }

  private position(file: string, line: number, column: number) {
    return { textDocument: { uri: toUri(file) }, position: { line: line - 1, character: column - 1 } }
  }

  async definition(file: string, line: number, column: number): Promise<Location[]> {
    await this.sync(file)
    const result = await this.connection!.sendRequest<Location | Location[] | LocationLink[] | null>(
      "textDocument/definition",
      this.position(file, line, column),
    )
    if (!result) return []
    const list = Array.isArray(result) ? result : [result]
    return list.map((item) =>
      "targetUri" in item ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange } : item,
    )
  }

  async references(file: string, line: number, column: number): Promise<Location[]> {
    await this.sync(file)
    return (
      (await this.connection!.sendRequest<Location[] | null>("textDocument/references", {
        ...this.position(file, line, column),
        context: { includeDeclaration: true },
      })) ?? []
    )
  }

  async hover(file: string, line: number, column: number): Promise<Hover | null> {
    await this.sync(file)
    return this.connection!.sendRequest<Hover | null>("textDocument/hover", this.position(file, line, column))
  }

  async documentSymbols(file: string): Promise<Array<DocumentSymbol | SymbolInformation>> {
    const uri = await this.sync(file)
    return (
      (await this.connection!.sendRequest<Array<DocumentSymbol | SymbolInformation> | null>(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
      )) ?? []
    )
  }

  async workspaceSymbols(query: string): Promise<Array<SymbolInformation | WorkspaceSymbol>> {
    this.lastUsed = Date.now()
    return (
      (await this.connection!.sendRequest<Array<SymbolInformation | WorkspaceSymbol> | null>("workspace/symbol", {
        query,
      })) ?? []
    )
  }

  async rename(file: string, line: number, column: number, newName: string): Promise<WorkspaceEdit | null> {
    await this.sync(file)
    return this.connection!.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
      ...this.position(file, line, column),
      newName,
    })
  }

  async stop(): Promise<void> {
    if (!this.connection || this.exited) return
    try {
      await Promise.race([
        this.connection.sendRequest("shutdown"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
      this.connection.sendNotification("exit")
    } catch {
      // already gone
    }
    this.connection.dispose()
    setTimeout(() => {
      if (!this.exited) this.process?.kill("SIGKILL")
    }, 1_000).unref()
  }
}
