// The signing key that makes approval and waiver records unforgeable by
// anything that cannot read the user-global state dir (agents are denied that
// dir by policy). Created on first use with mode 0600.
import { createHmac, randomBytes } from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"
import { stateDir } from "../layout.ts"
import { canonicalJson } from "../util/hash.ts"

async function loadOrCreateKey(dir: string): Promise<Buffer> {
  const file = path.join(dir, "key")
  const existing = await readKey(file)
  if (existing) return existing
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const key = randomBytes(32)
  try {
    const handle = await open(file, "wx", 0o600)
    await handle.writeFile(key.toString("hex"))
    await handle.close()
    return key
  } catch (error: any) {
    // Another process created it first: use theirs.
    if (error?.code === "EEXIST") {
      const raced = await readKey(file)
      if (raced) return raced
    }
    throw error
  }
}

async function readKey(file: string): Promise<Buffer | undefined> {
  try {
    return Buffer.from((await readFile(file, "utf8")).trim(), "hex")
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

export async function signRecord(record: Record<string, unknown>, dir = stateDir()): Promise<string> {
  const key = await loadOrCreateKey(dir)
  const { mac: _ignored, ...body } = record
  return createHmac("sha256", key).update(canonicalJson(body)).digest("hex")
}

export async function verifyRecordMac(record: Record<string, unknown>, dir = stateDir()): Promise<boolean> {
  if (typeof record.mac !== "string") return false
  const expected = await signRecord(record, dir)
  return timingSafeEqualHex(expected, record.mac)
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** A short code a human must type back to confirm an approval (CLI/TUI). */
export function confirmationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = randomBytes(6)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
}
