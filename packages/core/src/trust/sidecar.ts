// Signed sidecars for engine-owned files (1.1.2). Deny-write rules and the
// sandbox keep agents from rewriting control files, but a pre-seeded file
// (written before `.factory/` exists, when the user agent is unsandboxed) or
// a sandbox escape would read as legitimate. Engine-owned files therefore
// carry a sidecar with an HMAC-SHA256 over their bytes under the engine key
// (masked state dir, see `research/seal.ts`); readers verify the sidecar and
// refuse files without a valid seal, and only a human at a terminal re-signs
// (`es reseal --sign`) after reviewing what changed.
//
// Coverage starts with the run state (`.factory/runtime/state.json`: its
// writer and reader are both engine code, so the seal is airtight). Research
// sources are sealed per-entry (#52); approvals, waivers and trust records
// carry their own signatures. Seat-authored files (specs, roadmaps) and
// human-touch files (STOP, config.json) are out of scope: the former bypass
// the engine through host edit tools, the latter bypass it through the
// terminal and rebaseline.
import { createHmac, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { stateDir as defaultStateDir, factoryLayout } from "../layout.ts"
import { ensureEngineKey, readEngineKey } from "../research/seal.ts"
import { atomicWrite } from "../util/fs.ts"

/** Engine-owned files with sidecars, as paths relative to the project root. */
export function engineSignedFiles(root: string): string[] {
  return [factoryLayout(root).state]
}

export const sidecarFor = (file: string): string => `${file}.sig`

/**
 * Sign `file`'s current bytes (absolute path); replaces any old sidecar
 * atomically, so a reader outside the state lock never sees a torn one.
 */
export async function signEngineFile(file: string, stateDir?: string): Promise<void> {
  const key = await ensureEngineKey(stateDir ?? defaultStateDir())
  const bytes = await readFile(file)
  await atomicWrite(sidecarFor(file), `${createHmac("sha256", key).update(bytes).digest("hex")}\n`)
}

/**
 * "missing engine key": the file has a sidecar but this process cannot see
 * the engine key (an agent sandbox masks the state dir, or another state dir
 * is in use); nothing about the file itself is known to be wrong.
 */
export type SidecarProblem = "missing sidecar" | "signature mismatch" | "missing engine key"

/** Verify `file` against its sidecar; undefined means the seal holds. Never creates the engine key. */
export async function verifyEngineFile(file: string, stateDir?: string): Promise<SidecarProblem | undefined> {
  const [bytes, raw] = await Promise.all([
    readFile(file).catch(() => undefined),
    readFile(sidecarFor(file), "utf8").catch(() => undefined),
  ])
  if (bytes === undefined || raw === undefined) return "missing sidecar"
  const key = await readEngineKey(stateDir ?? defaultStateDir())
  if (!key) return "missing engine key"
  let presented: Buffer
  try {
    presented = Buffer.from(raw.trim(), "hex")
  } catch {
    return "signature mismatch"
  }
  const expected = Buffer.from(createHmac("sha256", key).update(bytes).digest("hex"), "hex")
  return presented.length === expected.length && timingSafeEqual(presented, expected) ? undefined : "signature mismatch"
}
