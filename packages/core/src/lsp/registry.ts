// Built-in language-server registry plus OpenCode v2's `lsp` config key
// (accepted but not run by v2 itself). User config overrides or disables
// built-ins and adds servers; `lsp: false` turns LSP off entirely.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { exists } from "../util/fs.ts"
import { parseJsonc } from "../util/jsonc.ts"

export interface NpmInstall {
  readonly kind: "npm"
  readonly packages: ReadonlyArray<{ readonly name: string; readonly version: string; readonly integrity: string }>
  /** Binary inside the install's node_modules/.bin. */
  readonly bin: string
}

export interface ServerSpec {
  readonly id: string
  readonly command: readonly string[]
  readonly extensions: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly initialization?: Readonly<Record<string, unknown>>
  /** Files whose nearest directory becomes the server root. */
  readonly rootMarkers: readonly string[]
  /** Pinned, checksummed on-demand install (ask-once). */
  readonly install?: NpmInstall
  readonly source: "builtin" | "config"
}

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".json": "json",
}

export const languageId = (file: string) => LANGUAGE_IDS[path.extname(file).toLowerCase()] ?? "plaintext"

const TS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

export const BUILTIN_SERVERS: readonly ServerSpec[] = [
  {
    id: "typescript",
    // Resolved at start: native `tsc --lsp --stdio` for TypeScript >= 7, else typescript-language-server.
    command: ["typescript-language-server", "--stdio"],
    extensions: TS_EXT,
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    install: {
      kind: "npm",
      packages: [
        {
          name: "typescript-language-server",
          version: "6.0.1",
          integrity: "sha512-c5hEHM/7rdFRbQWoHXuddyJ53oF0M2dKeXQOYdwUek556oarltKeumKJGLp/ZMcGV7gW30mGn1MR3V5GDiLiKg==",
        },
      ],
      bin: "typescript-language-server",
    },
    source: "builtin",
  },
  {
    id: "pyright",
    command: ["pyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pyrightconfig.json"],
    install: {
      kind: "npm",
      packages: [
        {
          name: "pyright",
          version: "1.1.414",
          integrity: "sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==",
        },
      ],
      bin: "pyright-langserver",
    },
    source: "builtin",
  },
  { id: "gopls", command: ["gopls"], extensions: [".go"], rootMarkers: ["go.work", "go.mod"], source: "builtin" },
  {
    id: "rust-analyzer",
    command: ["rust-analyzer"],
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml"],
    source: "builtin",
  },
  {
    id: "clangd",
    command: ["clangd", "--background-index=false"],
    extensions: [".c", ".h", ".cc", ".cpp", ".hpp", ".cxx"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt"],
    source: "builtin",
  },
]

/** The v2 `lsp` value: boolean, or name → { disabled: true } | server settings. */
export type LspConfigValue =
  | boolean
  | Record<
      string,
      | { disabled: true }
      | {
          command: string[]
          extensions?: string[]
          env?: Record<string, string>
          initialization?: Record<string, unknown>
          disabled?: boolean
        }
    >

/** OpenCode config files in increasing precedence. */
export function opencodeConfigFiles(root: string, home = homedir(), xdgConfig = process.env.XDG_CONFIG_HOME): string[] {
  const config = xdgConfig ?? path.join(home, ".config")
  return [
    path.join(config, "opencode", "opencode.json"),
    path.join(config, "opencode", "opencode.jsonc"),
    path.join(root, "opencode.json"),
    path.join(root, "opencode.jsonc"),
    path.join(root, ".opencode", "opencode.json"),
    path.join(root, ".opencode", "opencode.jsonc"),
  ]
}

export interface ResolvedLspConfig {
  readonly enabled: boolean
  readonly servers: readonly ServerSpec[]
  readonly diagnostics: readonly string[]
}

export async function resolveLspConfig(root: string, files = opencodeConfigFiles(root)): Promise<ResolvedLspConfig> {
  const diagnostics: string[] = []
  let enabled = true
  const servers = new Map(BUILTIN_SERVERS.map((server) => [server.id, server as ServerSpec]))
  for (const file of files) {
    if (!(await exists(file))) continue
    let config: { lsp?: LspConfigValue }
    try {
      config = parseJsonc(await readFile(file, "utf8"))
    } catch {
      diagnostics.push(`${file}: invalid JSON; its lsp settings are ignored`)
      continue
    }
    const value = config?.lsp
    if (value === undefined) continue
    if (typeof value === "boolean") {
      enabled = value
      continue
    }
    for (const [id, entry] of Object.entries(value)) {
      if (!entry || entry.disabled === true) {
        servers.delete(id)
        continue
      }
      if (!("command" in entry) || !Array.isArray(entry.command) || entry.command.length === 0) {
        diagnostics.push(`${file}: lsp.${id} needs a command array`)
        continue
      }
      const base = servers.get(id)
      servers.set(id, {
        id,
        command: entry.command,
        extensions: entry.extensions ?? base?.extensions ?? [],
        ...(entry.env ? { env: entry.env } : {}),
        ...(entry.initialization ? { initialization: entry.initialization } : {}),
        rootMarkers: base?.rootMarkers ?? [],
        source: "config",
      })
    }
  }
  return { enabled, servers: [...servers.values()], diagnostics }
}

export function serverForFile(servers: readonly ServerSpec[], file: string): ServerSpec | undefined {
  const ext = path.extname(file).toLowerCase()
  return servers.find((server) => server.extensions.includes(ext))
}

/** Nearest directory (between file and project root) containing one of the markers; else the project root. */
export async function findRoot(projectRoot: string, file: string, markers: readonly string[]): Promise<string> {
  let dir = path.dirname(path.resolve(projectRoot, file))
  const top = path.resolve(projectRoot)
  for (;;) {
    for (const marker of markers) if (await exists(path.join(dir, marker))) return dir
    if (dir === top || !dir.startsWith(top)) return top
    const parent = path.dirname(dir)
    if (parent === dir) return top
    dir = parent
  }
}
