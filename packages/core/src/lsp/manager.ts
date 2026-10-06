// Language-server lifecycle: lazy start per (server, root), idle shutdown, a
// concurrency cap with least-recently-used eviction, and command resolution
// (workspace binaries, PATH, then pinned installs). One manager per project.
import { accessSync, constants } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Diagnostic } from "vscode-languageserver-protocol"
import { stateDir as defaultStateDir } from "../layout.ts"
import { exists } from "../util/fs.ts"
import { fromUri, LspClient } from "./client.ts"
import { installedBin } from "./install.ts"
import {
  findRoot,
  opencodeConfigFiles,
  type ResolvedLspConfig,
  resolveLspConfig,
  type ServerSpec,
  serverForFile,
} from "./registry.ts"

export interface LspManagerOptions {
  readonly root: string
  readonly stateDir?: string
  readonly idleMs?: number
  readonly maxServers?: number
  readonly configFiles?: readonly string[]
}

export interface Unavailable {
  readonly unavailable: string
}

function onPath(binary: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, binary)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return undefined
}

async function nodeModulesBin(from: string, top: string, binary: string): Promise<string | undefined> {
  let dir = from
  for (;;) {
    const candidate = path.join(dir, "node_modules", ".bin", binary)
    if (await exists(candidate)) return candidate
    if (dir === top) break
    const parent = path.dirname(dir)
    if (parent === dir || !parent.startsWith(top)) break
    dir = parent
  }
  return undefined
}

async function typescriptMajor(from: string, top: string): Promise<number | undefined> {
  let dir = from
  for (;;) {
    const text = await readFile(path.join(dir, "node_modules", "typescript", "package.json"), "utf8").catch(
      () => undefined,
    )
    if (text) return Number(JSON.parse(text).version?.split(".")[0])
    if (dir === top) return undefined
    const parent = path.dirname(dir)
    if (parent === dir || !parent.startsWith(top)) return undefined
    dir = parent
  }
}

export class LspManager {
  private readonly clients = new Map<string, Promise<LspClient>>()
  private config: ResolvedLspConfig | undefined
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(private readonly options: LspManagerOptions) {
    this.sweeper = setInterval(() => void this.sweep(), Math.min(this.options.idleMs ?? 600_000, 60_000))
    this.sweeper.unref?.()
  }

  async settings(): Promise<ResolvedLspConfig> {
    this.config ??= await resolveLspConfig(this.options.root, [
      ...(this.options.configFiles ?? opencodeConfigFiles(this.options.root)),
    ])
    return this.config
  }

  /** Resolve the command for a server in a given root, or explain why it cannot run. */
  async command(server: ServerSpec, root: string): Promise<string[] | Unavailable> {
    const top = path.resolve(this.options.root)
    const [binary, ...args] = server.command
    if (server.source === "builtin" && server.id === "typescript" && ((await typescriptMajor(root, top)) ?? 0) >= 7) {
      const tsc = await nodeModulesBin(root, top, "tsc")
      if (tsc) return [tsc, "--lsp", "--stdio"]
    }
    const local = binary!.includes("/") ? binary : ((await nodeModulesBin(root, top, binary!)) ?? onPath(binary!))
    if (local) return [local, ...args]
    const installed = await installedBin(server, this.options.stateDir ?? defaultStateDir())
    if (installed) return [installed, ...args]
    return {
      unavailable: server.install
        ? `${server.id} is not installed. A human can install the pinned, checksummed build with \`es lsp install ${server.id}\` (or /lsp in the TUI).`
        : `${binary} is not on PATH; install it to enable ${server.id}.`,
    }
  }

  async clientFor(file: string): Promise<{ client: LspClient; server: ServerSpec } | Unavailable> {
    const settings = await this.settings()
    if (!settings.enabled) return { unavailable: "LSP is disabled (lsp: false)" }
    const absolute = path.resolve(this.options.root, file)
    const server = serverForFile(settings.servers, absolute)
    if (!server) return { unavailable: `no language server handles ${path.extname(absolute) || "this file"}` }
    const root = await findRoot(this.options.root, absolute, server.rootMarkers)
    const key = `${server.id}\0${root}`
    let pending = this.clients.get(key)
    if (!pending) {
      const command = await this.command(server, root)
      if (!Array.isArray(command)) return command
      await this.evictIfNeeded()
      const client = new LspClient({
        id: server.id,
        command,
        root,
        ...(server.env ? { env: server.env } : {}),
        ...(server.initialization ? { initialization: server.initialization } : {}),
      })
      pending = client.start().then(() => client)
      this.clients.set(key, pending)
      pending.catch(() => this.clients.delete(key))
    }
    try {
      const client = await pending
      if (client.exited) {
        this.clients.delete(key)
        return this.clientFor(file)
      }
      return { client, server }
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) }
    }
  }

  private async evictIfNeeded() {
    const max = this.options.maxServers ?? 4
    if (this.clients.size < max) return
    const ready = await Promise.all(
      [...this.clients].map(async ([key, pending]) => [key, await pending.catch(() => undefined)] as const),
    )
    const oldest = ready.filter(([, client]) => client).sort((a, b) => a[1]!.lastUsed - b[1]!.lastUsed)[0]
    if (oldest) {
      this.clients.delete(oldest[0])
      await oldest[1]!.stop()
    }
  }

  private async sweep() {
    const idle = this.options.idleMs ?? 600_000
    for (const [key, pending] of [...this.clients]) {
      const client = await pending.catch(() => undefined)
      if (!client || client.exited || Date.now() - client.lastUsed > idle) {
        this.clients.delete(key)
        await client?.stop()
      }
    }
  }

  async diagnostics(file: string, options?: { maxWaitMs?: number }): Promise<Diagnostic[] | Unavailable> {
    const found = await this.clientFor(file)
    if ("unavailable" in found) return found
    return found.client.fileDiagnostics(path.resolve(this.options.root, file), options)
  }

  async status() {
    const settings = await this.settings()
    const running = await Promise.all(
      [...this.clients].map(async ([key, pending]) => {
        const client = await pending.catch(() => undefined)
        const [id, root] = key.split("\0")
        return {
          id: id!,
          root: root!,
          ready: Boolean(client && !client.exited),
          idleMs: client ? Date.now() - client.lastUsed : 0,
        }
      }),
    )
    return {
      enabled: settings.enabled,
      servers: settings.servers.map((server) => ({
        id: server.id,
        extensions: server.extensions,
        source: server.source,
      })),
      running,
      diagnostics: settings.diagnostics,
    }
  }

  async stopAll(): Promise<void> {
    clearInterval(this.sweeper)
    const all = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(all.map(async (pending) => (await pending.catch(() => undefined))?.stop()))
  }
}

export { fromUri }
