// Inode-bound unix-socket ownership (#122, clean-room): the guard records the
// inode it bound, so a later `verifyOwner` fails when the path was replaced.
// A socket file with no listener is stale (crashed owner) and reclaimed;
// a socket with a live listener refuses a second owner.

import { lstat, rm, stat } from "node:fs/promises"
import { createServer, type Server, Socket } from "node:net"

export class SocketBusyError extends Error {
  constructor(sockPath: string) {
    super(`Another fleet daemon owns ${sockPath}; refusing a second owner.`)
    this.name = "SocketBusyError"
  }
}

export interface SocketGuard {
  readonly path: string
  /** True while the path still resolves to the inode this guard bound. */
  verifyOwner(): Promise<boolean>
  close(): Promise<void>
}

const connectable = (sockPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = new Socket()
    probe.once("connect", () => {
      probe.destroy()
      resolve(true)
    })
    probe.once("error", () => {
      probe.destroy()
      resolve(false)
    })
    probe.connect(sockPath)
  })

async function unlinkQuietly(sockPath: string): Promise<void> {
  await rm(sockPath, { force: true })
}

/** Bind `sockPath` exclusively and return its ownership guard. */
export async function acquireSocket(sockPath: string): Promise<SocketGuard> {
  const known = await lstat(sockPath).catch(() => undefined)
  if (known !== undefined) {
    if (await connectable(sockPath)) throw new SocketBusyError(sockPath)
    // Present but nobody listens: a crashed owner's leftover. Reclaim it.
    await unlinkQuietly(sockPath)
  }
  const server: Server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(sockPath, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
  } catch (error: any) {
    // Lost a race with another binder: whoever listens now owns it.
    if (error?.code === "EADDRINUSE" && (await connectable(sockPath))) throw new SocketBusyError(sockPath)
    throw error
  }
  // The inode we bound: ownership is pinned to it, not to the path string.
  const bound = await stat(sockPath)
  const identity = { ino: bound.ino, dev: bound.dev }
  let closed = false
  return {
    path: sockPath,
    verifyOwner: async () => {
      if (closed) {
        // After close the file is gone (or replaced): only "gone" verifies.
        const now = await lstat(sockPath).catch(() => undefined)
        return now === undefined
      }
      const now = await stat(sockPath).catch(() => undefined)
      return now !== undefined && now.ino === identity.ino && now.dev === identity.dev
    },
    close: async () => {
      closed = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlinkQuietly(sockPath)
    },
  }
}
