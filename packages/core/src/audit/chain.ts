// Append-only, hash-chained audit log (.factory/runtime/audit.jsonl). Each
// entry hashes its predecessor, so edits and reordering are detectable; the
// head is anchored in every approval record, so truncating the tail past an
// approval is detectable too.
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { factoryLayout } from "../layout.ts"
import { type AuditEntry, AuditEntrySchema } from "../schema/audit.ts"
import { withLock } from "../util/fs.ts"
import { canonicalJson, sha256 } from "../util/hash.ts"

const GENESIS_HASH = "0".repeat(64)

export interface NewAuditInput {
  /** "system", "human:<user>" or "agent:<agentID>". */
  readonly actor: string
  readonly action: string
  readonly payload?: Record<string, unknown>
}

const entryHash = (entry: Omit<AuditEntry, "hash">) =>
  sha256(
    canonicalJson({
      seq: entry.seq,
      timestamp: entry.timestamp,
      prevHash: entry.prevHash,
      actor: entry.actor,
      action: entry.action,
      payload: entry.payload,
    }),
  )

async function readLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean)
  } catch (error: any) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

export async function appendAuditEntry(root: string, input: NewAuditInput): Promise<AuditEntry> {
  const file = factoryLayout(root).audit
  await mkdir(path.dirname(file), { recursive: true })
  return withLock(file, async () => {
    const lines = await readLines(file)
    const last = lines.length ? AuditEntrySchema.parse(JSON.parse(lines.at(-1)!)) : undefined
    const draft = {
      seq: last ? last.seq + 1 : 0,
      timestamp: new Date().toISOString(),
      prevHash: last ? last.hash : GENESIS_HASH,
      actor: input.actor,
      action: input.action,
      payload: input.payload ?? {},
    }
    const entry: AuditEntry = { ...draft, hash: entryHash(draft) }
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8")
    return entry
  })
}

export async function auditHead(root: string): Promise<{ seq: number; hash: string } | null> {
  const lines = await readLines(factoryLayout(root).audit)
  if (!lines.length) return null
  const last = AuditEntrySchema.parse(JSON.parse(lines.at(-1)!))
  return { seq: last.seq, hash: last.hash }
}

export interface VerifyChainResult {
  readonly valid: boolean
  readonly entries: readonly AuditEntry[]
  readonly error?: string
}

/** Anchors recorded in approval/waiver records: {seq, hash} pairs the chain must still contain. */
async function anchors(root: string): Promise<Array<{ source: string; seq: number; hash: string }>> {
  const layout = factoryLayout(root)
  const out: Array<{ source: string; seq: number; hash: string }> = []
  for (const dir of [layout.approvals, layout.waivers]) {
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      try {
        const record = JSON.parse(await readFile(path.join(dir, name), "utf8"))
        const head = record?.auditHead
        if (head && typeof head.seq === "number" && typeof head.hash === "string")
          out.push({ source: path.join(path.basename(dir), name), seq: head.seq, hash: head.hash })
      } catch {
        // Malformed records are reported by their own verifiers.
      }
    }
  }
  return out
}

export async function verifyAuditChain(root: string): Promise<VerifyChainResult> {
  const lines = await readLines(factoryLayout(root).audit)
  const entries: AuditEntry[] = []
  let prevHash = GENESIS_HASH
  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry
    try {
      entry = AuditEntrySchema.parse(JSON.parse(lines[i]!))
    } catch (error: any) {
      return { valid: false, entries, error: `corrupt entry at line ${i + 1}: ${error.message}` }
    }
    if (entry.seq !== i) return { valid: false, entries, error: `sequence gap at line ${i + 1}` }
    if (entry.prevHash !== prevHash) return { valid: false, entries, error: `chain broken at line ${i + 1}` }
    if (entryHash(entry) !== entry.hash) return { valid: false, entries, error: `entry ${i} was modified` }
    prevHash = entry.hash
    entries.push(entry)
  }
  for (const anchor of await anchors(root)) {
    const entry = entries[anchor.seq]
    if (!entry) return { valid: false, entries, error: `log truncated: ${anchor.source} anchors seq ${anchor.seq}` }
    if (entry.hash !== anchor.hash)
      return { valid: false, entries, error: `log rewritten: ${anchor.source} anchors a different entry ${anchor.seq}` }
  }
  return { valid: true, entries }
}
