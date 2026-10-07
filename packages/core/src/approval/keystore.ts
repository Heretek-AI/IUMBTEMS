// The human key (1.1.1). Approvals, waivers, trust entries and research briefs
// are signed with an Ed25519 key whose private half is sealed by a passphrase
// only the human knows (scrypt + AES-256-GCM). The plugin and the verifiers
// check signatures with the public half, so nothing needs the passphrase to
// verify, and an agent that reads the sealed file, or drives the CLI through
// a PTY, still cannot sign. 1.0/1.1.0 records were MACed with a plain HMAC key
// that agents could read; they are refused and must be re-recorded.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  scrypt,
  sign,
  verify,
} from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"
import { stateDir } from "../layout.ts"
import { canonicalJson } from "../util/hash.ts"

const SEALED_FILE = "human.key"
const PUBLIC_FILE = "human.pub"
/** A passphrase shorter than this is refused at seal time. */
export const MIN_PASSPHRASE = 10
// scrypt cost: 2^16 × 8 × 1 needs 64 MiB and about a quarter second per unlock.
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const

export class HumanKeyError extends Error {}

/** A signature on a human record. */
export interface RecordSignature {
  readonly alg: "ed25519"
  readonly keyId: string
  readonly sig: string
}

/** The unlocked human key, held only while a human action runs. */
export interface HumanSigner {
  readonly keyId: string
  sign(record: Record<string, unknown>): RecordSignature
}

interface SealedKey {
  readonly version: 1
  readonly alg: "ed25519"
  readonly keyId: string
  readonly kdf: {
    readonly name: "scrypt"
    readonly N: number
    readonly r: number
    readonly p: number
    readonly salt: string
  }
  readonly cipher: { readonly name: "aes-256-gcm"; readonly iv: string; readonly tag: string }
  readonly data: string
}

/** What a record's signature covers: everything but the signature (and a legacy mac). */
const signedBody = (record: Record<string, unknown>) => {
  const { signature: _signature, mac: _mac, ...body } = record
  return Buffer.from(canonicalJson(body))
}

const keyIdOf = (publicKey: KeyObject) =>
  createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16)

const derive = (passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(passphrase.normalize("NFKC"), salt, 32, { ...params, maxmem: SCRYPT.maxmem }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  )

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8")
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

/** Whether this machine holds a sealed human key (`es key seal` has run). */
export async function hasHumanKey(dir = stateDir()): Promise<boolean> {
  return (await readText(path.join(dir, SEALED_FILE))) !== undefined
}

async function publicKey(dir: string): Promise<KeyObject | undefined> {
  const pem = await readText(path.join(dir, PUBLIC_FILE))
  return pem === undefined ? undefined : createPublicKey(pem)
}

/** Public fingerprint of the human key, or undefined when none is sealed yet. */
export async function humanKeyId(dir = stateDir()): Promise<string | undefined> {
  const key = await publicKey(dir)
  return key ? keyIdOf(key) : undefined
}

const NO_KEY =
  "no passphrase-sealed human key on this machine: run `es key seal` once at a terminal (1.1.1 replaced the old approval key; earlier approvals, waivers and trust must be recorded again)"

/** Create the human key pair, sealed by `passphrase`. Refuses if one exists (never adopts a planted file). */
export async function sealHumanKey(passphrase: string, dir = stateDir()): Promise<{ keyId: string }> {
  if (passphrase.length < MIN_PASSPHRASE)
    throw new HumanKeyError(`the passphrase must be at least ${MIN_PASSPHRASE} characters`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const pair = generateKeyPairSync("ed25519")
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await derive(passphrase, salt, SCRYPT)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([cipher.update(pair.privateKey.export({ type: "pkcs8", format: "der" })), cipher.final()])
  const keyId = keyIdOf(pair.publicKey)
  const sealed: SealedKey = {
    version: 1,
    alg: "ed25519",
    keyId,
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    data: data.toString("base64"),
  }
  // Exclusive creates: a key that already exists (or was planted) is never replaced silently.
  for (const [name, text] of [
    [SEALED_FILE, `${JSON.stringify(sealed, null, 2)}\n`],
    [PUBLIC_FILE, pair.publicKey.export({ type: "spki", format: "pem" }).toString()],
  ] as const) {
    try {
      const handle = await open(path.join(dir, name), "wx", 0o600)
      await handle.writeFile(text)
      await handle.close()
    } catch (error: any) {
      if (error?.code === "EEXIST")
        throw new HumanKeyError(
          `${path.join(dir, name)} already exists: this machine already has a human key (remove ${SEALED_FILE} and ${PUBLIC_FILE} by hand to replace it, then re-record approvals)`,
        )
      throw error
    }
  }
  return { keyId }
}

/** Unlock the human key with its passphrase. A wrong passphrase fails the AES-GCM tag check. */
export async function unlockHumanKey(passphrase: string, dir = stateDir()): Promise<HumanSigner> {
  const text = await readText(path.join(dir, SEALED_FILE))
  if (text === undefined) throw new HumanKeyError(NO_KEY)
  const sealed = JSON.parse(text) as SealedKey
  const pub = await publicKey(dir)
  if (!pub || keyIdOf(pub) !== sealed.keyId)
    throw new HumanKeyError(`${PUBLIC_FILE} does not match the sealed key (tampered or partial); re-seal by hand`)
  let privateKey: KeyObject
  try {
    const key = await derive(passphrase, Buffer.from(sealed.kdf.salt, "base64"), sealed.kdf)
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.cipher.iv, "base64"))
    decipher.setAuthTag(Buffer.from(sealed.cipher.tag, "base64"))
    const der = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()])
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" })
  } catch {
    throw new HumanKeyError("wrong passphrase")
  }
  return {
    keyId: sealed.keyId,
    sign: (record) => ({
      alg: "ed25519",
      keyId: sealed.keyId,
      sig: sign(null, signedBody(record), privateKey).toString("base64"),
    }),
  }
}

/** Whether `record.signature` is a valid signature by this machine's human key. */
export async function verifyRecordSignature(record: Record<string, unknown>, dir = stateDir()): Promise<boolean> {
  const signature = record.signature as Partial<RecordSignature> | undefined
  if (signature?.alg !== "ed25519" || typeof signature.sig !== "string") return false
  const pub = await publicKey(dir)
  if (!pub || signature.keyId !== keyIdOf(pub)) return false
  try {
    return verify(null, signedBody(record), pub, Buffer.from(signature.sig, "base64"))
  } catch {
    return false
  }
}

/** Why a record does not verify, phrased for a human (legacy HMAC records get the re-record hint). */
export async function signatureProblem(
  record: Record<string, unknown>,
  what: string,
  dir = stateDir(),
): Promise<string | undefined> {
  if (await verifyRecordSignature(record, dir)) return undefined
  if (typeof record.mac === "string" && record.signature === undefined)
    return `${what} was signed by the pre-1.1.1 approval key, which agents could read; record it again (a human, at a terminal, with the passphrase)`
  if (!(await hasHumanKey(dir))) return `${what} cannot be verified: ${NO_KEY}`
  return `${what} is not signed by this machine's human key (forged, tampered or foreign)`
}

/** A short code a human must type back to confirm a non-signing action (CLI/TUI). */
export function confirmationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = randomBytes(6)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
}
