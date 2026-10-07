// Engine seal for cached sources (1.1.1, #52). Before the factory dir exists,
// the user agent is unsandboxed and could pre-seed the content-addressed
// source cache with forged entries (the file name is its own sha256, so the
// tamper check passes). Every entry the engine writes is therefore sealed
// with an HMAC under a key kept in the masked state dir (`engine.key`), and
// sealed readers refuse entries without a valid seal. The key is created at
// plugin setup and lazily everywhere else; agents can neither read the state
// dir (sandbox mask) nor forge the seal.
import { createHmac, randomBytes } from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"
import { stateDir } from "../layout.ts"
import { canonicalJson } from "../util/hash.ts"

const ENGINE_KEY_FILE = "engine.key"

/** Read the engine key, creating it (0600) when absent. */
export async function ensureEngineKey(dir: string = stateDir()): Promise<Buffer> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, ENGINE_KEY_FILE)
  const existing = await readFile(file).catch(() => undefined)
  if (existing && existing.length >= 32) return existing
  const key = randomBytes(32)
  try {
    const handle = await open(file, "wx", 0o600)
    await handle.writeFile(key)
    await handle.close()
  } catch (error: any) {
    // A concurrent creator won: use its key.
    if (error?.code !== "EEXIST") throw error
    const raced = await readFile(file)
    if (raced.length >= 32) return raced
    throw error
  }
  return key
}

/** HMAC-SHA256 over the canonical meta (minus any previous seal), hex. */
export function sealMeta(meta: Record<string, unknown>, key: Buffer): string {
  const { seal: _seal, ...body } = meta
  return createHmac("sha256", key).update(canonicalJson(body)).digest("hex")
}

/** Whether `meta.seal` is a valid seal by `key` over the rest of `meta`. */
export function verifyMetaSeal(meta: Record<string, unknown>, key: Buffer): boolean {
  if (typeof meta.seal !== "string" || meta.seal.length !== 64) return false
  return sealMeta(meta, key) === meta.seal
}
