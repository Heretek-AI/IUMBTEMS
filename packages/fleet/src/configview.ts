// Config preview + browser apply (#132 preview, #145 apply): the browser
// edits project config and gates against strict-schema validation with
// exact hash diffs. Previewing (`get`/`plan`) reads only. Applying writes
// project-config bytes only, and only through the ticketed human path
// below: a preview-bound single-use ticket (I3) plus the passphrase and
// the CSRF/Origin checks reused from #131 (I1/I2/I4/I6/I8). Gates content
// stays terminal-only (I7) — `request` and `apply` both refuse it. There
// is deliberately no `fleet.config.apply` RPC method: the bus must keep
// refusing it with "unknown method" so no agent or MCP tool can reach the
// write (I6); the HTTP route (wired by the daemon bus from `web.ts`) calls
// `applyConfigEdit` with the session CSRF and Origin it already checked
// for approvals.
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import {
  appendAuditEntry,
  checkApprovalAttempts,
  EsConfigSchema,
  factoryLayout,
  GatesConfigSchema,
  globalConfigFile,
  mergeConfig,
  noteApprovalSuccess,
  noteWrongPassphrase,
  PROJECT_FORBIDDEN_KEYS,
  rebaseline,
  unlockHumanKey,
  verifyControl,
  withLock,
  writeJson,
} from "@heretek-ai/es-core"
import { CONFIG_TICKET_TTL_MS, type CsrfTokens } from "./approve.ts"
import { fleetPaths } from "./state.ts"
import { assertConfigHumanEnv, configApplyOriginOk } from "./web.ts"

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex")
/** Canonical bytes `writeJson` would emit: the previewed hash is exact. */
const canon = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

export interface ConfigDrift {
  readonly clean: boolean
  readonly violations: readonly string[]
  readonly hasBaseline: boolean
}

export interface ConfigView {
  readonly config: Record<string, unknown> | null
  readonly configHash: string | null
  readonly gates: Record<string, unknown> | null
  readonly gatesHash: string | null
  readonly drift: ConfigDrift
  readonly forbidden: readonly string[]
}

const readBytes = (file: string): Promise<Buffer | null> =>
  readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === "ENOENT") return null
    throw error
  })

const asObject = (bytes: Buffer, file: string): Record<string, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error(`${file} is not valid JSON; fix it by hand before previewing.`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} must hold a JSON object.`)
  return parsed as Record<string, unknown>
}

const readLayerFile = async (
  file: string,
): Promise<{ content: Record<string, unknown> | null; hash: string | null }> => {
  const bytes = await readBytes(file)
  if (!bytes) return { content: null, hash: null }
  return { content: asObject(bytes, file), hash: sha256(bytes) }
}

/** Read the project config and gates layers, their hashes and drift. Reads only. */
export async function readConfigView(repoRoot: string): Promise<ConfigView> {
  const layout = factoryLayout(repoRoot)
  const [config, gates, drift] = await Promise.all([
    readLayerFile(layout.config),
    readLayerFile(layout.gates),
    verifyControl(repoRoot),
  ])
  return {
    config: config.content,
    configHash: config.hash,
    gates: gates.content,
    gatesHash: gates.hash,
    drift: { clean: drift.clean, violations: [...drift.violations], hasBaseline: drift.hasBaseline },
    forbidden: [...PROJECT_FORBIDDEN_KEYS],
  }
}

export interface ConfigPlanInput {
  readonly file: "config" | "gates"
  readonly content: unknown
}

export interface ConfigPlan {
  readonly ok: boolean
  readonly errors: readonly string[]
  /** Hash of the current file bytes (null when the file is absent). */
  readonly oldHash: string | null
  /** Exact hash the file would have after applying (null when invalid). */
  readonly newHash: string | null
  readonly changedKeys: readonly string[]
  /** Exact terminal commands that apply the preview (empty unless ok and changed). */
  readonly commands: readonly string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const changedKeysOf = (before: Record<string, unknown>, after: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort((a, b) => a.localeCompare(b))

const forbiddenHit = (key: string): string | undefined =>
  PROJECT_FORBIDDEN_KEYS.find((forbidden) => key === forbidden || key.startsWith(`${forbidden}.`))

/**
 * Validate proposed file content and preview the change. Pure: reads the
 * current layers for the diff, writes nothing.
 */
export async function planConfigFile(
  repoRoot: string,
  input: ConfigPlanInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigPlan> {
  const layout = factoryLayout(repoRoot)
  const fail = (errors: readonly string[], oldHash: string | null): ConfigPlan => ({
    ok: false,
    errors,
    oldHash,
    newHash: null,
    changedKeys: [],
    commands: [],
  })
  if (!isObject(input.content)) return fail(["content must be a JSON object"], null)
  const proposed = input.content
  if (input.file === "gates") {
    const [currentFile, oldBytes] = await Promise.all([readLayerFile(layout.gates), readBytes(layout.gates)])
    const current = currentFile.content ?? {}
    const oldHash = oldBytes ? sha256(oldBytes) : null
    const parsed = GatesConfigSchema.safeParse(proposed)
    if (!parsed.success)
      return fail(
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
        oldHash,
      )
    const changed = changedKeysOf(current, proposed)
    return {
      ok: true,
      errors: [],
      oldHash: oldBytes ? sha256(oldBytes) : null,
      newHash: sha256(canon(proposed)),
      changedKeys: changed,
      commands: changed.length ? ["# save the previewed JSON to .factory/gates.json", "es rebaseline"] : [],
    }
  }
  const [project, globalRaw] = await Promise.all([readLayerFile(layout.config), readBytes(globalConfigFile(env))])
  const current = project.content ?? {}
  let globalLayer: Record<string, unknown> = {}
  if (globalRaw) {
    try {
      const parsed: unknown = JSON.parse(globalRaw.toString("utf8"))
      if (isObject(parsed)) globalLayer = parsed
    } catch {
      // An unreadable global layer fails validation below via the merge.
    }
  }
  const changed = changedKeysOf(current, proposed)
  const errors = changed
    .map((key) => forbiddenHit(key))
    .filter((hit) => hit !== undefined)
    .map((hit) => `"${hit}" may only be set in the global config, not the project file`)
  const merged = mergeConfig(globalLayer, proposed)
  const parsed = EsConfigSchema.safeParse(merged)
  if (!parsed.success)
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join(".") || "<root>"}: ${issue.message}`)
  if (errors.length) return fail(errors, project.hash)
  return {
    ok: true,
    errors: [],
    oldHash: project.hash,
    newHash: sha256(canon(proposed)),
    changedKeys: changed,
    commands: changed.map((key) => `es config set ${key} ${JSON.stringify(proposed[key])}`),
  }
}

// ------------------------------------------------------------------ browser apply (#145)

export const GATES_TERMINAL_ONLY =
  "gates edits stay terminal-only: run them in a terminal with `es rebaseline`; the browser applies project config only"

/** A mutating apply refusal: `status` mirrors the HTTP layer (403/409/423/400). */
export class ConfigApplyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "ConfigApplyError"
  }
}

export interface ConfigApplyTicket {
  readonly file: "config"
  readonly content: Record<string, unknown>
  readonly newHash: string
  readonly oldHash: string | null
}

/**
 * Preview-bound single-use tickets (I3, #131 semantics reused): redeeming
 * deletes the ticket whether it validates or not, so a failed attempt
 * cannot be retried on the same ticket — the human previews again.
 */
export class ConfigTickets {
  private readonly live = new Map<string, { entry: ConfigApplyTicket; exp: number }>()

  constructor(private readonly ttlMs: number = CONFIG_TICKET_TTL_MS) {}

  issue(entry: ConfigApplyTicket): string {
    this.purge()
    const ticket = randomBytes(32).toString("hex")
    this.live.set(ticket, { entry, exp: Date.now() + this.ttlMs })
    return ticket
  }

  /** Single-use claim: the ticket dies on redeem, valid or not. */
  redeem(ticket: string): ConfigApplyTicket | undefined {
    const found = this.live.get(ticket)
    this.live.delete(ticket)
    if (!found || found.exp <= Date.now()) return undefined
    return found.entry
  }

  private purge(): void {
    const now = Date.now()
    for (const [ticket, record] of this.live) if (record.exp <= now) this.live.delete(ticket)
  }
}

/**
 * Validate a project-config preview and bind it to a single-use ticket.
 * Gates content is refused here (terminal-only, I7) and invalid content
 * never mints a ticket.
 */
export async function requestConfigTicket(
  repoRoot: string,
  input: { readonly file: "config" | "gates"; readonly content: unknown },
  tickets: ConfigTickets,
): Promise<{ readonly ticket: string; readonly newHash: string; readonly oldHash: string | null }> {
  if (input.file !== "config") throw new ConfigApplyError(GATES_TERMINAL_ONLY, 403)
  if (!isObject(input.content)) throw new ConfigApplyError("content must be a JSON object", 400)
  const plan = await planConfigFile(repoRoot, { file: "config", content: input.content })
  if (!plan.ok || plan.newHash === null) throw new ConfigApplyError(`invalid config: ${plan.errors.join("; ")}`, 400)
  const ticket = tickets.issue({
    file: "config",
    content: input.content,
    newHash: plan.newHash,
    oldHash: plan.oldHash,
  })
  return { ticket, newHash: plan.newHash, oldHash: plan.oldHash }
}

export interface ConfigApplyCall {
  readonly repoRoot: string
  /** User state dir holding the sealed human key (passphrase check, I2). */
  readonly stateRoot: string
  readonly tickets: ConfigTickets
  /** Per-session CSRF tokens shared with the approval path (I6). */
  readonly csrfTokens: CsrfTokens
  readonly session: string
  readonly csrf: string | undefined
  readonly origin: string | undefined
  readonly ticket: string
  readonly file: "config" | "gates"
  readonly content: unknown
  /** Live-typed passphrase: never stored, logged or returned (I1). */
  readonly passphrase: string
  readonly env?: NodeJS.ProcessEnv
}

export interface ConfigApplyResult {
  readonly ok: true
  readonly file: "config"
  readonly newHash: string
  readonly oldHash: string | null
}

/**
 * Apply exactly the previewed project-config edit (I3): the ticket binds
 * the preview hash, and the write lands only when every guard passes, in
 * this order — sandbox (P6), gates scope (P8), Origin (P5), CSRF, attempt
 * budget (I4), ticket claim (P1–P3), hash re-derivation plus staleness
 * (P4), passphrase (P7) — then write, re-pin and audit (P9). Transport
 * refusals happen before the ticket is looked at, so the ticket survives
 * them; the claim itself is single-use, so a failed auth still consumes
 * it. Throws ConfigApplyError; never echoes the passphrase.
 */
export async function applyConfigEdit(call: ConfigApplyCall): Promise<ConfigApplyResult> {
  try {
    assertConfigHumanEnv(call.env ?? process.env)
  } catch (error) {
    throw new ConfigApplyError(error instanceof Error ? error.message : String(error), 403)
  }
  if (call.file !== "config") throw new ConfigApplyError(GATES_TERMINAL_ONLY, 403)
  if (!configApplyOriginOk(call.origin))
    throw new ConfigApplyError("refused: the config apply must be opened on loopback with a loopback Origin", 403)
  if (!call.csrfTokens.check(call.session, call.csrf))
    throw new ConfigApplyError("refused: missing or wrong CSRF token; preview again", 403)
  const webDir = path.join(fleetPaths(call.stateRoot).dir, "web-config")
  await mkdir(webDir, { recursive: true })
  const attempts = await checkApprovalAttempts(webDir)
  if (!attempts.allowed)
    throw new ConfigApplyError("too many wrong passphrases", 423, { retryAfterSec: attempts.retryAfterSec })
  const entry = call.tickets.redeem(call.ticket)
  if (!entry) throw new ConfigApplyError("unknown or expired ticket; preview again", 403)
  if (!isObject(call.content)) throw new ConfigApplyError("content must be a JSON object", 400)
  if (sha256(canon(call.content)) !== entry.newHash)
    throw new ConfigApplyError(
      "the preview is stale: the submitted content differs from the previewed edit; preview again",
      409,
    )
  const plan = await planConfigFile(call.repoRoot, { file: "config", content: call.content })
  if (!plan.ok || plan.newHash === null) throw new ConfigApplyError(`invalid config: ${plan.errors.join("; ")}`, 400)
  if (plan.newHash !== entry.newHash || plan.oldHash !== entry.oldHash)
    throw new ConfigApplyError("the preview is stale: the config changed since the preview; preview again", 409)
  let signer: Awaited<ReturnType<typeof unlockHumanKey>>
  try {
    signer = await unlockHumanKey(call.passphrase, call.stateRoot)
  } catch {
    const check = await noteWrongPassphrase({ dir: webDir, root: call.repoRoot, stage: "config", channel: "web" })
    if (check.allowed) throw new ConfigApplyError("wrong passphrase", 403, { remaining: check.remaining })
    throw new ConfigApplyError("too many wrong passphrases", 423, { retryAfterSec: check.retryAfterSec })
  }
  try {
    const layout = factoryLayout(call.repoRoot)
    await withLock(layout.config, async () => {
      const current = await readBytes(layout.config)
      const currentHash = current ? sha256(current) : null
      if (currentHash !== entry.oldHash)
        throw new ConfigApplyError("the preview is stale: the config changed since the preview; preview again", 409)
      await writeJson(layout.config, call.content)
    })
  } finally {
    signer.destroy()
  }
  await rebaseline(call.repoRoot, "human:web (browser config apply)")
  await noteApprovalSuccess(webDir)
  await appendAuditEntry(call.repoRoot, {
    actor: "human:web",
    action: "config.apply",
    payload: { file: "config", newHash: entry.newHash, channel: "web" },
  })
  return { ok: true, file: "config", newHash: entry.newHash, oldHash: entry.oldHash }
}
