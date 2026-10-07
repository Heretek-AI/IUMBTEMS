// The signing key that makes approval and waiver records unforgeable by
// anything that cannot read the user-global state dir (agents are denied that
// dir by policy). Created on first use with mode 0600.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
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

/** Whether this machine already holds a signing key (verifiers must not mint one). */
export async function hasSigningKey(dir = stateDir()): Promise<boolean> {
  return (await readKey(path.join(dir, "key"))) !== undefined
}

/** Public fingerprint of the signing key, so a verifier can tell "not my key" from "tampered". */
export async function signingKeyId(dir = stateDir()): Promise<string> {
  const key = await loadOrCreateKey(dir)
  return createHmac("sha256", key).update("epistemic-swarm key id").digest("hex").slice(0, 16)
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
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** A short code a human must type back to confirm an approval (CLI/TUI). */
export function confirmationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = randomBytes(6)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
}
