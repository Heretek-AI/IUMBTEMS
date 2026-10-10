// Fleet state helpers (#122): paths under the masked state dir, validated
// schemas, and locked persistence.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fleetPaths, readFleetState, writeFleetState } from "../src/state.ts"

const tempRoot = () => mkdtemp(path.join(tmpdir(), "es-fleet-state-"))

describe("fleet paths", () => {
  test("fleet state lives under <stateRoot>/fleet", () => {
    const paths = fleetPaths("/state")
    expect(paths.dir).toBe(path.join("/state", "fleet"))
    for (const file of [paths.pid, paths.lock, paths.state, paths.socket, paths.token])
      expect(file.startsWith(`${paths.dir}${path.sep}`)).toBe(true)
  })
})

describe("fleet state persistence", () => {
  test("a missing state file reads as undefined", async () => {
    const root = await tempRoot()
    try {
      expect(await readFleetState(root)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("write then read round-trips under the lock", async () => {
    const root = await tempRoot()
    try {
      await writeFleetState(root, {
        v: 1,
        running: true,
        pid: 1234,
        startedAt: "2026-10-09T00:00:00.000Z",
        maxUsd: 25,
        concurrency: 3,
      })
      expect(await readFleetState(root)).toEqual({
        v: 1,
        running: true,
        pid: 1234,
        startedAt: "2026-10-09T00:00:00.000Z",
        maxUsd: 25,
        concurrency: 3,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a corrupt state file reads as undefined, never throws", async () => {
    const root = await tempRoot()
    try {
      const { mkdir, writeFile } = await import("node:fs/promises")
      await mkdir(fleetPaths(root).dir, { recursive: true })
      await writeFile(fleetPaths(root).state, "{not json")
      expect(await readFleetState(root)).toBeUndefined()
      // Wrong version or shape is also rejected, not trusted.
      await writeFile(fleetPaths(root).state, JSON.stringify({ v: 999, running: true }))
      expect(await readFleetState(root)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
