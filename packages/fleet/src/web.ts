// Web control plane serving (#129, clean-room): the fleet daemon serves the
// built UI from the bus port behind a single-use ticket exchange. `es-fleet
// web` (human-only) mints a 32-byte ticket and prints a one-time URL; the
// first load redeems it for an HttpOnly, SameSite=Strict session cookie.
// Tickets live as files under the masked state dir so the printing process
// and the daemon can share them without a new channel; sessions live only
// in the daemon's memory. `Secure` is deliberately absent from the cookie:
// the bus is plain HTTP on loopback, and a Secure cookie would never be
// sent back; the localhost bind plus Host/Origin checks are the transport
// defense instead.
import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fleetDir } from "./state.ts"

/** How long a minted ticket stays redeemable. */
export const WEB_TICKET_TTL_MS = 120_000
/** How long a redeemed session stays valid (absolute, no rolling). */
export const WEB_SESSION_TTL_MS = 12 * 3_600_000
/** Session cookie name. */
export const WEB_SESSION_COOKIE = "es_fleet_web"

/** Strict headers on every web response: no inline scripts, no framing. */
export const WEB_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; " +
    "form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
}

const TICKET_NAME = /^[0-9a-f]{64}$/
const SESSION_ID = /^[0-9a-f]{64}$/

const ticketDir = (stateRoot: string): string => path.join(fleetDir(stateRoot), "web-tickets")

/** Mint a single-use ticket (32 random bytes, hex) valid for WEB_TICKET_TTL_MS. */
export async function mintWebTicket(stateRoot: string): Promise<string> {
  const ticket = randomBytes(32).toString("hex")
  const dir = ticketDir(stateRoot)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, ticket), `${Date.now() + WEB_TICKET_TTL_MS}\n`, { mode: 0o600 })
  // Best-effort sweep of expired litter: never fails the mint.
  try {
    const now = Date.now()
    for (const entry of await readdir(dir)) {
      if (!TICKET_NAME.test(entry) || entry === ticket) continue
      const file = path.join(dir, entry)
      try {
        if (Number((await readFile(file, "utf8")).trim()) <= now) await rm(file, { force: true })
      } catch {
        // Raced with a redeem, or unreadable: leave it for the next sweep.
      }
    }
  } catch {
    // The sweep is hygiene, not correctness.
  }
  return ticket
}

/**
 * Redeem a ticket exactly once: malformed, missing and expired tickets are
 * refused, and the claim is an atomic rename — two concurrent redeems cannot
 * both win. The name is hex-only so no path traversal is possible.
 */
export async function redeemWebTicket(stateRoot: string, ticket: string): Promise<boolean> {
  if (!TICKET_NAME.test(ticket)) return false
  const dir = ticketDir(stateRoot)
  const claimed = path.join(dir, `${ticket}.claimed-${process.pid}-${randomBytes(4).toString("hex")}`)
  try {
    await rename(path.join(dir, ticket), claimed)
  } catch {
    return false
  }
  let raw: string
  try {
    raw = await readFile(claimed, "utf8")
  } catch {
    return false
  } finally {
    await rm(claimed, { force: true })
  }
  return Number(raw.trim()) > Date.now()
}

/** In-memory web sessions: created on ticket redeem, checked per request. */
export class WebSessions {
  private readonly live = new Map<string, number>()

  create(): string {
    this.purge()
    const id = randomBytes(32).toString("hex")
    this.live.set(id, Date.now() + WEB_SESSION_TTL_MS)
    return id
  }

  valid(id: string | undefined): boolean {
    if (id === undefined || !SESSION_ID.test(id)) return false
    const exp = this.live.get(id)
    if (exp === undefined || exp <= Date.now()) {
      this.live.delete(id)
      return false
    }
    return true
  }

  private purge(): void {
    const now = Date.now()
    for (const [id, exp] of this.live) if (exp <= now) this.live.delete(id)
  }
}

/** `Set-Cookie` value for a session: HttpOnly, SameSite=Strict, root path. */
export function sessionSetCookie(id: string): string {
  return `${WEB_SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict`
}

/** Extract the session id from a `Cookie` header, if present. */
export function parseSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined
  for (const part of header.split(";")) {
    const at = part.indexOf("=")
    if (at > 0 && part.slice(0, at).trim() === WEB_SESSION_COOKIE) {
      const value = part.slice(at + 1).trim()
      if (SESSION_ID.test(value)) return value
    }
  }
  return undefined
}

/** Loopback origins only (the UI is served from 127.0.0.1, never the open net). */
export function loopbackOriginOk(origin: string | undefined): boolean {
  return origin !== undefined && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin.trim())
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
}

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
}

export interface WebFile {
  readonly file: string
  readonly contentType: string
}

/**
 * Resolve a request target to a file under `webRoot`, fail-closed: decoded
 * traversal that escapes the root, and anything but a regular file, falls
 * back to `fallback` (the SPA entry) or refuses when even that is missing.
 * Query strings are stripped before resolution.
 */
export async function resolveWebFile(
  webRoot: string,
  target: string,
  fallback = "index.html",
): Promise<WebFile | undefined> {
  const root = path.resolve(webRoot)
  let pathname = target.split("?", 1)[0] ?? "/"
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  const candidate = path.resolve(root, `.${pathname.startsWith("/") ? pathname : `/${pathname}`}`)
  const inside = candidate === root || candidate.startsWith(`${root}${path.sep}`)
  const direct = inside ? await regularFile(candidate) : undefined
  if (direct) return { file: direct, contentType: contentTypeFor(direct) }
  // Refuse escapes outright; ordinary misses fall back to the SPA entry.
  if (!inside) return undefined
  const entry = await regularFile(path.join(root, fallback))
  return entry ? { file: entry, contentType: contentTypeFor(entry) } : undefined
}

async function regularFile(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file)
    if (info.isDirectory()) {
      const index = path.join(file, "index.html")
      const nested = await stat(index)
      return nested.isFile() ? index : undefined
    }
    return info.isFile() ? file : undefined
  } catch {
    return undefined
  }
}
