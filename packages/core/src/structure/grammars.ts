// Lazy, pinned tree-sitter grammars. Each grammar's WASM comes from an exact
// npm tarball: the tarball must match its pinned SRI integrity and the
// extracted .wasm its pinned sha256 before it is cached and loaded, and a
// cached copy is re-hashed on every load (so a tampered cache is refetched).
// Offline (ES_GRAMMARS=off), failing or mismatching grammars make callers fall
// back to regex scanning; a failed download is not retried for ten minutes.
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { Language, Parser } from "web-tree-sitter"

export type GrammarId = "typescript" | "tsx" | "javascript" | "python" | "go"

interface GrammarPin {
  readonly npm: string
  readonly version: string
  readonly integrity: string
  readonly file: string
  readonly sha256: string
}

export const GRAMMARS: Readonly<Record<GrammarId, GrammarPin>> = {
  typescript: {
    npm: "tree-sitter-typescript",
    version: "0.23.2",
    integrity: "sha512-e04JUUKxTT53/x3Uq1zIL45DoYKVfHH4CZqwgZhPg5qYROl5nQjV+85ruFzFGZxu+QeFVbRTPDRnqL9UbU4VeA==",
    file: "tree-sitter-typescript.wasm",
    sha256: "778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d",
  },
  tsx: {
    npm: "tree-sitter-typescript",
    version: "0.23.2",
    integrity: "sha512-e04JUUKxTT53/x3Uq1zIL45DoYKVfHH4CZqwgZhPg5qYROl5nQjV+85ruFzFGZxu+QeFVbRTPDRnqL9UbU4VeA==",
    file: "tree-sitter-tsx.wasm",
    sha256: "79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8",
  },
  javascript: {
    npm: "tree-sitter-javascript",
    version: "0.25.0",
    integrity: "sha512-1fCbmzAskZkxcZzN41sFZ2br2iqTYP3tKls1b/HKGNPQUVOpsUxpmGxdN/wMqAk3jYZnYBR1dd/y/0avMeU7dw==",
    file: "tree-sitter-javascript.wasm",
    sha256: "5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240",
  },
  python: {
    npm: "tree-sitter-python",
    version: "0.25.0",
    integrity: "sha512-eCmJx6zQa35GxaCtQD+wXHOhYqBxEL+bp71W/s3fcDMu06MrtzkVXR437dRrCrbrDbyLuUDJpAgycs7ncngLXw==",
    file: "tree-sitter-python.wasm",
    sha256: "16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47",
  },
  go: {
    npm: "tree-sitter-go",
    version: "0.25.0",
    integrity: "sha512-APBc/Dq3xz/e35Xpkhb1blu5UgW+2E3RyGWawZSCNcbGwa7jhSQPS8KsUupuzBla8PCo8+lz9W/JDJjmfRa2tw==",
    file: "tree-sitter-go.wasm",
    sha256: "9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7",
  },
}

export function grammarFor(file: string): GrammarId | undefined {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "typescript"
  if (ext === ".tsx") return "tsx"
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript"
  if (ext === ".py" || ext === ".pyi") return "python"
  if (ext === ".go") return "go"
  return undefined
}

/** Extract one file from a (gunzipped) ustar archive. */
export function untarFile(tar: Uint8Array, wanted: string): Uint8Array | undefined {
  const decoder = new TextDecoder()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start: number, length: number) =>
      decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/s, "")
    const name = field(0, 100)
    const prefix = field(345, 155)
    const size = Number.parseInt(field(124, 12).trim() || "0", 8)
    const full = prefix ? `${prefix}/${name}` : name
    const body = offset + 512
    if (full === wanted || full.endsWith(`/${wanted}`)) return tar.slice(body, body + size)
    offset = body + Math.ceil(size / 512) * 512
  }
  return undefined
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const sri = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`

/** Grammar cache: ES_GRAMMAR_DIR, else $XDG_CACHE_HOME/epistemic-swarm/grammars. */
export function grammarCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ES_GRAMMAR_DIR) return path.resolve(env.ES_GRAMMAR_DIR)
  const base = env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(homedir(), ".cache")
  return path.join(base, "epistemic-swarm", "grammars")
}

let initialized: Promise<void> | undefined
const loaded = new Map<GrammarId, Promise<Language>>()
const failed = new Map<GrammarId, { at: number; error: Error }>()
const RETRY_AFTER_MS = 10 * 60_000

export interface GrammarOptions {
  readonly cacheDir?: string
  readonly fetch?: typeof fetch
  /** Never download (cache only). Default: ES_GRAMMARS=off. */
  readonly offline?: boolean
}

async function wasmBytes(id: GrammarId, options: GrammarOptions): Promise<Uint8Array> {
  const pin = GRAMMARS[id]
  const cacheFile = path.join(options.cacheDir ?? grammarCacheDir(), `${pin.npm}@${pin.version}`, pin.file)
  const cached = await readFile(cacheFile).catch(() => undefined)
  if (cached && sha256(cached) === pin.sha256) return cached
  if (options.offline ?? process.env.ES_GRAMMARS === "off")
    throw new Error(`grammar ${id} is not cached and downloads are disabled`)
  const url = `https://registry.npmjs.org/${pin.npm}/-/${pin.npm.split("/").pop()}-${pin.version}.tgz`
  const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`downloading ${pin.npm}@${pin.version} failed: HTTP ${response.status}`)
  const tarball = new Uint8Array(await response.arrayBuffer())
  if (sri(tarball) !== pin.integrity)
    throw new Error(`${pin.npm}@${pin.version} tarball does not match its pinned integrity`)
  const wasm = untarFile(gunzipSync(tarball), pin.file)
  if (!wasm) throw new Error(`${pin.file} not found in ${pin.npm}@${pin.version}`)
  if (sha256(wasm) !== pin.sha256) throw new Error(`${pin.file} does not match its pinned sha256`)
  await mkdir(path.dirname(cacheFile), { recursive: true })
  const temp = `${cacheFile}.${process.pid}.tmp`
  await writeFile(temp, wasm)
  await rename(temp, cacheFile)
  return wasm
}

export async function loadGrammar(id: GrammarId, options: GrammarOptions = {}): Promise<Language> {
  const failure = failed.get(id)
  if (failure && Date.now() - failure.at < RETRY_AFTER_MS) throw failure.error
  initialized ??= Parser.init()
  await initialized
  let pending = loaded.get(id)
  if (!pending) {
    pending = wasmBytes(id, options).then((bytes) => Language.load(bytes))
    loaded.set(id, pending)
    pending.catch((error: unknown) => {
      loaded.delete(id)
      failed.set(id, { at: Date.now(), error: error instanceof Error ? error : new Error(String(error)) })
    })
  }
  return pending
}

/** Forget cached failures and languages (tests). */
export function resetGrammars(): void {
  failed.clear()
  loaded.clear()
}

export async function parserFor(id: GrammarId, options: GrammarOptions = {}): Promise<Parser> {
  const language = await loadGrammar(id, options)
  const parser = new Parser()
  parser.setLanguage(language)
  return parser
}
