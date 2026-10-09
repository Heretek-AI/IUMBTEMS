// Read-only telemetry bus (#126, clean-room): a localhost HTTP server in the
// daemon with a strict-schema JSON-RPC endpoint (`/fleet/rpc`) and a
// coalesced WebSocket event stream (`/fleet/ws`). Token auth, Host and Origin
// checks, monotonic backlog replay, payload scrubbing. No dependencies
// beyond core: the WebSocket framing is a small purpose-built implementation
// (text frames only) rather than a new runtime dependency.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import path from "node:path"
import {
  approvalSubject,
  approveStage,
  checkApprovalAttempts,
  hashJson,
  noteApprovalSuccess,
  noteWrongPassphrase,
  pendingApprovals,
  unlockHumanKey,
  withLock,
} from "@heretek-ai/es-core"
import { z } from "zod"
import { ApproveTickets, CsrfTokens } from "./approve.ts"
import { planConfigFile, readConfigView } from "./configview.ts"
import { exportEvidence, readEvidenceClaim, readEvidenceClaims, readEvidenceSource } from "./evidence.ts"
import { readTaskLiveness } from "./liveness.ts"
import { fleetPaths } from "./state.ts"
import {
  loopbackOriginOk,
  parseSessionCookie,
  redeemWebTicket,
  resolveWebFile,
  sessionSetCookie,
  WEB_SECURITY_HEADERS,
  WebSessions,
} from "./web.ts"
import { loadRegistry } from "./worktree.ts"

export interface BusEvent {
  readonly seq: number
  readonly at: string
  readonly type: "changed" | "liveness"
  readonly payload: Record<string, unknown>
}

type BusChannel = BusEvent["type"]

/**
 * Append-only event log with monotonic sequence numbers, persisted as JSONL
 * (survives daemon restarts; replays from any `since`). Listeners fire
 * synchronously per append for the live stream; persistence follows in the
 * background, so a burst of appends never races a replay read.
 */
export class EventLog {
  private seq = 0
  private readonly listeners = new Set<(event: BusEvent) => void>()

  constructor(private readonly file: string) {}

  /** Catch the sequence up with the persisted log (restarts). */
  async load(): Promise<void> {
    try {
      const text = await readFile(this.file, "utf8")
      for (const line of text.split("\n")) {
        if (!line.trim()) continue
        try {
          const seq = (JSON.parse(line) as { seq?: unknown }).seq
          if (typeof seq === "number" && seq > this.seq) this.seq = seq
        } catch {}
      }
    } catch {
      // Missing log starts at zero.
    }
  }

  static async open(stateRoot: string): Promise<EventLog> {
    const log = new EventLog(path.join(fleetPaths(stateRoot).dir, "events.jsonl"))
    await log.load()
    return log
  }

  /** All persisted events in seq order (restart replay). */
  async readAll(): Promise<BusEvent[]> {
    const found: BusEvent[] = []
    try {
      const text = await readFile(this.file, "utf8")
      for (const line of text.split("\n")) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as Partial<BusEvent>
          if (typeof parsed.seq === "number" && (parsed.type === "changed" || parsed.type === "liveness"))
            found.push({
              seq: parsed.seq,
              at: typeof parsed.at === "string" ? parsed.at : "",
              type: parsed.type,
              payload: (parsed.payload ?? {}) as Record<string, unknown>,
            })
        } catch {}
      }
    } catch {
      // Missing log replays as empty.
    }
    return found.sort((a, b) => a.seq - b.seq)
  }

  onAppend(listener: (event: BusEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async append(type: BusChannel, payload: Record<string, unknown>): Promise<BusEvent> {
    const event = this.emit(type, payload)
    await mkdir(path.dirname(this.file), { recursive: true }).catch(() => undefined)
    await appendFile(this.file, `${JSON.stringify(event)}\n`).catch(() => undefined)
    return event
  }

  /** Hot-path variant: listeners fire now, persistence follows unattended. */
  appendSync(type: BusChannel, payload: Record<string, unknown>): BusEvent {
    const event = this.emit(type, payload)
    void mkdir(path.dirname(this.file), { recursive: true })
      .then(() => appendFile(this.file, `${JSON.stringify(event)}\n`))
      .catch(() => undefined)
    return event
  }

  private emit(type: BusChannel, payload: Record<string, unknown>): BusEvent {
    this.seq += 1
    const event: BusEvent = { seq: this.seq, at: new Date().toISOString(), type, payload }
    for (const listener of [...this.listeners]) listener(event)
    return event
  }
}

const SECRET_KEY = /(passphrase|secret|token|password|passwd|credential|private[_-]?key|seed|bearer|authorization)/i

/**
 * Scrub a payload: secret-named keys become "[redacted]", and any string
 * containing a known secret value (>= 8 chars) is redacted wholesale.
 */
export function scrubPayload(value: unknown, secrets: readonly string[]): unknown {
  const live = secrets.filter((secret) => secret.length >= 8)
  const scrubString = (text: string): string => {
    if (SECRET_KEY.test(text) && text.length < 64 && /^[A-Za-z0-9\-_=.+/]+$/.test(text) && live.includes(text))
      return "[redacted]"
    return live.some((secret) => text.includes(secret)) ? "[redacted]" : text
  }
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return scrubString(node)
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(node as Record<string, unknown>))
        out[key] = SECRET_KEY.test(key) ? "[redacted]" : walk(entry)
      return out
    }
    return node
  }
  return walk(value)
}

/** Bearer token for the bus: created once at 0600 in the masked state dir. */
export async function ensureToken(stateRoot: string): Promise<string> {
  const paths = fleetPaths(stateRoot)
  return withLock(paths.lock, async () => {
    try {
      const current = (await readFile(paths.token, "utf8")).trim()
      if (current.length >= 32) return current
    } catch {
      // Missing: create below.
    }
    await mkdir(path.dirname(paths.token), { recursive: true })
    const handle = await open(paths.token, "w", 0o600)
    try {
      const token = randomBytes(32).toString("hex")
      await handle.writeFile(`${token}\n`)
      return token
    } finally {
      await handle.close()
    }
  })
}

export interface SnapshotTask {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly ceilingUSD: number
  readonly spendUsd: number
  /** Dependency ids: the edges of the fleet DAG (#130 draws them). */
  readonly deps: readonly string[]
  readonly reason?: string
}

export interface FleetSnapshot {
  readonly daemon: {
    readonly running: boolean
    readonly pid: number | null
    readonly maxUsd: number | null
    readonly concurrency: number
  }
  readonly tasks: readonly SnapshotTask[]
  readonly spendUsd: number
  /** Tasks waiting on a human, with the stage to approve (#131 links here). */
  readonly pending: ReadonlyArray<{ readonly taskId: string; readonly reason: string; readonly stage: string }>
}

const StrictObject = (shape: Record<string, z.ZodTypeAny>) => z.strictObject(shape)

const RpcSchemas = {
  "fleet.status": StrictObject({}),
  "fleet.task": StrictObject({ id: z.string().min(1) }),
  /** Per-task run liveness (#130, feeds the web dashboard): read-only. */
  "fleet.task.liveness": StrictObject({ id: z.string().min(1) }),
  "fleet.pending": StrictObject({}),
  "fleet.events": StrictObject({ since: z.number().int().min(0).default(0) }),
  /** Read-only config preview (#132, preview-only): no apply method exists. */
  "fleet.config.get": StrictObject({}),
  "fleet.config.plan": StrictObject({ file: z.enum(["config", "gates"]), content: z.unknown() }),
  /** Read-only evidence reads (#133): claims, detail, sources, exports. */
  "evidence.claims": StrictObject({
    runId: z.string().min(1),
    filter: StrictObject({
      tag: z.string().optional(),
      status: z.string().optional(),
      tier: z.string().optional(),
      text: z.string().optional(),
    }).optional(),
  }),
  "evidence.claim": StrictObject({ runId: z.string().min(1), id: z.string().min(1) }),
  "evidence.source": StrictObject({ runId: z.string().min(1), sha: z.string().min(1) }),
  "evidence.export": StrictObject({ runId: z.string().min(1), format: z.enum(["markdown", "html"]) }),
} as const

type RpcMethod = keyof typeof RpcSchemas

export interface TelemetryOptions {
  readonly stateRoot: string
  /** 0 picks a free port (recorded to telemetry.json for `es-fleet watch`). */
  readonly port: number
  readonly token: string
  readonly getSnapshot: () => FleetSnapshot | Promise<FleetSnapshot>
  readonly secrets?: readonly string[]
  /**
   * Directory of the built web UI (#129). When set, `GET /` serves it
   * behind the single-use ticket exchange; when unset, web loads 404.
   */
  readonly webRoot?: string
  /**
   * Repo root the read-only config preview reads (#132). When unset,
   * `fleet.config.*` reports that no repo is configured.
   */
  readonly configRoot?: string
  /** Preview-ticket TTL override for tests (default 120 s, ADR 0002 I3). */
  readonly approveTicketTtlMs?: number
}

/**
 * Parse request header lines into a Map keyed by lowercase name (CodeQL #84,
 * repair-151 S5.4): remote names are never written as keys into a plain
 * object, so a header named `__proto__` stays a plain entry and cannot land
 * on the prototype. Names that are not RFC 9110 tokens are rejected.
 */
export function parseHeaders(lines: readonly string[]): Map<string, string> {
  const headers = new Map<string, string>()
  for (const line of lines) {
    const at = line.indexOf(":")
    if (at <= 0) continue
    const name = line.slice(0, at).trim().toLowerCase()
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)) continue
    headers.set(name, line.slice(at + 1).trim())
  }
  return headers
}

/** Case-insensitive request header lookup (names with dashes need no literals at use sites). */
export const field = (headers: Map<string, string>, name: string): string | undefined => headers.get(name.toLowerCase())

interface HttpResponder {
  writeHead(code: number, headers: Record<string, string | number>): void
  end(body?: string): void
}

const jsonBody = (res: HttpResponder, code: number, value: unknown): void => {
  const text = JSON.stringify(value)
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
  res.end(text)
}

const contentLengthOf = (header: string): number => {
  for (const line of header.split("\r\n").slice(1)) {
    const at = line.indexOf(":")
    if (at > 0 && line.slice(0, at).trim().toLowerCase() === "content-length") {
      const length = Number(line.slice(at + 1).trim())
      return Number.isInteger(length) && length >= 0 ? length : 0
    }
  }
  return 0
}

/**
 * The bus server. Bind, token, Host and Origin are all fail-closed. Every
 * JSON-RPC method is read-only (no state is written anywhere in RPC
 * handling); the browser approve endpoints are the deliberate exception —
 * preview issues single-use tickets and submit writes approvals.
 */
export class TelemetryServer {
  readonly log: EventLog
  private server: Server | undefined
  private actualPort = 0
  private readonly sessions = new WebSessions()
  private readonly approveTickets: ApproveTickets
  private readonly csrf = new CsrfTokens()
  private pending: Record<BusChannel, Map<string, BusEvent>> = { changed: new Map(), liveness: new Map() }
  private lastFlush: Record<BusChannel, number> = { changed: 0, liveness: 0 }
  private flushTimer: Record<BusChannel, ReturnType<typeof setTimeout> | undefined> = {
    changed: undefined,
    liveness: undefined,
  }
  private readonly sockets = new Set<{ socket: Socket; channels: Set<BusChannel>; buffer: Buffer }>()
  private events: BusEvent[] = []
  private closing = false

  constructor(private readonly options: TelemetryOptions) {
    this.log = new EventLog(path.join(fleetPaths(options.stateRoot).dir, "events.jsonl"))
    this.approveTickets = new ApproveTickets(options.approveTicketTtlMs)
  }

  get port(): number {
    return this.actualPort
  }

  get host(): string {
    return "127.0.0.1"
  }

  private secrets(): string[] {
    return [this.options.token, ...(this.options.secrets ?? [])]
  }

  async start(): Promise<void> {
    await this.log.load()
    this.events = await this.log.readAll()
    this.log.onAppend((event) => {
      this.events.push(event)
      this.stage(event)
    })
    this.server = createServer((socket) => void this.handleHttp(socket))
    this.server.on("clientError", (_error, socket) => socket.destroy())
    await new Promise<void>((resolve) => this.server!.listen(this.options.port, "127.0.0.1", resolve))
    this.actualPort = (this.server.address() as { port: number }).port
    const paths = fleetPaths(this.options.stateRoot)
    await mkdir(paths.dir, { recursive: true })
    await withLock(paths.lock, () =>
      writeFile(path.join(paths.dir, "telemetry.json"), JSON.stringify({ port: this.actualPort })),
    )
  }

  async stop(): Promise<void> {
    this.closing = true
    for (const timer of Object.values(this.flushTimer)) if (timer) clearTimeout(timer)
    for (const entry of this.sockets) entry.socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
  }

  private bearerOk(header: string | undefined): boolean {
    if (!header?.startsWith("Bearer ")) return false
    const presented = Buffer.from(header.slice("Bearer ".length))
    const expected = Buffer.from(this.options.token)
    return presented.length === expected.length && timingSafeEqual(presented, expected)
  }

  private hostOk(header: string | undefined): boolean {
    if (!header) return false
    const match = /^(127\.0\.0\.1|localhost):(\d+)$/.exec(header.trim())
    return match !== null && Number(match[2]) === this.actualPort
  }

  private handleHttp(socket: Socket): void {
    let buffer = Buffer.alloc(0)
    let routed = false
    socket.on("data", (chunk: Buffer) => {
      if (routed) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 2_000_000) {
        socket.destroy()
        return
      }
      const head = buffer.indexOf("\r\n\r\n")
      if (head === -1) return
      const header = buffer.subarray(0, head).toString("latin1")
      const length = contentLengthOf(header)
      if (length > 1_000_000) {
        socket.destroy()
        return
      }
      // The body can trail the headers across packets: wait for all of it.
      if (buffer.length < head + 4 + length) return
      routed = true
      const rest = buffer.subarray(head + 4, head + 4 + length)
      void this.route(socket, header, rest)
    })
    socket.on("error", () => undefined)
  }

  private async route(socket: Socket, header: string, rest: Buffer): Promise<void> {
    const [requestLine, ...headerLines] = header.split("\r\n")
    const [method, target] = (requestLine ?? "").split(" ")
    const headers = parseHeaders(headerLines)
    const res = {
      writeHead: (code: number, responseHeaders: Record<string, string | number>) => {
        const lines = [
          `HTTP/1.1 ${code} ${code === 200 ? "OK" : code === 401 ? "Unauthorized" : code === 403 ? "Forbidden" : code === 101 ? "Switching Protocols" : "Error"}`,
        ]
        for (const [name, value] of Object.entries(responseHeaders)) lines.push(`${name}: ${value}`)
        socket.write(`${lines.join("\r\n")}\r\n\r\n`)
      },
      end: (body?: string) => {
        if (body) socket.write(body)
        socket.end()
      },
    }
    // Upgrade first: it carries its own auth below.
    if ((field(headers, "upgrade") ?? "").toLowerCase() === "websocket" && target === "/fleet/ws")
      return this.handleUpgrade(socket, headers, res)
    if (!this.hostOk(field(headers, "host"))) {
      res.writeHead(403, { "content-length": 0, connection: "close" })
      res.end()
      return
    }
    if (target !== "/fleet/rpc" || method !== "POST") {
      if (method === "GET" && !(target ?? "").startsWith("/fleet/")) return this.serveWeb(target ?? "/", headers, res)
      // Browser approvals (#131, ADR 0002 option b): preview is a read
      // (bearer or session), submit is browser-only (cookie + Origin + CSRF).
      if (method === "POST" && target === "/fleet/approve/preview") return this.approvePreview(headers, rest, res)
      if (method === "POST" && target === "/fleet/approve") return this.approveSubmit(headers, rest, res)
      res.writeHead(404, { "content-length": 0, connection: "close" })
      res.end()
      return
    }
    if (!this.bearerOk(field(headers, "authorization")) && !this.sessionRpcOk(headers)) {
      // A presented session cookie that cannot authorize is a forbidden
      // CSRF/origin failure (403); wholly missing credentials are 401.
      const code = parseSessionCookie(field(headers, "cookie")) !== undefined ? 403 : 401
      res.writeHead(code, { "content-length": 0, connection: "close" })
      res.end()
      return
    }
    const length = Number(field(headers, "content-length") ?? "0")
    if (!(length >= 0) || length > 1_000_000) {
      jsonBody(res, 200, { error: { code: -32700, message: "parse error" } })
      return
    }
    // The body may already be buffered (fetch sends it with the headers).
    const body = rest.subarray(0, length).toString("utf8")
    let call: unknown
    try {
      call = JSON.parse(body)
    } catch {
      jsonBody(res, 200, { error: { code: -32700, message: "parse error" } })
      return
    }
    const parsed = z.object({ method: z.string(), params: z.unknown() }).safeParse(call)
    if (!parsed.success || !(parsed.data.method in RpcSchemas)) {
      jsonBody(res, 200, { error: { code: -32601, message: "unknown method" } })
      return
    }
    const schema = RpcSchemas[parsed.data.method as RpcMethod]
    const params = schema.safeParse(parsed.data.params)
    if (!params.success) {
      jsonBody(res, 200, { error: { code: -32602, message: "invalid params" } })
      return
    }
    try {
      const result = await this.dispatch(parsed.data.method as RpcMethod, params.data as never)
      jsonBody(res, 200, { result: scrubPayload(result, this.secrets()) })
    } catch (error) {
      jsonBody(res, 200, { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  /**
   * Cookie authentication for read-only RPC (#129): the browser session may
   * call the bus only when it also presents a loopback Origin. Bearer calls
   * (CLI, watch, scripts) are unaffected. Fail-closed: no Origin, no cookie
   * access — browsers always send Origin on a POST fetch.
   */
  private sessionRpcOk(headers: Map<string, string>): boolean {
    return (
      loopbackOriginOk(field(headers, "origin")) && this.sessions.valid(parseSessionCookie(field(headers, "cookie")))
    )
  }

  /**
   * The web UI (#129): `GET /?t=<ticket>` redeems a single-use ticket for a
   * session cookie and the entry page; later loads present the cookie.
   * Anonymous loads are 401, bad tickets 403, everything carries the strict
   * security headers. Without a configured `webRoot` every load 404s.
   */
  private async serveWeb(target: string, headers: Map<string, string>, res: HttpResponder): Promise<void> {
    const deny = (code: 401 | 403): void => {
      res.writeHead(code, { ...WEB_SECURITY_HEADERS, "content-length": 0, connection: "close" })
      res.end()
    }
    if (this.options.webRoot === undefined) {
      res.writeHead(404, { "content-length": 0, connection: "close" })
      res.end()
      return
    }
    if (!this.originOk(field(headers, "origin"))) {
      deny(403)
      return
    }
    const query = target.split("?", 2)[1] ?? ""
    const ticket = query
      .split("&")
      .map((part) => part.split("=", 2) as [string, string?])
      .find(([name]) => name === "t")?.[1]
    if (ticket !== undefined) {
      const ok = await redeemWebTicket(this.options.stateRoot, ticket)
      if (!ok) {
        deny(403)
        return
      }
      const session = this.sessions.create()
      await this.sendWebFile(res, this.options.webRoot, "/", {
        "set-cookie": sessionSetCookie(session),
      })
      return
    }
    if (!this.sessions.valid(parseSessionCookie(field(headers, "cookie")))) {
      deny(401)
      return
    }
    await this.sendWebFile(res, this.options.webRoot, target)
  }

  private async sendWebFile(
    res: HttpResponder,
    webRoot: string,
    target: string,
    extra: Record<string, string> = {},
  ): Promise<void> {
    const found = await resolveWebFile(webRoot, target)
    if (!found) {
      res.writeHead(404, { ...WEB_SECURITY_HEADERS, "content-length": 0, connection: "close" })
      res.end()
      return
    }
    let body: string
    try {
      body = await readFile(found.file, "utf8")
    } catch {
      res.writeHead(404, { ...WEB_SECURITY_HEADERS, "content-length": 0, connection: "close" })
      res.end()
      return
    }
    res.writeHead(200, {
      ...WEB_SECURITY_HEADERS,
      ...extra,
      "content-type": found.contentType,
      "content-length": Buffer.byteLength(body),
      connection: "close",
    })
    res.end(body)
  }

  /**
   * Browser approval preview (#131, ADR 0002 I3/I6): a read — bearer or
   * session — returning the subject, its hash and a single-use ticket.
   */
  private async approvePreview(headers: Map<string, string>, rest: Buffer, res: HttpResponder): Promise<void> {
    if (!this.bearerOk(field(headers, "authorization")) && !this.sessionRpcOk(headers)) {
      // Same convention as read-only RPC: a presented session cookie that
      // cannot authorize is a forbidden CSRF/origin failure (403).
      const code = parseSessionCookie(field(headers, "cookie")) !== undefined ? 403 : 401
      res.writeHead(code, { "content-length": 0, connection: "close" })
      res.end()
      return
    }
    let body: unknown
    try {
      body = this.readBody(headers, rest)
    } catch {
      this.fail(res, 400, "parse error")
      return
    }
    const parsed = z
      .object({ runId: z.string().min(1), stage: z.enum(["frontier", "spec"]) })
      .strict()
      .safeParse(body)
    if (!parsed.success) {
      this.fail(res, 400, "want {runId, stage: frontier|spec}")
      return
    }
    const record = (await loadRegistry(this.options.stateRoot))?.worktrees[parsed.data.runId]
    if (record?.status !== "allocated") {
      this.fail(res, 404, `unknown run ${JSON.stringify(parsed.data.runId)}`)
      return
    }
    let subject: { subject: Array<{ path: string; sha256: string }>; summary: string[]; spendCeilingUSD?: number }
    try {
      subject = await approvalSubject(record.dir, parsed.data.stage)
    } catch (error) {
      this.fail(res, 400, error instanceof Error ? error.message : String(error))
      return
    }
    const pending = (await pendingApprovals(record.dir)).some((item) => item.stage === parsed.data.stage)
    const subjectHash = hashJson(subject.subject)
    const ticket = this.approveTickets.issue({ repoDir: record.dir, stage: parsed.data.stage, subjectHash })
    const session = parseSessionCookie(field(headers, "cookie"))
    const csrf = session && this.sessions.valid(session) ? this.csrf.forSession(session) : ""
    this.ok(res, {
      ticket,
      csrf,
      subjectHash,
      summary: subject.summary,
      files: subject.subject,
      ...(subject.spendCeilingUSD !== undefined ? { spendCeilingUSD: subject.spendCeilingUSD } : {}),
      pending,
    })
  }

  /**
   * Browser approval submit (#131, ADR 0002 option b): browser-only by
   * construction — session cookie, loopback Origin and session CSRF are
   * all required before the ticket is even looked at. The passphrase
   * unlocks the sealed key in-process; the signer is destroyed in a
   * finally, and the passphrase is never stored, logged or returned.
   */
  private async approveSubmit(headers: Map<string, string>, rest: Buffer, res: HttpResponder): Promise<void> {
    const session = parseSessionCookie(field(headers, "cookie")) ?? ""
    if (!this.sessions.valid(session)) {
      res.writeHead(401, { "content-length": 0, connection: "close" })
      res.end()
      return
    }
    if (!loopbackOriginOk(field(headers, "origin")) || !this.csrf.check(session, field(headers, "x-csrf"))) {
      res.writeHead(403, { "content-length": 0, connection: "close" })
      res.end()
      return
    }
    let body: unknown
    try {
      body = this.readBody(headers, rest)
    } catch {
      this.fail(res, 400, "parse error")
      return
    }
    const parsed = z
      .object({ ticket: z.string().min(1), passphrase: z.string().min(1).max(4096) })
      .strict()
      .safeParse(body)
    if (!parsed.success) {
      this.fail(res, 400, "want {ticket, passphrase}")
      return
    }
    const webDir = path.join(fleetPaths(this.options.stateRoot).dir, "web-approvals")
    await mkdir(webDir, { recursive: true })
    const attempts = await checkApprovalAttempts(webDir)
    if (!attempts.allowed) {
      this.fail(res, 423, "too many wrong passphrases", { retryAfterSec: attempts.retryAfterSec })
      return
    }
    const entry = this.approveTickets.redeem(parsed.data.ticket)
    if (!entry) {
      this.fail(res, 403, "unknown or expired ticket; preview again")
      return
    }
    let subject: { subject: Array<{ path: string; sha256: string }> }
    try {
      subject = await approvalSubject(entry.repoDir, entry.stage)
    } catch (error) {
      this.fail(res, 409, error instanceof Error ? error.message : String(error))
      return
    }
    if (hashJson(subject.subject) !== entry.subjectHash) {
      this.fail(res, 409, "the preview is stale: the artifacts changed since the preview; preview again")
      return
    }
    const { ticket: _ticket, passphrase } = parsed.data
    void _ticket
    let signer: Awaited<ReturnType<typeof unlockHumanKey>>
    try {
      signer = await unlockHumanKey(passphrase, this.options.stateRoot)
    } catch {
      const check = await noteWrongPassphrase({
        dir: webDir,
        root: entry.repoDir,
        stage: entry.stage,
        channel: "web",
      })
      if (check.allowed) this.fail(res, 403, "wrong passphrase", { remaining: check.remaining })
      else this.fail(res, 423, "too many wrong passphrases", { retryAfterSec: check.retryAfterSec })
      return
    }
    try {
      const result = await approveStage(entry.repoDir, {
        stage: entry.stage,
        channel: "web",
        signer,
        stateDir: this.options.stateRoot,
        expectedSubjectHash: entry.subjectHash,
      })
      await noteApprovalSuccess(webDir)
      this.ok(res, {
        ok: true,
        stage: entry.stage,
        alreadyApproved: result.alreadyApproved,
        factoryStage: result.factoryStage ?? null,
      })
    } catch (error) {
      this.fail(res, 500, error instanceof Error ? error.message : String(error))
    } finally {
      signer.destroy()
    }
  }

  private readBody(headers: Map<string, string>, rest: Buffer): unknown {
    const length = Number(field(headers, "content-length") ?? "0")
    if (!Number.isInteger(length) || length < 0 || length > 1_000_000) throw new Error("bad length")
    return JSON.parse(rest.subarray(0, length).toString("utf8"))
  }

  private ok(res: HttpResponder, value: unknown): void {
    const text = JSON.stringify(value)
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
    res.end(text)
  }

  private fail(res: HttpResponder, code: number, message: string, extra: Record<string, unknown> = {}): void {
    const text = JSON.stringify({ error: message, ...extra })
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
    res.end(text)
  }

  /** Worktree dir for a run id, or a throw the bus reports as unknown-run. */
  private async runDir(runId: string): Promise<string> {
    const record = (await loadRegistry(this.options.stateRoot))?.worktrees[runId]
    if (record?.status !== "allocated") throw new Error(`unknown run ${JSON.stringify(runId)}`)
    return record.dir
  }

  private async dispatch(method: RpcMethod, params: never): Promise<unknown> {
    const snapshot = await this.options.getSnapshot()
    switch (method) {
      case "fleet.status":
        return snapshot
      case "fleet.pending":
        return { pending: snapshot.pending }
      case "fleet.task": {
        const id = (params as { id: string }).id
        const task = snapshot.tasks.find((entry) => entry.id === id)
        if (!task) throw new Error(`unknown task ${JSON.stringify(id)}`)
        return { task }
      }
      case "fleet.task.liveness": {
        const id = (params as { id: string }).id
        return readTaskLiveness(await this.runDir(id), id)
      }
      case "fleet.events": {
        const since = (params as { since?: number }).since ?? 0
        return { events: this.events.filter((event) => event.seq > since), now: this.events.at(-1)?.seq ?? 0 }
      }
      case "fleet.config.get": {
        if (!this.options.configRoot) throw new Error("no repo is configured for the config preview")
        return readConfigView(this.options.configRoot)
      }
      case "fleet.config.plan": {
        if (!this.options.configRoot) throw new Error("no repo is configured for the config preview")
        const input = params as { file: "config" | "gates"; content: unknown }
        return planConfigFile(this.options.configRoot, { file: input.file, content: input.content })
      }
      case "evidence.claims": {
        const dir = await this.runDir((params as { runId: string }).runId)
        const filter = (params as { filter?: Record<string, string> }).filter ?? {}
        return readEvidenceClaims(dir, {
          ...(filter.tag ? { tag: filter.tag } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.tier ? { tier: filter.tier } : {}),
          ...(filter.text ? { text: filter.text } : {}),
        })
      }
      case "evidence.claim": {
        const dir = await this.runDir((params as { runId: string }).runId)
        const detail = await readEvidenceClaim(dir, (params as { id: string }).id)
        if (!detail) throw new Error(`unknown claim ${JSON.stringify((params as { id: string }).id)}`)
        return detail
      }
      case "evidence.source": {
        const dir = await this.runDir((params as { runId: string }).runId)
        const seen = await readEvidenceSource(dir, this.options.stateRoot, (params as { sha: string }).sha)
        if (!seen) throw new Error("unknown or tampered source")
        return seen
      }
      case "evidence.export": {
        const dir = await this.runDir((params as { runId: string }).runId)
        const format = (params as { format: "markdown" | "html" }).format
        const rendered = await exportEvidence(dir, this.options.stateRoot, format)
        if (!rendered) throw new Error("nothing to export yet (no dossier or report)")
        return rendered
      }
    }
  }

  private handleUpgrade(socket: Socket, headers: Map<string, string>, res: HttpResponder): void {
    const cookieOk =
      loopbackOriginOk(field(headers, "origin")) && this.sessions.valid(parseSessionCookie(field(headers, "cookie")))
    if (
      !this.hostOk(field(headers, "host")) ||
      !this.originOk(field(headers, "origin")) ||
      (!this.bearerOk(field(headers, "authorization")) && !cookieOk)
    ) {
      const code = !this.hostOk(field(headers, "host")) || !this.originOk(field(headers, "origin")) ? 403 : 401
      res.writeHead(code, { "content-length": 0, connection: "close" })
      res.end()
      return
    }
    const key = field(headers, "sec-websocket-key") ?? ""
    // SHA-1 is mandated here by RFC 6455 §1.3 (the WebSocket accept hash);
    // it authenticates nothing and protects no secret — the bus token check
    // already ran before the upgrade.
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64") // NOSONAR (typescript:S4790)
    res.writeHead(101, {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Accept": accept,
    })
    const entry = { socket, channels: new Set<BusChannel>(), buffer: Buffer.alloc(0) }
    this.sockets.add(entry)
    socket.on("data", (chunk: Buffer) => this.handleFrame(entry, chunk))
    socket.on("close", () => this.sockets.delete(entry))
    socket.on("error", () => this.sockets.delete(entry))
  }

  private originOk(origin: string | undefined): boolean {
    if (!origin) return true
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin.trim())
  }

  private handleFrame(entry: { socket: Socket; channels: Set<BusChannel>; buffer: Buffer }, chunk: Buffer): void {
    entry.buffer = Buffer.concat([entry.buffer, chunk])
    for (;;) {
      if (entry.buffer.length < 2) return
      const first = entry.buffer[0]!
      const second = entry.buffer[1]!
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (entry.buffer.length < 4) return
        length = entry.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (entry.buffer.length < 10) return
        length = Number(entry.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskSize = masked ? 4 : 0
      if (entry.buffer.length < offset + maskSize + length) return
      let body = entry.buffer.subarray(offset + maskSize, offset + maskSize + length)
      if (masked) {
        const mask = entry.buffer.subarray(offset, offset + 4)
        const out = Buffer.alloc(length)
        for (let i = 0; i < length; i++) out[i] = body[i]! ^ mask[i % 4]!
        body = out
      }
      entry.buffer = entry.buffer.subarray(offset + maskSize + length)
      if (opcode === 0x8) {
        entry.socket.end()
        this.sockets.delete(entry)
        return
      }
      if (opcode === 0x9) {
        this.sendFrame(entry.socket, 0xa, body)
        continue
      }
      if (opcode !== 0x1) continue
      try {
        const message = JSON.parse(body.toString("utf8")) as { subscribe?: unknown; since?: unknown }
        const channels = Array.isArray(message.subscribe)
          ? message.subscribe.filter((name): name is BusChannel => name === "changed" || name === "liveness")
          : []
        for (const channel of channels) entry.channels.add(channel)
        const since = typeof message.since === "number" ? message.since : 0
        for (const event of this.events.filter(
          (candidate) => candidate.seq > since && entry.channels.has(candidate.type),
        ))
          this.sendFrame(entry.socket, 0x1, Buffer.from(JSON.stringify(scrubPayload(event, this.secrets()))))
      } catch {
        // Malformed subscribe: ignore, keep the socket.
      }
    }
  }

  private sendFrame(socket: Socket, opcode: number, body: Buffer): void {
    if (this.closing || socket.destroyed) return
    if (socket.writableLength > 1024 * 1024) return
    const head =
      body.length < 126
        ? Buffer.from([0x80 | opcode, body.length])
        : body.length < 65536
          ? Buffer.from([0x80 | opcode, 126, (body.length >> 8) & 0xff, body.length & 0xff])
          : (() => {
              const extended = Buffer.alloc(10)
              extended[0] = 0x80 | opcode
              extended[1] = 127
              extended.writeBigUInt64BE(BigInt(body.length), 2)
              return extended
            })()
    socket.write(Buffer.concat([head, body]))
  }

  /** Stage one event for coalesced broadcast (notifySoon: at most one emit per channel per second). */
  private stage(event: BusEvent): void {
    const channel = event.type
    // Drop to the latest per key (taskId): a burst for one task emits once.
    const key = typeof event.payload.taskId === "string" ? event.payload.taskId : ""
    this.pending[channel].set(key, event)
    const now = Date.now()
    if (now - this.lastFlush[channel] >= 1000) {
      this.flush(channel)
      return
    }
    if (this.flushTimer[channel] !== undefined) return
    this.flushTimer[channel] = setTimeout(
      () => {
        this.flushTimer[channel] = undefined
        this.flush(channel)
      },
      Math.max(0, 1000 - (now - this.lastFlush[channel])),
    )
  }

  private flush(channel: BusChannel): void {
    this.lastFlush[channel] = Date.now()
    const latest = [...this.pending[channel].values()]
    this.pending[channel].clear()
    for (const entry of this.sockets) {
      if (!entry.channels.has(channel)) continue
      for (const event of latest)
        this.sendFrame(entry.socket, 0x1, Buffer.from(JSON.stringify(scrubPayload(event, this.secrets()))))
    }
  }
}

/** Ports and tokens `es-fleet watch` reads to find a running daemon. */
export async function readTelemetryEndpoint(stateRoot: string): Promise<{ port: number; token: string } | undefined> {
  try {
    const paths = fleetPaths(stateRoot)
    const [endpoint, token] = await Promise.all([
      readFile(path.join(paths.dir, "telemetry.json"), "utf8"),
      readFile(paths.token, "utf8"),
    ])
    const port = (JSON.parse(endpoint) as { port?: unknown }).port
    if (typeof port !== "number" || port <= 0) return undefined
    return { port, token: token.trim() }
  } catch {
    return undefined
  }
}
