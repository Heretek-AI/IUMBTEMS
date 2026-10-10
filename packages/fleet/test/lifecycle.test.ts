// Daemon lifecycle (#122): start/stop/status under a lock in the state dir.
// Starting or stopping from an agent sandbox is refused.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FleetError, fleetStatus, startFleet, stopFleet } from "../src/lifecycle.ts"
import { fleetPaths } from "../src/state.ts"

const tempRoot = () => mkdtemp(path.join(tmpdir(), "es-fleet-life-"))
const humanEnv = { ...process.env, ES_SANDBOX: undefined } as NodeJS.ProcessEnv
delete humanEnv.ES_SANDBOX

describe("daemon lifecycle", () => {
  test("start then status reports running; stop reports stopped", async () => {
    const root = await tempRoot()
    try {
      const handle = await startFleet({ stateRoot: root, maxUsd: 10, env: humanEnv })
      try {
        const status = await fleetStatus(root)
        expect(status.running).toBe(true)
        expect(status.pid).toBe(process.pid)
        expect(status.maxUsd).toBe(10)
      } finally {
        await handle.close()
      }
      expect((await fleetStatus(root)).running).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a double start is refused by the lock while the owner is live", async () => {
    const root = await tempRoot()
    try {
      const handle = await startFleet({ stateRoot: root, maxUsd: 10, env: humanEnv })
      try {
        await expect(startFleet({ stateRoot: root, maxUsd: 10, env: humanEnv })).rejects.toBeInstanceOf(FleetError)
      } finally {
        await handle.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a stale pidfile is recovered", async () => {
    const root = await tempRoot()
    try {
      const paths = fleetPaths(root)
      const { mkdir } = await import("node:fs/promises")
      await mkdir(paths.dir, { recursive: true })
      // A pid that is certainly dead (2^30) with no lock held.
      await writeFile(paths.pid, JSON.stringify({ pid: 1073741824, startedAt: new Date(0).toISOString() }))
      const handle = await startFleet({ stateRoot: root, maxUsd: 5, env: humanEnv })
      try {
        expect((await fleetStatus(root)).pid).toBe(process.pid)
      } finally {
        await handle.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("start refuses inside an agent sandbox", async () => {
    const root = await tempRoot()
    try {
      await expect(
        startFleet({ stateRoot: root, maxUsd: 10, env: { ...process.env, ES_SANDBOX: "seat" } }),
      ).rejects.toBeInstanceOf(FleetError)
      expect((await fleetStatus(root)).running).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("start requires a positive spend ceiling", async () => {
    const root = await tempRoot()
    try {
      await expect(startFleet({ stateRoot: root, maxUsd: 0, env: humanEnv })).rejects.toBeInstanceOf(FleetError)
      await expect(startFleet({ stateRoot: root, maxUsd: -3, env: humanEnv })).rejects.toBeInstanceOf(FleetError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("stopFleet on a stopped fleet reports stopped:false, never throws", async () => {
    const root = await tempRoot()
    try {
      expect(await stopFleet(root)).toEqual({ stopped: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
