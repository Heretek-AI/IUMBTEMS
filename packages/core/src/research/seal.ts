// Engine seal for cached sources (1.1.1, #52). Before the factory dir exists,
// the user agent is unsandboxed and could pre-seed the content-addressed
// source cache with forged entries (the file name is its own sha256, so the
// tamper check passes). Every entry the engine writes is therefore sealed
// with an HMAC under a key kept in the masked state dir (`engine.key`), and
// sealed readers refuse entries without a valid seal. The key is created at
// plugin setup and lazily everywhere else; agents can neither read the state
// dir (sandbox mask) nor forge the seal.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import path from "node:path"
import { stateDir } from "../layout.ts"
import { canonicalJson } from "../util/hash.ts"

const ENGINE_KEY_FILE = "engine.key"

/**
 * Read the engine key, creating it (0600) when absent. Create-first (no
 * check-then-act): O_EXCL refuses an existing file and O_NOFOLLOW refuses a
 * planted symlink, so a pre-seeded path can neither divert nor capture the
 * new key. The losing creator (or a restart) reads the winner's key back,
 * also without following symlinks.
 */
export async function ensureEngineKey(dir: string = stateDir()): Promise<Buffer> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, ENGINE_KEY_FILE)
  const key = randomBytes(32)
  try {
    const handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(key)
    await handle.close()
    return key
  } catch (error: any) {
    if (error?.code !== "EEXIST" && error?.code !== "ELOOP") throw error
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  const raced = await handle.readFile()
  await handle.close()
  if (raced.length >= 32) return raced
  throw new Error(`${ENGINE_KEY_FILE} exists but is shorter than 32 bytes; remove it and retry`)
}

/** HMAC-SHA256 over the canonical meta (minus any previous seal), hex. */
export function sealMeta(meta: Record<string, unknown>, key: Buffer): string {
  const { seal: _seal, ...body } = meta
  return createHmac("sha256", key).update(canonicalJson(body)).digest("hex")
}

/** Whether `meta.seal` is a valid seal by `key` over the rest of `meta`. */
export function verifyMetaSeal(meta: Record<string, unknown>, key: Buffer): boolean {
  if (typeof meta.seal !== "string") return false
  let presented: Buffer
  try {
    presented = Buffer.from(meta.seal, "hex")
  } catch {
    return false
  }
  const expected = Buffer.from(sealMeta(meta, key), "hex")
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}
