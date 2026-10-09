// Inode-bound unix-socket ownership (#122): a second live owner is refused,
// a stale socket file is reclaimed.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { acquireSocket, SocketBusyError } from "../src/socket-guard.ts"

const tempRoot = () => mkdtemp(path.join(tmpdir(), "es-fleet-sock-"))

describe("socket guard", () => {
  test("acquire then verifyOwner passes for the live owner", async () => {
    const root = await tempRoot()
    try {
      const guard = await acquireSocket(path.join(root, "fleet.sock"))
      try {
        expect(await guard.verifyOwner()).toBe(true)
      } finally {
        await guard.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a second acquire while the owner is live is refused", async () => {
    const root = await tempRoot()
    try {
      const sock = path.join(root, "fleet.sock")
      const guard = await acquireSocket(sock)
      try {
        await expect(acquireSocket(sock)).rejects.toBeInstanceOf(SocketBusyError)
      } finally {
        await guard.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a stale socket file (no listener) is reclaimed", async () => {
    const root = await tempRoot()
    try {
      const sock = path.join(root, "fleet.sock")
      const first = await acquireSocket(sock)
      await first.close()
      // The listener is gone but nothing cleaned the file: simulate a crash
      // by rebinding over an unlinked... here close() unlinks, so plant a
      // dead regular file instead.
      await writeFile(sock, "dead")
      const second = await acquireSocket(sock)
      try {
        expect(await second.verifyOwner()).toBe(true)
      } finally {
        await second.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("verifyOwner fails after the path is replaced", async () => {
    const root = await tempRoot()
    try {
      const sock = path.join(root, "fleet.sock")
      const guard = await acquireSocket(sock)
      try {
        await guard.close()
        await writeFile(sock, "impostor")
        expect(await guard.verifyOwner()).toBe(false)
      } finally {
        await guard.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
