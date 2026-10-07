// Waivers are requested by agents but granted only by a human through the
// CLI (TTY) or TUI dialog. Records are HMAC-signed like approvals; unsigned,
// malformed or expired waivers are ignored and reported.
import { readdir, readFile } from "node:fs/promises"
import { hostname, userInfo } from "node:os"
import path from "node:path"
import { signRecord, verifyRecordMac } from "../approval/keystore.ts"
import { appendAuditEntry, auditHead } from "../audit/chain.ts"
import { factoryLayout, stateDir } from "../layout.ts"
import type { GateFinding } from "../schema/gates.ts"
import { isWaiverActive, type Waiver, WaiverSchema } from "../schema/waiver.ts"
import { rebaseline } from "../trust/control.ts"
import { writeJson } from "../util/fs.ts"
import { matchGlob } from "../util/glob.ts"

export interface RecordWaiverInput {
  readonly id: string
  readonly rule: string
  readonly files?: string
  readonly reason: string
  readonly expiresAt: Date
  readonly channel: "cli" | "tui"
  readonly approvedBy?: string
  readonly stateDir?: string
}

const MAX_WAIVER_DAYS = 90

export async function recordWaiver(root: string, input: RecordWaiverInput): Promise<Waiver> {
  const now = Date.now()
  if (input.expiresAt.getTime() <= now) throw new Error("A waiver must expire in the future.")
  if (input.expiresAt.getTime() - now > MAX_WAIVER_DAYS * 86_400_000)
    throw new Error(`Waivers last at most ${MAX_WAIVER_DAYS} days.`)
  const unsigned = {
    version: 1 as const,
    id: input.id,
    rule: input.rule,
    files: input.files ?? "**",
    reason: input.reason,
    approvedBy: input.approvedBy ?? userInfo().username,
    approvedAt: new Date(now).toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    channel: input.channel,
    auditHead: await auditHead(root),
  }
  const waiver = WaiverSchema.parse({ ...unsigned, mac: await signRecord(unsigned, input.stateDir ?? stateDir()) })
  await writeJson(path.join(factoryLayout(root).waivers, `${waiver.id}.json`), waiver)
  await appendAuditEntry(root, {
    actor: `human:${waiver.approvedBy}@${hostname()}`,
    action: "waiver.grant",
    payload: { id: waiver.id, rule: waiver.rule, files: waiver.files, expiresAt: waiver.expiresAt },
  })
  await rebaseline(root, `human:${waiver.approvedBy}`)
  return waiver
}

export interface LoadedWaivers {
  readonly active: Waiver[]
  readonly problems: GateFinding[]
}

export async function loadWaivers(
  root: string,
  options: { stateDir?: string; now?: Date } = {},
): Promise<LoadedWaivers> {
  const dir = factoryLayout(root).waivers
  const active: Waiver[] = []
  const problems: GateFinding[] = []
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json"))
  } catch {
    return { active, problems }
  }
  for (const name of names) {
    const file = `.factory/waivers/${name}`
    const problem = (message: string) =>
      problems.push({ file, rule: "waiver/invalid", severity: "warning", message, check: "waivers" })
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(await readFile(path.join(dir, name), "utf8"))
    } catch {
      problem("not valid JSON; ignored")
      continue
    }
    const parsed = WaiverSchema.safeParse(raw)
    if (!parsed.success) {
      problem("malformed waiver; ignored")
      continue
    }
    if (!(await verifyRecordMac(raw, options.stateDir ?? stateDir()))) {
      problem("not signed by this machine's approval key; ignored (waivers are granted with `es waive`)")
      continue
    }
    if (!isWaiverActive(parsed.data, options.now)) continue
    active.push(parsed.data)
  }
  return { active, problems }
}

export function isWaived(finding: GateFinding, waivers: readonly Waiver[]): boolean {
  return waivers.some((waiver) => matchGlob(finding.rule, waiver.rule) && matchGlob(finding.file, waiver.files))
}
