// S5.2 (#122) start grant + S5.5 (#126) `status --token` (repair-151).
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readStatusToken, startDecision } from "../src/bin.ts"

describe("startDecision (S5.2)", () => {
  test("a plain non-TTY start without a grant is refused", () => {
    expect(startDecision({ isTTY: false, foreground: false, grant: false, confirm: false })).toMatchObject({
      action: "refuse",
    })
  })

  test("a granted child without a TTY runs", () => {
    expect(startDecision({ isTTY: false, foreground: true, grant: true, confirm: false })).toMatchObject({
      action: "run",
    })
  })

  test("TTY + confirmation daemonizes in the background", () => {
    expect(startDecision({ isTTY: true, foreground: false, grant: false, confirm: true })).toMatchObject({
      action: "daemonize",
    })
  })

  test("TTY without confirmation declines, background or foreground", () => {
    for (const foreground of [false, true])
      expect(startDecision({ isTTY: true, foreground, grant: false, confirm: false })).toMatchObject({
        action: "declined",
      })
  })

  test("TTY + foreground + confirmation runs in this process", () => {
    expect(startDecision({ isTTY: true, foreground: true, grant: false, confirm: true })).toMatchObject({
      action: "run",
    })
  })

  test("no env var or flag grants a start: grant comes only from the matrix input", () => {
    // A caller that smuggles ES_FLEET_GRANT=1 in the environment still gets
    // no grant unless the IPC handshake said so (grant: false here).
    process.env.ES_FLEET_GRANT = "1"
    try {
      expect(startDecision({ isTTY: false, foreground: true, grant: false, confirm: false })).toMatchObject({
        action: "refuse",
      })
    } finally {
      delete process.env.ES_FLEET_GRANT
    }
  })
})

describe("status --token (S5.5)", () => {
  test("it refuses without a TTY", async () => {
    await expect(readStatusToken("/nonexistent", { isTTY: false })).rejects.toThrow(/interactive terminal/)
  })

  test("it prints the token with a TTY", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "es-fleet-token-"))
    try {
      const { fleetPaths } = await import("../src/state.ts")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(fleetPaths(state).dir, { recursive: true })
      await writeFile(fleetPaths(state).token, `${"t".repeat(40)}\n`, { mode: 0o600 })
      await expect(readStatusToken(state, { isTTY: true })).resolves.toBe("t".repeat(40))
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})

describe("start grant integration (S5.2)", () => {
  test("a child without the grant exits non-zero", async () => {
    const helper = new URL("./fixtures/no-grant-child.ts", import.meta.url).pathname
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [helper], { stdio: ["ignore", "pipe", "pipe"] })
      let stderr = ""
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on("error", reject)
      child.on("exit", (exitCode) => {
        try {
          expect(exitCode).not.toBe(0)
          expect(stderr).toMatch(/grant|terminal/i)
        } catch (error) {
          reject(error)
          return
        }
        resolve(exitCode ?? 1)
      })
    })
    expect(code).not.toBe(0)
  })
})
