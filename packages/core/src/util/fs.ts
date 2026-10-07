// Filesystem primitives: atomic writes, JSON helpers, and an advisory
// directory lock that survives crashed holders (Linux only, per the 1.0 scope).
import { randomBytes } from "node:crypto"
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** Write via a sibling temp file, fsync, and rename, so readers never see a torn file. */
export async function atomicWrite(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  const handle = await open(temp, "w", mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function readJson<T = unknown>(file: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
  return JSON.parse(text) as T
}

export const writeJson = (file: string, value: unknown) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8")
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

/**
 * Read an untrusted regular file: never through a symlink (lstat first, then
 * the opened descriptor must be the same inode) and under `maxBytes`.
 * Undefined when missing, not regular, or too large.
 */
export async function readRegularFile(file: string, maxBytes = 2_000_000): Promise<string | undefined> {
  const link = await lstat(file).catch(() => undefined)
  if (!link?.isFile()) return undefined
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes || info.ino !== link.ino) return undefined
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

export async function appendLine(file: string, line: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const handle = await open(file, "a")
  try {
    await handle.writeFile(`${line}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export interface LockOptions {
  /** Give up after this many milliseconds. */
  readonly timeoutMs?: number
  /** A lock older than this whose holder is gone is reclaimed. */
  readonly staleMs?: number
}

/**
 * Exclusive advisory lock at `${target}.lock` (a directory, created atomically by mkdir).
 * The owner file records pid and host so a dead holder's lock can be reclaimed.
 */
export async function withLock<T>(target: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lock = `${target}.lock`
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  const staleMs = options.staleMs ?? 30_000
  await mkdir(path.dirname(lock), { recursive: true })
  for (;;) {
    try {
      await mkdir(lock)
      await writeFile(path.join(lock, "owner"), JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }))
      break
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error
      if (await isStale(lock, staleMs)) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lock}`)
      await sleep(25)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function isStale(lock: string, staleMs: number): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path.join(lock, "owner"), "utf8")) as {
      pid: number
      host: string
      at: number
    }
    if (owner.host === hostname() && !processAlive(owner.pid)) return true
    return Date.now() - owner.at > staleMs
  } catch {
    // Owner file not written yet (holder mid-acquire) or unreadable: stale only by age.
    try {
      return Date.now() - (await stat(lock)).mtimeMs > staleMs
    } catch {
      return false
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === "EPERM"
  }
}

/** Resolve `child` inside `root`, refusing paths that escape it. */
export function insideRoot(root: string, child: string): string {
  const resolved = path.resolve(root, child)
  const relative = path.relative(root, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes ${root}: ${child}`)
  return resolved
}

/** POSIX-style path relative to root, or undefined when outside it. */
export function relativeInside(root: string, file: string): string | undefined {
  const relative = path.relative(root, path.resolve(root, file))
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    return relative === "" ? "." : undefined
  return relative.split(path.sep).join("/")
}
