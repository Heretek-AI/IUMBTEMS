import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { type AuditEntry, AuditEntrySchema } from "../schema/audit.ts"
import { withLock } from "../util/fs.ts"
import { canonicalJson, sha256 } from "../util/hash.ts"

const GENESIS_HASH = "0".repeat(64)

export interface NewAuditInput {
  readonly actor: string
  readonly action: string
  readonly payload?: Record<string, unknown>
}

export async function appendAuditEntry(rootDir: string, input: NewAuditInput): Promise<AuditEntry> {
  const factoryDir = path.join(rootDir, ".factory")
  await mkdir(factoryDir, { recursive: true })
  const logFile = path.join(factoryDir, "audit.jsonl")
  const lockFile = path.join(factoryDir, ".audit.lock")

  return withLock(lockFile, async () => {
    let prevHash = GENESIS_HASH
    let seq = 0

    try {
      const existing = await readFile(logFile, "utf8")
      const lines = existing.trim().split("\n").filter(Boolean)
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1]
        if (lastLine) {
          const lastEntry = AuditEntrySchema.parse(JSON.parse(lastLine))
          seq = lastEntry.seq + 1
          prevHash = lastEntry.hash
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err
    }

    const timestamp = new Date().toISOString()
    const payload = input.payload ?? {}

    const payloadForHash = {
      seq,
      timestamp,
      prevHash,
      actor: input.actor,
      action: input.action,
      payload,
    }
    const hash = sha256(canonicalJson(payloadForHash))

    const entry: AuditEntry = {
      seq,
      timestamp,
      prevHash,
      actor: input.actor,
      action: input.action,
      payload,
      hash,
    }

    await appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8")
    return entry
  })
}

export interface VerifyChainResult {
  readonly valid: boolean
  readonly entries: readonly AuditEntry[]
  readonly error?: string
}

export async function verifyAuditChain(rootDir: string): Promise<VerifyChainResult> {
  const logFile = path.join(rootDir, ".factory", "audit.jsonl")
  let content = ""
  try {
    content = await readFile(logFile, "utf8")
  } catch (err: any) {
    if (err.code === "ENOENT") return { valid: true, entries: [] }
    throw err
  }

  const lines = content.trim().split("\n").filter(Boolean)
  const entries: AuditEntry[] = []

  let prevHash = GENESIS_HASH
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    let parsed: AuditEntry
    try {
      parsed = AuditEntrySchema.parse(JSON.parse(line))
    } catch (err: any) {
      return {
        valid: false,
        entries,
        error: `Corrupt JSON/schema at line ${i + 1}: ${err.message}`,
      }
    }

    if (parsed.seq !== i) {
      return {
        valid: false,
        entries,
        error: `Sequence mismatch at line ${i + 1}: expected ${i}, found ${parsed.seq}`,
      }
    }

    if (parsed.prevHash !== prevHash) {
      return {
        valid: false,
        entries,
        error: `Hash chain broken at line ${i + 1}: expected prevHash ${prevHash}, found ${parsed.prevHash}`,
      }
    }

    const payloadForHash = {
      seq: parsed.seq,
      timestamp: parsed.timestamp,
      prevHash: parsed.prevHash,
      actor: parsed.actor,
      action: parsed.action,
      payload: parsed.payload,
    }
    const computedHash = sha256(canonicalJson(payloadForHash))
    if (computedHash !== parsed.hash) {
      return {
        valid: false,
        entries,
        error: `Hash forgery detected at line ${i + 1}: expected ${computedHash}, found ${parsed.hash}`,
      }
    }

    prevHash = parsed.hash
    entries.push(parsed)
  }

  return { valid: true, entries }
}
